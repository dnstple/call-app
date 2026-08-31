-- ===========================================================================
-- 0185_credit_booking_source.sql
--
-- Fix: credit bookings could never be inserted. bookings.booking_source defaults
-- to 'single_offer' and the 0009 bookings_source_shape check only allows
--   single_offer (needs offer_id)  OR  package_credit (needs package_purchase_id).
-- create_credit_booking sets neither offer_id nor package, so every credit
-- booking violated the constraint ("bookings_source_shape"). This adds a
-- 'call_credit' source (offer_id null, package null) and makes
-- create_credit_booking stamp it. Additive; existing rows are unaffected.
-- ===========================================================================

set search_path = '';

-- 1. Allow 'call_credit' as a booking_source value. The 2-value check is named
--    bookings_booking_source_check (Postgres stores IN as = ANY(ARRAY[...])).
alter table public.bookings drop constraint if exists bookings_booking_source_check;
alter table public.bookings
  add constraint bookings_booking_source_check
  check (booking_source in ('single_offer', 'package_credit', 'call_credit'));

-- 2. Widen the shape constraint to include credit bookings.
alter table public.bookings drop constraint if exists bookings_source_shape;
alter table public.bookings add constraint bookings_source_shape check (
  (booking_source = 'single_offer'  and offer_id is not null and package_purchase_id is null)
  or (booking_source = 'package_credit' and offer_id is null and package_purchase_id is not null)
  or (booking_source = 'call_credit'    and offer_id is null and package_purchase_id is null)
);

-- 3. Stamp create_credit_booking with the correct source (0167 body + booking_source).
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
    is_trial, confirmation_deadline_at, booking_source
  ) values (
    p_member_profile, p_companion_profile, v_booked_by, null,
    p_starts_at, v_ends, 'Europe/London', 'in_app', 'booked', 45,
    833, 'GBP', 15.00, 0, 0, false, p_starts_at - interval '20 minutes', 'call_credit'
  ) returning id into v_booking;

  perform public.consume_call_credit(p_member_profile, v_booking);
  return v_booking;
end;
$$;
revoke all on function public.create_credit_booking(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.create_credit_booking(uuid, uuid, timestamptz) to authenticated;

select pg_notify('pgrst', 'reload schema');
