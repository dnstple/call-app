-- ============================================================================
-- 0090 — Block 2 (Trust & Safety): durable, audited user blocking.
-- ============================================================================
-- A block operates between a Member profile and a Companion profile (the two
-- identities that actually interact), while recording which authenticated
-- account initiated it and, where relevant, the Coordinator authority used.
-- Each DIRECTION is independent: a Member blocking a Companion and a Companion
-- blocking a Member are two separate active rows, so removing one never removes
-- the other (test 22).
--
-- This migration adds only the model, the RPCs, and the authoritative
-- app_private.active_block_between() helper. Enforcement across discovery,
-- booking, messaging, conversation start and call-token issuance is wired in
-- 0092 so the block checks live beside the other Block-2 gates. Purely
-- additive: no historical booking/call/message/payment/earning row is altered.
-- ----------------------------------------------------------------------------

create table if not exists public.user_blocks (
  id uuid primary key default gen_random_uuid(),
  member_profile_id uuid not null references public.profiles(id) on delete cascade,
  companion_profile_id uuid not null references public.profiles(id) on delete cascade,
  direction text not null check (direction in ('member_blocks_companion', 'companion_blocks_member')),
  initiated_by_account_id uuid not null references public.accounts(id),
  coordinator_authority boolean not null default false,
  reason_category text check (reason_category is null or char_length(reason_category) <= 60),
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by_account_id uuid references public.accounts(id)
);
-- Pair-order safe + idempotent: at most ONE active row per (member, companion,
-- direction). Duplicate clicks coalesce to the existing active block.
create unique index if not exists user_blocks_one_active
  on public.user_blocks (member_profile_id, companion_profile_id, direction)
  where removed_at is null;
create index if not exists user_blocks_pair_idx
  on public.user_blocks (member_profile_id, companion_profile_id) where removed_at is null;

alter table public.user_blocks enable row level security;
-- The initiator, and the Member side (owner of the member profile, e.g. to see a
-- Coordinator-initiated block), may read. The blocked counterparty is NOT told.
-- Support reads via SECURITY DEFINER RPC. No client writes.
drop policy if exists "blocks: initiator or member-owner reads" on public.user_blocks;
create policy "blocks: initiator or member-owner reads" on public.user_blocks
  for select to authenticated using (
    initiated_by_account_id = auth.uid()
    or app_private.profile_owner_account(member_profile_id) = auth.uid()
  );

-- ---------- the single blocking authority (either direction, active only) ----------
create or replace function app_private.active_block_between(p_member_profile uuid, p_companion_profile uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_blocks b
    where b.member_profile_id = p_member_profile
      and b.companion_profile_id = p_companion_profile
      and b.removed_at is null
  );
$$;
revoke all on function app_private.active_block_between(uuid, uuid) from public, anon, authenticated;

-- Resolve the caller's authority + direction for a (member, companion) pair.
create or replace function app_private.block_direction_for_caller(p_member_profile uuid, p_companion_profile uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if app_private.profile_owner_account(p_companion_profile) = auth.uid() then
    return jsonb_build_object('direction', 'companion_blocks_member', 'coordinator', false);
  elsif app_private.profile_owner_account(p_member_profile) = auth.uid() then
    return jsonb_build_object('direction', 'member_blocks_companion', 'coordinator', false);
  elsif exists (
      select 1 from public.profile_access pa
      where pa.profile_id = p_member_profile and pa.account_id = auth.uid()
        and pa.access_role = 'coordinator' and pa.consent_status <> 'withdrawn'
    ) then
    return jsonb_build_object('direction', 'member_blocks_companion', 'coordinator', true);
  else
    return null;
  end if;
end;
$$;
revoke all on function app_private.block_direction_for_caller(uuid, uuid) from public, anon, authenticated;

-- ---------- create a block ----------
create or replace function public.create_block(
  p_member_profile uuid, p_companion_profile uuid, p_reason text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_dir jsonb;
  v_existing public.user_blocks;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  -- Validate the two profiles really are a member and a companion.
  if not exists (select 1 from public.profiles where id = p_member_profile and role = 'member')
     or not exists (select 1 from public.profiles where id = p_companion_profile and role = 'companion') then
    raise exception 'invalid_pair: expected a member and a companion';
  end if;

  v_dir := app_private.block_direction_for_caller(p_member_profile, p_companion_profile);
  if v_dir is null then raise exception 'unauthorised: no authority for this pair'; end if;

  -- Idempotent: return the existing active block in this direction if present.
  select * into v_existing from public.user_blocks
   where member_profile_id = p_member_profile and companion_profile_id = p_companion_profile
     and direction = v_dir->>'direction' and removed_at is null;
  if v_existing.id is not null then
    return jsonb_build_object('ok', true, 'already', true, 'block_id', v_existing.id);
  end if;

  insert into public.user_blocks
    (member_profile_id, companion_profile_id, direction, initiated_by_account_id,
     coordinator_authority, reason_category)
  values (p_member_profile, p_companion_profile, v_dir->>'direction', auth.uid(),
          (v_dir->>'coordinator')::boolean,
          nullif(left(coalesce(p_reason, ''), 60), ''))
  on conflict (member_profile_id, companion_profile_id, direction) where removed_at is null
    do nothing
  returning * into v_existing;

  return jsonb_build_object('ok', true, 'already', false, 'block_id', v_existing.id);
end;
$$;
revoke all on function public.create_block(uuid, uuid, text) from public, anon;
grant execute on function public.create_block(uuid, uuid, text) to authenticated;

-- ---------- remove the caller's own-direction block ----------
create or replace function public.remove_block(p_member_profile uuid, p_companion_profile uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dir jsonb; v_row public.user_blocks;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  v_dir := app_private.block_direction_for_caller(p_member_profile, p_companion_profile);
  if v_dir is null then raise exception 'unauthorised: no authority for this pair'; end if;

  -- Remove ONLY the caller's own direction; an independent opposite-side block stays.
  update public.user_blocks
     set removed_at = now(), removed_by_account_id = auth.uid()
   where member_profile_id = p_member_profile and companion_profile_id = p_companion_profile
     and direction = v_dir->>'direction' and removed_at is null
  returning * into v_row;

  if v_row.id is null then return jsonb_build_object('ok', true, 'already', true); end if;
  return jsonb_build_object('ok', true, 'block_id', v_row.id);
end;
$$;
revoke all on function public.remove_block(uuid, uuid) from public, anon;
grant execute on function public.remove_block(uuid, uuid) to authenticated;

-- ---------- support inspection (authorised only) ----------
create or replace function public.support_block_overview(p_member_profile uuid default null, p_companion_profile uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_rows jsonb;
begin
  if not app_private.is_support_admin() then raise exception 'unauthorised: support only'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'block_id', b.id,
           'member_profile_id', b.member_profile_id,
           'companion_profile_id', b.companion_profile_id,
           'direction', b.direction,
           'coordinator_authority', b.coordinator_authority,
           'reason_category', b.reason_category,
           'created_at', b.created_at,
           'removed_at', b.removed_at
         ) order by b.created_at desc), '[]'::jsonb)
    into v_rows
  from public.user_blocks b
  where b.removed_at is null
    and (p_member_profile is null or b.member_profile_id = p_member_profile)
    and (p_companion_profile is null or b.companion_profile_id = p_companion_profile);
  return jsonb_build_object('ok', true, 'blocks', v_rows);
end;
$$;
revoke all on function public.support_block_overview(uuid, uuid) from public, anon;
grant execute on function public.support_block_overview(uuid, uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
