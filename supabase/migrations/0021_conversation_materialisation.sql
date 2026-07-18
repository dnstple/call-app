-- ============================================================
-- 0021 — automatic conversation materialisation + backfill (2F2B fix).
--
-- Product rule: the moment a Member–Companion relationship becomes
-- eligible (a booking reaching 'confirmed' or 'completed', or a plan
-- reaching its accepted lifecycle — 'active', and thereafter 'paused' /
-- 'ended'), its ONE permanent thread should exist in Messages without
-- anyone pressing a button. get_or_create_conversation (0019) remains
-- the idempotent manual fallback and now usually just returns the row
-- the triggers created.
--
-- Exact qualifying statuses (read from the live constraints):
--   bookings.status:            'confirmed', 'completed'
--     (never requested / declined / change_proposed / cancelled /
--      needs_review — needs_review follows an already-confirmed life,
--      but the thread was created at confirmation)
--   conversation_plans.status:  'active', 'paused', 'ended'
--     (acceptance IS 'active' — there is no 'accepted' status;
--      'requested' and 'declined' never qualify)
--
-- One helper, used by every trusted path; browsers cannot execute it.
-- Repeated calls are harmless; the unique pair constraint arbitrates
-- concurrent transitions. Nothing is ever deleted.
-- ============================================================

create or replace function app_private.ensure_conversation(
  p_member uuid,
  p_companion uuid
)
returns void
language sql security definer
set search_path = ''
as $$
  insert into public.conversations (member_profile_id, companion_profile_id)
  values (p_member, p_companion)
  on conflict (member_profile_id, companion_profile_id) do nothing;
$$;
revoke all on function app_private.ensure_conversation(uuid, uuid)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- Triggers: fire on the genuine qualifying transitions only.
-- ------------------------------------------------------------
create or replace function app_private.materialise_booking_conversation()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status in ('confirmed', 'completed') then
    perform app_private.ensure_conversation(new.member_profile_id, new.companion_profile_id);
  end if;
  return new;
end;
$$;
revoke all on function app_private.materialise_booking_conversation()
  from public, anon, authenticated;

create trigger bookings_materialise_conversation
  after insert or update of status on public.bookings
  for each row
  when (new.status in ('confirmed', 'completed'))
  execute function app_private.materialise_booking_conversation();

create or replace function app_private.materialise_plan_conversation()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status in ('active', 'paused', 'ended') then
    perform app_private.ensure_conversation(new.member_profile_id, new.companion_profile_id);
  end if;
  return new;
end;
$$;
revoke all on function app_private.materialise_plan_conversation()
  from public, anon, authenticated;

create trigger plans_materialise_conversation
  after insert or update of status on public.conversation_plans
  for each row
  when (new.status in ('active', 'paused', 'ended'))
  execute function app_private.materialise_plan_conversation();

-- ------------------------------------------------------------
-- Backfill: every EXISTING distinct eligible pair gets its thread now,
-- concurrency-safe, never duplicating, never touching message history.
-- The counts are reported in the migration output.
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

  raise notice '0021 backfill: % conversations from bookings, % from plans',
    v_bookings, v_plans;
end $$;
