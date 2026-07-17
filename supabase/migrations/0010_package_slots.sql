-- ============================================================
-- Stage 2E3B2B — slot generation for package-credit bookings.
--
-- Genuine gap: get_available_slots (0005) requires an ACTIVE
-- conversation offer, which package bookings deliberately do not have.
-- This variant derives the companion and duration from the PURCHASE
-- and applies exactly the same rules: recurring availability +
-- exceptions, minimum notice, booking horizon, active-booking
-- conflicts, 15-minute grid, 31-day range, 200-slot cap, DST-safe.
-- Readable only by accounts that can read the purchase.
-- ============================================================

create or replace function public.get_available_package_slots(
  p_purchase uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (slot_start timestamptz, slot_end timestamptz)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_p public.package_purchases;
  v_companion uuid;
  v_duration integer;
  v_tz text;
  v_from timestamptz;
  v_to timestamptz;
  v_day date;
  v_last_day date;
  r record;
  v_t time;
  v_start timestamptz;
  v_end timestamptz;
  v_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  select * into v_p from public.package_purchases where id = p_purchase;
  if v_p.id is null or not app_private.can_read_purchase(p_purchase) then
    raise exception 'package_mismatch: package not found';
  end if;
  if v_p.status <> 'active' then
    raise exception 'package_inactive: this package is % and cannot be used', v_p.status;
  end if;

  v_companion := v_p.companion_profile_id;
  v_duration := v_p.duration_minutes;

  select cp.timezone into v_tz from public.companion_profiles cp where cp.profile_id = v_companion;
  v_tz := coalesce(v_tz, 'Europe/London');

  v_from := greatest(p_from, now());
  v_to := least(p_to, v_from + interval '31 days');

  v_day := (v_from at time zone v_tz)::date;
  v_last_day := (v_to at time zone v_tz)::date;

  while v_day <= v_last_day and v_count < 200 loop
    for r in
      select ar.start_local_time as s, ar.end_local_time as e
      from public.availability_rules ar
      where ar.companion_profile_id = v_companion
        and ar.active
        and ar.day_of_week = extract(isodow from v_day)::int
      union all
      select greatest((ae.starts_at at time zone v_tz), v_day::timestamp)::time,
             least((ae.ends_at at time zone v_tz), (v_day + 1)::timestamp)::time
      from public.availability_exceptions ae
      where ae.companion_profile_id = v_companion
        and ae.exception_type = 'additionally_available'
        and (ae.starts_at at time zone v_tz)::date <= v_day
        and (ae.ends_at at time zone v_tz)::date >= v_day
    loop
      v_t := r.s;
      while v_t + make_interval(mins => v_duration) <= r.e and v_count < 200 loop
        v_start := (v_day + v_t) at time zone v_tz;
        v_end := v_start + make_interval(mins => v_duration);
        if v_start >= v_from and v_end <= v_to
           and app_private.slot_within_availability(v_companion, v_start, v_end)
           and not exists (
             select 1 from public.bookings b
             where b.companion_profile_id = v_companion
               and b.status in ('requested', 'confirmed', 'change_proposed')
               and b.starts_at < v_end and b.ends_at > v_start
           )
        then
          slot_start := v_start;
          slot_end := v_end;
          v_count := v_count + 1;
          return next;
        end if;
        v_t := v_t + interval '15 minutes';
      end loop;
    end loop;
    v_day := v_day + 1;
  end loop;
  return;
end;
$$;

revoke all on function public.get_available_package_slots(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_available_package_slots(uuid, timestamptz, timestamptz) to authenticated;
