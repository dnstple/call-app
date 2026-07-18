-- ============================================================
-- 0022 — fix conversation creation (live P0001 "Conversation not found").
--
-- Redefines public.get_or_create_conversation with the canonical control
-- flow, healing any drift between the deployed function and the repo:
--
--   1. resolve auth.uid();
--   2. validate BOTH ids are real Member / Companion profiles;
--   3. look for the unique existing conversation;
--   4. found  → verify access via can_access_conversation(v.id)
--              (a real id — an access helper is NEVER called with null)
--              and return it;
--   5. absent → verify the caller IS a side (Member owner, Companion
--              owner, consent-live Coordinator with can_message), verify
--              pair eligibility, create via the shared private helper;
--   6. return the row.
--
-- Unauthorised/unrelated callers still receive a neutral not-found.
-- Stable error prefixes: unauthorised: / not_found: / not_eligible:.
-- Also re-runs the idempotent backfill and prints a diagnostic summary
-- (eligible pairs vs existing vs missing) in the migration output only.
-- No policy changes, no deletions, no new client grants beyond the
-- re-granted public RPC.
-- ============================================================

create or replace function public.get_or_create_conversation(
  p_member uuid,
  p_companion uuid
)
returns public.conversations
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.conversations;
  v_caller_is_side boolean;
begin
  -- 1. Actor.
  if auth.uid() is null then
    raise exception 'unauthorised: not signed in';
  end if;

  -- 2. Both ids must be real profiles of the right kind. (Neutral wording:
  --    outsiders learn nothing beyond "no such conversation".)
  if not exists (select 1 from public.profiles p where p.id = p_member and p.role = 'member')
     or not exists (select 1 from public.profiles p where p.id = p_companion and p.role = 'companion') then
    raise exception 'not_found: conversation';
  end if;

  -- 3. The unique existing thread (created by trigger, backfill or an
  --    earlier call).
  select * into v from public.conversations
   where member_profile_id = p_member and companion_profile_id = p_companion;

  -- 4. Exists → the access helper decides, with a REAL conversation id.
  if v.id is not null then
    if not app_private.can_access_conversation(v.id) then
      raise exception 'not_found: conversation';
    end if;
    return v;
  end if;

  -- 5. Absent → the caller must BE one of the sides…
  v_caller_is_side :=
    exists (
      select 1 from public.profile_access pa
      where pa.account_id = auth.uid()
        and pa.profile_id = p_companion
        and pa.access_role = 'owner'
    )
    or exists (
      select 1 from public.profile_access pa
      where pa.account_id = auth.uid()
        and pa.profile_id = p_member
        and (pa.access_role = 'owner'
             or (pa.access_role = 'coordinator'
                 and pa.can_message
                 and pa.consent_status <> 'withdrawn'))
    );
  if not v_caller_is_side then
    raise exception 'not_found: conversation';
  end if;

  -- …and the pair must genuinely qualify (unchanged 0019 rule).
  if not app_private.messaging_pair_eligible(p_member, p_companion) then
    raise exception 'not_eligible: messaging opens after a confirmed conversation or an accepted plan';
  end if;

  -- 6. Create through the ONE shared helper (0021); the unique pair
  --    constraint arbitrates concurrent calls.
  perform app_private.ensure_conversation(p_member, p_companion);

  select * into v from public.conversations
   where member_profile_id = p_member and companion_profile_id = p_companion;
  if v.id is null then
    raise exception 'not_found: conversation'; -- defensive; should not occur
  end if;
  return v;
end;
$$;
revoke all on function public.get_or_create_conversation(uuid, uuid) from public, anon;
grant execute on function public.get_or_create_conversation(uuid, uuid) to authenticated;

-- ------------------------------------------------------------
-- Idempotent backfill (again): every currently eligible pair.
-- app_private.ensure_conversation (0021) is verified correct — plain
-- INSERT … ON CONFLICT DO NOTHING on profile ids — and stays unchanged.
-- ------------------------------------------------------------
do $$
declare
  v_bookings integer;
  v_plans integer;
begin
  insert into public.conversations (member_profile_id, companion_profile_id)
  select distinct b.member_profile_id, b.companion_profile_id
  from public.bookings b
  where b.status in ('confirmed', 'completed')
  on conflict (member_profile_id, companion_profile_id) do nothing;
  get diagnostics v_bookings = row_count;

  insert into public.conversations (member_profile_id, companion_profile_id)
  select distinct p.member_profile_id, p.companion_profile_id
  from public.conversation_plans p
  where p.status in ('active', 'paused', 'ended')
  on conflict (member_profile_id, companion_profile_id) do nothing;
  get diagnostics v_plans = row_count;

  raise notice '0022 backfill: % new conversations from bookings, % from plans',
    v_bookings, v_plans;
end $$;

-- ------------------------------------------------------------
-- Diagnostics (migration output only — never surfaced in the app):
-- eligible pairs vs existing conversations vs anything still missing.
-- After this migration "missing" MUST be zero.
-- ------------------------------------------------------------
do $$
declare
  v_plan_pairs integer;
  v_booking_pairs integer;
  v_conversations integer;
  v_missing integer;
begin
  select count(*) into v_plan_pairs from (
    select distinct member_profile_id, companion_profile_id
    from public.conversation_plans where status in ('active', 'paused', 'ended')
  ) x;
  select count(*) into v_booking_pairs from (
    select distinct member_profile_id, companion_profile_id
    from public.bookings where status in ('confirmed', 'completed')
  ) x;
  select count(*) into v_conversations from public.conversations;
  select count(*) into v_missing from (
    select distinct member_profile_id, companion_profile_id
    from public.conversation_plans where status in ('active', 'paused', 'ended')
    union
    select distinct member_profile_id, companion_profile_id
    from public.bookings where status in ('confirmed', 'completed')
  ) eligible
  where not exists (
    select 1 from public.conversations c
    where c.member_profile_id = eligible.member_profile_id
      and c.companion_profile_id = eligible.companion_profile_id
  );
  raise notice '0022 diagnostics: eligible plan pairs=%, eligible booking pairs=%, conversations=%, eligible pairs still missing=%',
    v_plan_pairs, v_booking_pairs, v_conversations, v_missing;
end $$;
