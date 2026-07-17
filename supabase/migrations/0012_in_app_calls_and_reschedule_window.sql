-- ============================================================
-- Corrective Stage 2E4B — in-app calls + the two-hour rescheduling rule.
--
-- 1. EVERY conversation now happens inside the app. The stored method
--    becomes the provider-neutral value 'in_app'; legacy rows (phone,
--    whatsapp, zoom…) are normalised. No calling provider is integrated
--    here — the app boundary is documented in the UI (/calls/:bookingId).
--
-- 2. RESCHEDULING CLOSES AT starts_at − 2 hours, enforced in the
--    DATABASE using now(), so a manipulated browser clock or a direct
--    RPC call cannot bypass it. Cancellation policy is unchanged.
--
-- Additive only. No payment is taken anywhere.
-- ============================================================

-- ---------- 1. In-app calls ----------

-- Normalise existing data (idempotent).
update public.bookings set communication_method = 'in_app'
 where communication_method <> 'in_app';
update public.conversation_offers set supported_methods = array['in_app']
 where supported_methods is distinct from array['in_app'];
update public.package_offers set supported_methods = array['in_app']
 where supported_methods is distinct from array['in_app'];
update public.conversation_plans set communication_method = 'in_app'
 where communication_method <> 'in_app';
update public.member_profiles set preferred_methods = array['in_app']
 where preferred_methods is distinct from array['in_app'];

-- New rows default to in-app, and only in-app is accepted.
alter table public.bookings alter column communication_method set default 'in_app';
alter table public.bookings add constraint bookings_method_in_app
  check (communication_method = 'in_app');

alter table public.conversation_offers alter column supported_methods set default array['in_app'];
alter table public.package_offers alter column supported_methods set default array['in_app'];
alter table public.conversation_plans alter column communication_method set default 'in_app';
alter table public.conversation_plans add constraint plans_method_in_app
  check (communication_method = 'in_app');

-- Offers created through 2C2's direct-insert path are forced to in-app.
create or replace function app_private.force_in_app_methods()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  new.supported_methods := array['in_app'];
  return new;
end;
$$;
revoke all on function app_private.force_in_app_methods() from public, anon, authenticated;

drop trigger if exists conversation_offers_in_app on public.conversation_offers;
create trigger conversation_offers_in_app
  before insert or update on public.conversation_offers
  for each row execute function app_private.force_in_app_methods();

drop trigger if exists package_offers_in_app on public.package_offers;
create trigger package_offers_in_app
  before insert or update on public.package_offers
  for each row execute function app_private.force_in_app_methods();

-- ============================================================
-- 2. The two-hour rescheduling window
-- ============================================================

/**
 * The single source of truth for "can this conversation still be moved?".
 * Uses the booking timestamp and the DATABASE clock — never the browser.
 */
create or replace function app_private.reschedule_open(p_starts_at timestamptz)
returns boolean
language sql stable
set search_path = ''
as $$
  select p_starts_at - interval '2 hours' > now();
$$;
revoke all on function app_private.reschedule_open(timestamptz) from public, anon, authenticated;

/** Readable by participants: drives the UI copy, never the decision. */
create or replace function public.get_reschedule_state(p_booking uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare v public.bookings;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.bookings where id = p_booking;
  if v.id is null or not app_private.can_read_booking(p_booking) then
    raise exception 'Booking not found';
  end if;
  return jsonb_build_object(
    'booking_id', v.id,
    'starts_at', v.starts_at,
    'cutoff_at', v.starts_at - interval '2 hours',
    'can_reschedule', app_private.reschedule_open(v.starts_at)
      and v.status in ('requested', 'confirmed', 'change_proposed'),
    'server_now', now()
  );
end;
$$;
revoke all on function public.get_reschedule_state(uuid) from public, anon;
grant execute on function public.get_reschedule_state(uuid) to authenticated;

-- ---------- propose a new time: closed inside the cutoff ----------
-- (Full re-definition of 0005's function; identical apart from the rule
--  and the fact that the proposed time itself must also be movable.)
create or replace function public.propose_booking_time(
  p_booking uuid,
  p_starts_at timestamptz,
  p_message text default null
)
returns public.booking_time_proposals
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.bookings;
  v_prop public.booking_time_proposals;
  v_is_companion boolean;
  v_is_requester boolean;
begin
  select * into v from public.bookings where id = p_booking for update;
  if v.id is null or not app_private.can_read_booking(p_booking) then
    raise exception 'Booking not found';
  end if;
  v_is_companion := app_private.can_edit_profile(v.companion_profile_id);
  v_is_requester := v.booked_by_account_id = auth.uid()
                    or app_private.can_act_for_member(v.member_profile_id);
  if v.status = 'requested' and not v_is_companion then
    raise exception 'Only the companion can propose a new time for a request';
  elsif v.status = 'confirmed' and not (v_is_companion or v_is_requester) then
    raise exception 'You cannot reschedule this booking';
  elsif v.status not in ('requested', 'confirmed') then
    raise exception 'invalid_transition: booking is %', v.status;
  end if;

  -- The two-hour rule (database clock, authoritative).
  if not app_private.reschedule_open(v.starts_at) then
    raise exception 'reschedule_closed: this conversation starts in less than two hours';
  end if;
  if not app_private.reschedule_open(p_starts_at) then
    raise exception 'reschedule_closed: choose a time at least two hours from now';
  end if;

  insert into public.booking_time_proposals (
    booking_id, proposed_by_account_id, proposed_starts_at, proposed_ends_at,
    timezone, previous_booking_status, message
  ) values (
    p_booking, auth.uid(), p_starts_at,
    p_starts_at + make_interval(mins => v.duration_minutes),
    v.timezone, v.status, p_message
  ) returning * into v_prop;

  update public.bookings set status = 'change_proposed', updated_at = now() where id = p_booking;
  perform app_private.record_transition(p_booking, v.status, 'change_proposed', p_message);
  return v_prop;
end;
$$;

-- ---------- accepting a proposal: still subject to the cutoff ----------
create or replace function public.accept_booking_time_proposal(p_proposal uuid)
returns public.bookings
language plpgsql security definer
set search_path = ''
as $$
declare
  v_prop public.booking_time_proposals;
  v public.bookings;
  v_responder_is_companion boolean;
  v_proposer_was_companion boolean;
begin
  select * into v_prop from public.booking_time_proposals where id = p_proposal for update;
  if v_prop.id is null or not app_private.can_read_booking(v_prop.booking_id) then
    raise exception 'Proposal not found';
  end if;
  if v_prop.status <> 'pending' then
    raise exception 'invalid_transition: proposal is %', v_prop.status;
  end if;
  select * into v from public.bookings where id = v_prop.booking_id for update;

  v_responder_is_companion := app_private.can_edit_profile(v.companion_profile_id);
  v_proposer_was_companion := exists (
    select 1 from public.profile_access pa
    where pa.account_id = v_prop.proposed_by_account_id
      and pa.profile_id = v.companion_profile_id and pa.can_edit
  );
  if v_proposer_was_companion then
    if not (v.booked_by_account_id = auth.uid() or app_private.can_act_for_member(v.member_profile_id)) then
      raise exception 'Only the requester can accept this proposal';
    end if;
  else
    if not v_responder_is_companion then
      raise exception 'Only the companion can accept this proposal';
    end if;
  end if;

  -- Both the current time and the new time must still be movable.
  if not app_private.reschedule_open(v.starts_at) then
    raise exception 'reschedule_closed: this conversation starts in less than two hours';
  end if;
  if not app_private.reschedule_open(v_prop.proposed_starts_at) then
    raise exception 'reschedule_closed: that time is now less than two hours away';
  end if;

  if not app_private.slot_within_availability(v.companion_profile_id, v_prop.proposed_starts_at, v_prop.proposed_ends_at) then
    raise exception 'outside_availability: that time is no longer within availability';
  end if;

  begin
    update public.bookings
       set starts_at = v_prop.proposed_starts_at,
           ends_at = v_prop.proposed_ends_at,
           status = 'confirmed',
           updated_at = now()
     where id = v.id;
  exception when exclusion_violation then
    raise exception 'slot_taken: that time has just been taken';
  end;

  update public.booking_time_proposals set status = 'accepted', responded_at = now() where id = p_proposal;
  perform app_private.record_transition(v.id, 'change_proposed', 'confirmed', 'Proposed time accepted');
  select * into v from public.bookings where id = v.id;
  return v;
end;
$$;

-- ---------- plan changes must not disturb imminent conversations ----------
/**
 * Cancel FUTURE plan occurrences that are still eligible to move. An
 * occurrence inside the two-hour window is left exactly as it is, and
 * reported back so the UI can say so plainly.
 */
create or replace function app_private.cancel_future_plan_bookings(p_plan uuid, p_reason text)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare v_b record; v_count integer := 0;
begin
  for v_b in
    select id, status, starts_at from public.bookings
    where plan_id = p_plan
      and starts_at > now()
      and status in ('requested', 'confirmed', 'change_proposed')
    for update
  loop
    -- Inside the cutoff: leave it alone (never silently moved).
    if not app_private.reschedule_open(v_b.starts_at) then
      continue;
    end if;
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

/** How many of a plan's occurrences are protected by the cutoff right now? */
create or replace function app_private.imminent_plan_bookings(p_plan uuid)
returns integer
language sql stable security definer
set search_path = ''
as $$
  select count(*)::integer from public.bookings
  where plan_id = p_plan
    and starts_at > now()
    and status in ('requested', 'confirmed', 'change_proposed')
    and not app_private.reschedule_open(starts_at);
$$;
revoke all on function app_private.imminent_plan_bookings(uuid) from public, anon, authenticated;

-- "This and future conversations": eligible occurrences regenerate; an
-- imminent one is preserved and reported (full re-definition of 0011's).
create or replace function public.accept_plan_change(p_plan uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.conversation_plans;
  c jsonb;
  v_tz text;
  v_protected integer;
  v_result jsonb;
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
  c := v.pending_change;

  v_protected := app_private.imminent_plan_bookings(p_plan);

  update public.conversation_plans set
    frequency_per_week = (c->>'frequency_per_week')::integer,
    duration_minutes = (c->>'duration_minutes')::integer,
    communication_method = 'in_app',
    per_conversation_price_minor = (c->>'per_conversation_price_minor')::integer,
    weekly_price_minor = (c->>'weekly_price_minor')::integer,
    pending_change = null,
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
    v_result := public.extend_plan_bookings(p_plan);
  else
    v_result := jsonb_build_object('plan_id', p_plan, 'status', v.status, 'generated', 0);
  end if;
  -- Imminent conversations keep their original time — say so honestly.
  return v_result || jsonb_build_object('preserved_imminent', v_protected);
end;
$$;
