-- ===========================================================================
-- 0206_cancel_refund_and_credit_reschedule.sql
--
-- Member-friendly cancellation / reschedule policy for CREDIT bookings:
--
--   * CANCEL  — if the member cancels 2+ hours before the call, the call credit
--               is refunded (returned to 'active'). Inside the 2-hour window the
--               credit is forfeited (stays consumed). The 2-hour boundary reuses
--               app_private.reschedule_open() so cancel and reschedule share one
--               authoritative clock.
--   * RESCHEDULE — moves the SAME booking row to a new time, so the credit that
--               was consumed for it rides along unchanged (no new credit spent,
--               none refunded). The booking returns to 'booked' so the companion
--               re-confirms the new time. Also gated to 2+ hours.
--
-- Before this migration cancel_booking rejected credit statuses outright
-- ('booked' / 'companion_confirmed'), and the only reschedule path was the
-- two-party proposal flow (0012), which flips a booking to 'confirmed' and would
-- pull it out of the credit lifecycle. This adds credit-native handling for both.
-- ===========================================================================

set search_path = '';

-- ---------------------------------------------------------------------------
-- 1. Cancel: allow credit statuses + refund the credit when 2+ hours out.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_booking__impl(p_booking uuid, p_reason text default null)
returns public.bookings
language plpgsql security definer
set search_path = ''
as $$
declare v public.bookings; v_prev text; v_is_credit boolean; v_refundable boolean;
begin
  select * into v from public.bookings where id = p_booking for update;
  if v.id is null or not app_private.can_read_booking(p_booking) then
    raise exception 'Booking not found';
  end if;
  if not (v.booked_by_account_id = auth.uid()
          or app_private.can_act_for_member(v.member_profile_id)
          or app_private.can_edit_profile(v.companion_profile_id)) then
    raise exception 'You cannot cancel this booking';
  end if;
  -- Offer bookings: requested/confirmed/change_proposed.
  -- Credit bookings: booked/companion_confirmed.
  if v.status not in ('requested', 'confirmed', 'change_proposed', 'booked', 'companion_confirmed') then
    raise exception 'invalid_transition: booking is %', v.status;
  end if;

  v_is_credit := v.offer_id is null;                 -- credit-funded booking
  -- Refund only for credit bookings cancelled 2+ hours before the start.
  v_refundable := v_is_credit and app_private.reschedule_open(v.starts_at);

  v_prev := v.status;
  update public.bookings
     set status = 'cancelled', cancellation_reason = p_reason,
         cancelled_by_account_id = auth.uid(), cancelled_at = now(), updated_at = now()
   where id = p_booking returning * into v;
  update public.booking_time_proposals set status = 'expired', responded_at = now()
   where booking_id = p_booking and status = 'pending';
  perform app_private.record_transition(p_booking, v_prev, 'cancelled', p_reason);
  perform app_private.settle_package_credit(p_booking, 'release');  -- no-op for credit bookings

  -- Return the call credit to the ledger when within policy (2+ hours out).
  if v_refundable then
    perform public.refund_call_credit(p_booking);
  end if;

  return v;
end;
$$;
revoke all on function public.cancel_booking__impl(uuid, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Reschedule a credit booking in place (reuses the same credit).
-- ---------------------------------------------------------------------------
create or replace function public.reschedule_credit_booking(p_booking uuid, p_starts_at timestamptz)
returns public.bookings
language plpgsql security definer
set search_path = ''
as $$
declare b public.bookings; v_notice integer; v_ends timestamptz; v_prev text;
begin
  if auth.uid() is null then raise exception 'unauthorised' using errcode = '42501'; end if;

  select * into b from public.bookings where id = p_booking for update;
  if b.id is null or not app_private.can_read_booking(p_booking) then
    raise exception 'Booking not found';
  end if;
  -- Only the member side may reschedule their own credit call.
  if not (b.booked_by_account_id = auth.uid() or app_private.can_act_for_member(b.member_profile_id)) then
    raise exception 'You cannot reschedule this booking' using errcode = '42501';
  end if;
  if b.offer_id is not null then
    raise exception 'not_a_credit_booking' using errcode = 'P0001';
  end if;
  if b.status not in ('booked', 'companion_confirmed') then
    raise exception 'invalid_transition: booking is %', b.status;
  end if;

  -- The two-hour rule applies to BOTH the current time and the new time.
  if not app_private.reschedule_open(b.starts_at) then
    raise exception 'reschedule_closed: this call starts in less than two hours';
  end if;
  if not app_private.reschedule_open(p_starts_at) then
    raise exception 'reschedule_closed: choose a time at least two hours from now';
  end if;
  if p_starts_at <= now() then raise exception 'starts_in_past' using errcode = 'P0001'; end if;

  v_ends := p_starts_at + interval '45 minutes';
  v_prev := b.status;

  -- Respect the companion's minimum booking notice.
  select minimum_notice_hours into v_notice from public.companion_profiles
   where profile_id = b.companion_profile_id;
  if p_starts_at < now() + make_interval(hours => coalesce(v_notice, 0)) then
    raise exception 'too_soon' using errcode = 'P0001';
  end if;

  -- Don't collide with another live booking on the companion's calendar.
  if exists (
    select 1 from public.bookings x
    where x.companion_profile_id = b.companion_profile_id
      and x.id <> b.id
      and x.status in ('requested','confirmed','change_proposed','booked','companion_confirmed','admin_fallback')
      and x.starts_at < v_ends and x.ends_at > p_starts_at
  ) then
    raise exception 'slot_taken' using errcode = 'P0001';
  end if;

  -- In-place move: SAME booking row → the consumed credit stays attached (reused).
  -- Return to 'booked' so the companion re-confirms the new time.
  update public.bookings
     set starts_at = p_starts_at,
         ends_at = v_ends,
         status = 'booked',
         companion_confirmed_at = null,
         confirmation_deadline_at = p_starts_at - interval '20 minutes',
         updated_at = now()
   where id = b.id
   returning * into b;

  perform app_private.record_transition(p_booking, v_prev, 'booked', 'Member rescheduled credit call');
  return b;
end;
$$;
revoke all on function public.reschedule_credit_booking(uuid, timestamptz) from public, anon;
grant execute on function public.reschedule_credit_booking(uuid, timestamptz) to authenticated;

select pg_notify('pgrst', 'reload schema');
