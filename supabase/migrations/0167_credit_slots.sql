-- ===========================================================================
-- 0167_credit_slots.sql  (Membership restructure — Phase 4 wiring)
--
-- 45-minute available-slot generator for credit bookings (no offer needed), and
-- an overlap guard added to create_credit_booking so two members can't book the
-- same companion slot at once.
-- ===========================================================================

set search_path = '';

-- Available 45-minute slots for a companion (mirrors get_available_slots__impl
-- but with a fixed 45-minute duration and the new booking statuses in the
-- collision check).
create or replace function public.get_credit_slots(
  p_companion uuid, p_from timestamptz, p_to timestamptz)
returns table (slot_start timestamptz, slot_end timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_duration integer := 45;
  v_tz text; v_from timestamptz; v_to timestamptz; v_day date; v_last_day date;
  r record; v_t time; v_start timestamptz; v_end timestamptz; v_count integer := 0;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not (app_private.is_discoverable_companion(p_companion)
          or app_private.has_profile_access(p_companion)) then
    raise exception 'Companion not available';
  end if;

  select cp.timezone into v_tz from public.companion_profiles cp where cp.profile_id = p_companion;
  v_tz := coalesce(v_tz, 'Europe/London');
  v_from := greatest(p_from, now());
  v_to := least(p_to, v_from + interval '31 days');
  v_day := (v_from at time zone v_tz)::date;
  v_last_day := (v_to at time zone v_tz)::date;

  while v_day <= v_last_day and v_count < 200 loop
    for r in
      select ar.start_local_time as s, ar.end_local_time as e
      from public.availability_rules ar
      where ar.companion_profile_id = p_companion and ar.active
        and ar.day_of_week = extract(isodow from v_day)::int
      union all
      select greatest((ae.starts_at at time zone v_tz), v_day::timestamp)::time,
             least((ae.ends_at at time zone v_tz), (v_day + 1)::timestamp)::time
      from public.availability_exceptions ae
      where ae.companion_profile_id = p_companion and ae.exception_type = 'additionally_available'
        and (ae.starts_at at time zone v_tz)::date <= v_day
        and (ae.ends_at at time zone v_tz)::date >= v_day
    loop
      v_t := r.s;
      while v_t + make_interval(mins => v_duration) <= r.e and v_count < 200 loop
        v_start := (v_day + v_t) at time zone v_tz;
        v_end := v_start + make_interval(mins => v_duration);
        if v_start >= v_from and v_end <= v_to
           and app_private.slot_within_availability(p_companion, v_start, v_end)
           and not exists (
             select 1 from public.bookings b
             where b.companion_profile_id = p_companion
               and b.status in ('requested','confirmed','change_proposed','booked','companion_confirmed','admin_fallback')
               and b.starts_at < v_end and b.ends_at > v_start)
        then
          slot_start := v_start; slot_end := v_end; v_count := v_count + 1; return next;
        end if;
        v_t := v_t + interval '15 minutes';
      end loop;
    end loop;
    v_day := v_day + 1;
  end loop;
  return;
end;
$$;
revoke all on function public.get_credit_slots(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_credit_slots(uuid, timestamptz, timestamptz) to authenticated;

-- Redefine create_credit_booking with an overlap guard (0162 + collision check).
create or replace function public.create_credit_booking(
  p_companion_profile uuid, p_member_profile uuid, p_starts_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_booked_by uuid := auth.uid(); v_booking uuid; v_ends timestamptz := p_starts_at + interval '45 minutes';
begin
  if v_booked_by is null then raise exception 'unauthorised' using errcode = '42501'; end if;
  if not exists (select 1 from public.profile_access pa
                  where pa.profile_id = p_member_profile and pa.account_id = v_booked_by) then
    raise exception 'not_authorised_for_member' using errcode = '42501';
  end if;
  if not app_private.companion_is_approved(p_companion_profile) then
    raise exception 'companion_unavailable' using errcode = 'P0001';
  end if;
  if p_starts_at <= now() then raise exception 'starts_in_past' using errcode = 'P0001'; end if;
  if exists (
    select 1 from public.bookings b
    where b.companion_profile_id = p_companion_profile
      and b.status in ('requested','confirmed','change_proposed','booked','companion_confirmed','admin_fallback')
      and b.starts_at < v_ends and b.ends_at > p_starts_at
  ) then
    raise exception 'slot_taken' using errcode = 'P0001';
  end if;

  insert into public.bookings (
    member_profile_id, companion_profile_id, booked_by_account_id, offer_id,
    starts_at, ends_at, timezone, communication_method, status, duration_minutes,
    price_minor, currency, platform_fee_rate, platform_fee_minor, companion_amount_minor,
    is_trial, confirmation_deadline_at
  ) values (
    p_member_profile, p_companion_profile, v_booked_by, null,
    p_starts_at, v_ends, 'Europe/London', 'in_app', 'booked', 45,
    833, 'GBP', 15.00, 0, 0, false, p_starts_at - interval '20 minutes'
  ) returning id into v_booking;

  perform public.consume_call_credit(p_member_profile, v_booking);
  return v_booking;
end;
$$;
revoke all on function public.create_credit_booking(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.create_credit_booking(uuid, uuid, timestamptz) to authenticated;

select pg_notify('pgrst', 'reload schema');
