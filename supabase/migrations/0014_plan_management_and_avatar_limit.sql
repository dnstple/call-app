-- ============================================================
-- Stage 2E4D — conversation-plan management and avatar limit.
--
-- Additive only. Adds:
--   1. pause metadata (reason, optional planned resume date);
--   2. imminent-conversation protection: bulk future cancellation
--      (pause/end/schedule change) now spares conversations starting
--      within the two-hour cutoff — they happen as planned;
--   3. skip_plan_occurrence: deliberately skip ONE generated
--      conversation (released allowance, never regenerated);
--   4. resolve_plan_occurrence: choose a replacement time for an
--      occurrence that could not be scheduled (conflict/availability),
--      enforcing the same overlap, availability, notice and cutoff
--      rules as generation; double resolution is blocked;
--   5. optional Companion response message on plan-change decisions;
--   6. profile-avatar Storage limit raised 4 MB → 10 MB (source file;
--      the client resizes/compresses before upload).
--
-- No packages/ledger renames. RLS stays on. All SECURITY DEFINER
-- functions pin an empty search_path, fully qualify relations and
-- validate the actor with auth.uid() + existing helpers.
-- ============================================================

-- ============================================================
-- 1. Pause metadata
-- ============================================================
alter table public.conversation_plans
  add column pause_reason text,
  add column resume_on date;

comment on column public.conversation_plans.pause_reason is
  'Optional reason captured when the plan was paused.';
comment on column public.conversation_plans.resume_on is
  'Optional planned resume date (informational; resuming stays manual).';

-- ============================================================
-- 2. Bulk future cancellation spares imminent conversations.
--    Used by pause_plan, end_plan and accept_plan_change (0011).
--    A conversation starting within two hours happens as planned.
-- ============================================================
create or replace function app_private.cancel_future_plan_bookings(p_plan uuid, p_reason text)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare v_b record; v_count integer := 0;
begin
  for v_b in
    select id, status from public.bookings
    where plan_id = p_plan
      and starts_at > now()
      and app_private.reschedule_open(starts_at)  -- spare the imminent
      and status in ('requested', 'confirmed', 'change_proposed')
    for update
  loop
    update public.bookings
       set status = 'cancelled', cancellation_reason = p_reason,
           cancelled_by_account_id = auth.uid(), cancelled_at = now(), updated_at = now()
     where id = v_b.id;
    perform app_private.record_transition(v_b.id, v_b.status, 'cancelled', p_reason);
    perform app_private.settle_package_credit(v_b.id, 'release');
    update public.plan_generation_log
       set outcome = 'skipped_paused', booking_id = null,
           detail = p_reason, updated_at = now()
     where plan_id = p_plan and booking_id = v_b.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function app_private.cancel_future_plan_bookings(uuid, text) from public, anon, authenticated;

-- ============================================================
-- 3. pause_plan with metadata; resume clears it.
--    (Old single-argument signatures are dropped to avoid RPC
--    overload ambiguity; behaviour is otherwise identical.)
-- ============================================================
drop function if exists public.pause_plan(uuid);

create or replace function public.pause_plan(
  p_plan uuid,
  p_reason text default null,
  p_resume_on date default null
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare v public.conversation_plans; v_cancelled integer;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.conversation_plans where id = p_plan for update;
  if v.id is null or not app_private.can_read_plan(p_plan) then
    raise exception 'Plan not found';
  end if;
  if not app_private.can_manage_plan(p_plan) then
    raise exception 'You cannot manage this plan';
  end if;
  if v.status <> 'active' then
    raise exception 'plan_not_active: this plan is %', v.status;
  end if;
  if p_resume_on is not null and p_resume_on <= current_date then
    raise exception 'invalid_slots: the resume date must be in the future';
  end if;
  update public.conversation_plans
     set status = 'paused', paused_at = now(),
         pause_reason = nullif(trim(coalesce(p_reason, '')), ''),
         resume_on = p_resume_on,
         updated_at = now()
   where id = p_plan;
  v_cancelled := app_private.cancel_future_plan_bookings(p_plan, 'Plan paused');
  return jsonb_build_object('plan_id', p_plan, 'status', 'paused', 'cancelled', v_cancelled);
end;
$$;
revoke all on function public.pause_plan(uuid, text, date) from public, anon;
grant execute on function public.pause_plan(uuid, text, date) to authenticated;

create or replace function public.resume_plan(p_plan uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare v public.conversation_plans;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.conversation_plans where id = p_plan for update;
  if v.id is null or not app_private.can_read_plan(p_plan) then
    raise exception 'Plan not found';
  end if;
  if not app_private.can_manage_plan(p_plan) then
    raise exception 'You cannot manage this plan';
  end if;
  if v.status <> 'paused' then
    raise exception 'plan_not_active: this plan is %', v.status;
  end if;
  update public.conversation_plans
     set status = 'active', paused_at = null,
         pause_reason = null, resume_on = null, updated_at = now()
   where id = p_plan;
  -- Idempotent regeneration: existing bookings and deliberate skips are
  -- never touched; retriable outcomes are retried (0011 semantics).
  return public.extend_plan_bookings(p_plan);
end;
$$;

-- ============================================================
-- 4. Skip ONE generated conversation (deliberate; never regenerated).
-- ============================================================
create or replace function public.skip_plan_occurrence(p_booking uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare v_b public.bookings; v_plan uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_b from public.bookings where id = p_booking for update;
  if v_b.id is null or v_b.plan_id is null then
    raise exception 'Plan not found';
  end if;
  v_plan := v_b.plan_id;
  if not app_private.can_read_plan(v_plan) then
    raise exception 'Plan not found';
  end if;
  if not app_private.can_manage_plan(v_plan) then
    raise exception 'You cannot manage this plan';
  end if;
  if v_b.status not in ('requested', 'confirmed', 'change_proposed') then
    raise exception 'plan_not_active: this conversation is %', v_b.status;
  end if;
  if not app_private.reschedule_open(v_b.starts_at) then
    raise exception 'reschedule_closed: this conversation starts in less than two hours';
  end if;

  update public.bookings
     set status = 'cancelled', cancellation_reason = 'Skipped by request',
         cancelled_by_account_id = auth.uid(), cancelled_at = now(), updated_at = now()
   where id = p_booking;
  perform app_private.record_transition(p_booking, v_b.status, 'cancelled', 'Skipped by request');
  perform app_private.settle_package_credit(p_booking, 'release');
  -- Deliberate skip: extend_plan_bookings never regenerates this.
  update public.plan_generation_log
     set outcome = 'skipped_by_request', booking_id = null,
         detail = 'Skipped by request', updated_at = now()
   where plan_id = v_plan and booking_id = p_booking;
  return jsonb_build_object('plan_id', v_plan, 'skipped', 1);
end;
$$;
revoke all on function public.skip_plan_occurrence(uuid) from public, anon;
grant execute on function public.skip_plan_occurrence(uuid) to authenticated;

-- ============================================================
-- 5. Resolve one unscheduled occurrence with a replacement time.
--    Same authority as generation: availability + notice + horizon
--    (slot_within_availability), the two-hour cutoff, and the booking
--    exclusion constraints (Companion AND Member never double-booked).
--    Double resolution is blocked; the audit trail survives.
-- ============================================================
create or replace function public.resolve_plan_occurrence(
  p_plan uuid,
  p_intended_start timestamptz,
  p_new_start timestamptz
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.conversation_plans;
  v_log public.plan_generation_log;
  v_end timestamptz;
  v_booking uuid;
  v_tz text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.conversation_plans where id = p_plan for update;
  if v.id is null or not app_private.can_read_plan(p_plan) then
    raise exception 'Plan not found';
  end if;
  if not app_private.can_manage_plan(p_plan) then
    raise exception 'You cannot manage this plan';
  end if;
  if v.status <> 'active' then
    raise exception 'plan_not_active: this plan is %', v.status;
  end if;
  -- Serialise credit movement with the generation engine.
  perform 1 from public.package_purchases where id = v.allowance_purchase_id for update;

  select * into v_log from public.plan_generation_log
    where plan_id = p_plan and intended_start = p_intended_start
    for update;
  if v_log.id is null then
    raise exception 'issue_not_found: there is no scheduling issue at that time';
  end if;
  if v_log.outcome not in ('skipped_conflict', 'skipped_availability') then
    raise exception 'already_resolved: this occurrence is already %', v_log.outcome;
  end if;

  if not app_private.reschedule_open(p_new_start) then
    raise exception 'reschedule_closed: choose a time at least two hours from now';
  end if;
  v_end := p_new_start + make_interval(mins => v.duration_minutes);
  if not app_private.slot_within_availability(v.companion_profile_id, p_new_start, v_end) then
    raise exception 'slot_unavailable: outside availability, notice or horizon';
  end if;

  select cp.timezone into v_tz from public.companion_profiles cp
    where cp.profile_id = v.companion_profile_id;

  begin
    insert into public.bookings (
      member_profile_id, companion_profile_id, booked_by_account_id,
      offer_id, package_purchase_id, booking_source, plan_id,
      starts_at, ends_at, timezone, communication_method, status,
      duration_minutes, price_minor, currency, platform_fee_rate,
      platform_fee_minor, companion_amount_minor, is_trial
    ) values (
      v.member_profile_id, v.companion_profile_id, v.created_by_account_id,
      null, v.allowance_purchase_id, 'package_credit', v.id,
      p_new_start, v_end, coalesce(v_tz, 'Europe/London'), v.communication_method, 'confirmed',
      v.duration_minutes, v.per_conversation_price_minor, v.currency, 0, 0,
      v.per_conversation_price_minor, false
    ) returning id into v_booking;
  exception
    when exclusion_violation then
      raise exception 'slot_unavailable: that time has just become unavailable';
  end;

  insert into public.booking_status_history (booking_id, previous_status, new_status, changed_by_account_id, reason)
  values (v_booking, null, 'confirmed', auth.uid(),
          'Replacement for plan occurrence originally intended at ' || p_intended_start::text);

  -- Allowance: grant + reserve pair, exactly like generation.
  insert into public.package_credit_ledger (package_purchase_id, entry_type, quantity, created_by_account_id, reason)
  values (v.allowance_purchase_id, 'grant', 1, auth.uid(), 'Weekly plan allowance');
  insert into public.package_credit_ledger (package_purchase_id, booking_id, entry_type, quantity, created_by_account_id, reason)
  values (v.allowance_purchase_id, v_booking, 'reserve', 1, auth.uid(), 'Reserved for rescheduled plan conversation');

  -- The log row keeps its intended_start (audit) and becomes resolved.
  update public.plan_generation_log
     set outcome = 'booked', booking_id = v_booking,
         detail = 'Rescheduled to ' || p_new_start::text, updated_at = now()
   where id = v_log.id;

  return jsonb_build_object('plan_id', p_plan, 'booking_id', v_booking, 'starts_at', p_new_start);
end;
$$;
revoke all on function public.resolve_plan_occurrence(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.resolve_plan_occurrence(uuid, timestamptz, timestamptz) to authenticated;

-- ============================================================
-- 6. Optional Companion response message on plan-change decisions.
--    (Signatures change: drop old to avoid RPC overload ambiguity.)
-- ============================================================
drop function if exists public.accept_plan_change(uuid);

create or replace function public.accept_plan_change(p_plan uuid, p_message text default null)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.conversation_plans;
  c jsonb;
  v_tz text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.conversation_plans where id = p_plan for update;
  if v.id is null or not app_private.can_read_plan(p_plan) then
    raise exception 'Plan not found';
  end if;
  if not app_private.can_edit_profile(v.companion_profile_id) then
    raise exception 'Only the companion can accept plan changes';
  end if;
  if v.pending_change is null then
    raise exception 'no_pending_change: there is nothing to accept';
  end if;
  if p_message is not null and char_length(trim(p_message)) > 1000 then
    raise exception 'invalid_slots: please keep the message under 1000 characters';
  end if;
  c := v.pending_change;

  update public.conversation_plans set
    frequency_per_week = (c->>'frequency_per_week')::integer,
    duration_minutes = (c->>'duration_minutes')::integer,
    communication_method = c->>'communication_method',
    per_conversation_price_minor = (c->>'per_conversation_price_minor')::integer,
    weekly_price_minor = (c->>'weekly_price_minor')::integer,
    pending_change = null,
    response_message = coalesce(nullif(trim(coalesce(p_message, '')), ''), response_message),
    updated_at = now()
  where id = p_plan;

  if c->'slots' is not null and jsonb_typeof(c->'slots') = 'array' then
    select cp.timezone into v_tz from public.companion_profiles cp
      where cp.profile_id = v.companion_profile_id;
    perform app_private.replace_plan_slots(
      p_plan, v.companion_profile_id,
      (c->>'duration_minutes')::integer, (c->>'frequency_per_week')::integer,
      coalesce(v_tz, 'Europe/London'), c->'slots');
  end if;

  perform app_private.cancel_future_plan_bookings(p_plan, 'Plan schedule changed');
  delete from public.plan_generation_log
    where plan_id = p_plan and intended_start > now() and outcome <> 'booked';
  if v.status = 'active' then
    return public.extend_plan_bookings(p_plan);
  end if;
  return jsonb_build_object('plan_id', p_plan, 'status', v.status, 'generated', 0);
end;
$$;
revoke all on function public.accept_plan_change(uuid, text) from public, anon;
grant execute on function public.accept_plan_change(uuid, text) to authenticated;

drop function if exists public.decline_plan_change(uuid);

create or replace function public.decline_plan_change(p_plan uuid, p_message text default null)
returns public.conversation_plans
language plpgsql security definer
set search_path = ''
as $$
declare v public.conversation_plans;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.conversation_plans where id = p_plan for update;
  if v.id is null or not app_private.can_read_plan(p_plan) then
    raise exception 'Plan not found';
  end if;
  if not app_private.can_edit_profile(v.companion_profile_id) then
    raise exception 'Only the companion can decline plan changes';
  end if;
  if v.pending_change is null then
    raise exception 'no_pending_change: there is nothing to decline';
  end if;
  if p_message is not null and char_length(trim(p_message)) > 1000 then
    raise exception 'invalid_slots: please keep the message under 1000 characters';
  end if;
  -- The active terms were never overwritten; dropping the proposal is all
  -- that is needed. The optional message explains the decision.
  update public.conversation_plans
     set pending_change = null,
         response_message = coalesce(nullif(trim(coalesce(p_message, '')), ''), response_message),
         updated_at = now()
   where id = p_plan
  returning * into v;
  return v;
end;
$$;
revoke all on function public.decline_plan_change(uuid, text) from public, anon;
grant execute on function public.decline_plan_change(uuid, text) to authenticated;

-- ============================================================
-- 7. Profile avatars: source uploads up to 10 MB (client resizes
--    and compresses; the stored object is far smaller in practice).
-- ============================================================
update storage.buckets
   set file_size_limit = 10485760
 where id = 'profile-avatars';
