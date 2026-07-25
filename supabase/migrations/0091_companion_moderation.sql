-- ============================================================================
-- 0091 — Block 2 (Trust & Safety): Companion approval / suspension lifecycle.
-- ============================================================================
-- Adds an authoritative moderation status to companion_profiles, distinct from
-- profile completeness and from Stripe Connect / payout readiness. Only an
-- approved Companion is discoverable and may accept new bookings (enforced in
-- 0092). Suspension/rejection cannot be bypassed by editing profile visibility.
-- Every transition is audited. Completed financial history is never touched.
--
-- Safe backfill: existing Companions that are CURRENTLY publicly discoverable
-- (present in the discoverable_companions view — a deterministic, already-public
-- signal) are marked 'approved'; every other existing/ new Companion defaults to
-- 'pending' and requires manual support review. This deliberately does NOT
-- approve incomplete, private or test profiles.
-- ----------------------------------------------------------------------------

alter table public.companion_profiles
  add column if not exists moderation_status text not null default 'pending'
    check (moderation_status in ('pending', 'approved', 'suspended', 'rejected')),
  add column if not exists moderation_reason text,
  add column if not exists moderated_by_account_id uuid references public.accounts(id),
  add column if not exists moderated_at timestamptz;

create table if not exists public.companion_moderation_events (
  id uuid primary key default gen_random_uuid(),
  companion_profile_id uuid not null references public.profiles(id) on delete cascade,
  from_status text,
  to_status text not null,
  reason text,
  actor_account_id uuid references public.accounts(id),
  created_at timestamptz not null default now()
);
create index if not exists companion_moderation_events_profile_idx
  on public.companion_moderation_events (companion_profile_id, created_at desc);
alter table public.companion_moderation_events enable row level security;
-- Audit is support-only (read via definer RPC). No client policy.

-- Deterministic backfill from current public state (runs once; idempotent).
update public.companion_profiles cp
   set moderation_status = 'approved', moderated_at = now()
 where cp.moderation_status = 'pending'
   and exists (select 1 from public.discoverable_companions dc where dc.id = cp.profile_id);

insert into public.companion_moderation_events (companion_profile_id, from_status, to_status, reason)
select cp.profile_id, null, 'approved', 'backfill: already publicly discoverable at 0091'
from public.companion_profiles cp
where cp.moderation_status = 'approved'
  and not exists (select 1 from public.companion_moderation_events e
                  where e.companion_profile_id = cp.profile_id);

-- ---------- authority helpers ----------
create or replace function app_private.companion_is_approved(p_profile uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.companion_profiles cp
    where cp.profile_id = p_profile and cp.moderation_status = 'approved'
  );
$$;
revoke all on function app_private.companion_is_approved(uuid) from public, anon, authenticated;

create or replace function app_private.companion_is_suspended(p_profile uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.companion_profiles cp
    where cp.profile_id = p_profile and cp.moderation_status in ('suspended', 'rejected')
  );
$$;
revoke all on function app_private.companion_is_suspended(uuid) from public, anon, authenticated;

-- ---------- Companion reads own moderation status ----------
create or replace function public.get_my_companion_moderation()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_row public.companion_profiles;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  select cp.* into v_row from public.companion_profiles cp
   where app_private.profile_owner_account(cp.profile_id) = auth.uid()
   limit 1;
  if v_row.profile_id is null then return jsonb_build_object('ok', true, 'has_companion', false); end if;
  return jsonb_build_object('ok', true, 'has_companion', true,
    'profile_id', v_row.profile_id,
    'moderation_status', v_row.moderation_status,
    -- The Companion sees only the status + a neutral reason, never internal notes.
    'reason', case when v_row.moderation_status in ('suspended', 'rejected') then v_row.moderation_reason else null end);
end;
$$;
revoke all on function public.get_my_companion_moderation() from public, anon;
grant execute on function public.get_my_companion_moderation() to authenticated;

-- ---------- support transition (authorised only, audited) ----------
create or replace function public.support_set_companion_moderation(
  p_profile uuid, p_status text, p_reason text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_from text;
begin
  if not app_private.is_support_admin() then raise exception 'unauthorised: support only'; end if;
  if p_status not in ('pending', 'approved', 'suspended', 'rejected') then
    raise exception 'invalid_status';
  end if;
  if p_status in ('suspended', 'rejected') and (p_reason is null or trim(p_reason) = '') then
    raise exception 'reason_required: suspend/reject need a reason';
  end if;

  -- Lock the row so concurrent transitions serialise.
  select moderation_status into v_from from public.companion_profiles
   where profile_id = p_profile for update;
  if v_from is null then raise exception 'not_found: companion'; end if;
  if v_from = p_status then
    return jsonb_build_object('ok', true, 'already', true, 'status', p_status);
  end if;

  update public.companion_profiles
     set moderation_status = p_status,
         moderation_reason = case when p_status in ('suspended', 'rejected') then trim(p_reason)
                                  else null end,
         moderated_by_account_id = auth.uid(),
         moderated_at = now(),
         updated_at = now()
   where profile_id = p_profile;

  insert into public.companion_moderation_events
    (companion_profile_id, from_status, to_status, reason, actor_account_id)
  values (p_profile, v_from, p_status,
          case when p_status in ('suspended', 'rejected') then trim(p_reason) else nullif(trim(coalesce(p_reason,'')),'') end,
          auth.uid());

  return jsonb_build_object('ok', true, 'already', false, 'from', v_from, 'status', p_status);
end;
$$;
revoke all on function public.support_set_companion_moderation(uuid, text, text) from public, anon;
grant execute on function public.support_set_companion_moderation(uuid, text, text) to authenticated;

-- ---------- support moderation queue / detail (authorised only) ----------
create or replace function public.support_companion_moderation_overview(p_status text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_rows jsonb;
begin
  if not app_private.is_support_admin() then raise exception 'unauthorised: support only'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'profile_id', cp.profile_id,
           'first_name', p.first_name,
           'last_initial', left(p.last_name, 1),
           'moderation_status', cp.moderation_status,
           'completion_pct', cp.profile_completion_percentage,
           'moderated_at', cp.moderated_at
         ) order by (cp.moderation_status = 'pending') desc, cp.moderated_at desc nulls first), '[]'::jsonb)
    into v_rows
  from public.companion_profiles cp
  join public.profiles p on p.id = cp.profile_id
  where p_status is null or cp.moderation_status = p_status;
  return jsonb_build_object('ok', true, 'companions', v_rows);
end;
$$;
revoke all on function public.support_companion_moderation_overview(text) from public, anon;
grant execute on function public.support_companion_moderation_overview(text) to authenticated;

select pg_notify('pgrst', 'reload schema');
