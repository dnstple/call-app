-- ===========================================================================
-- 0162_credit_booking_and_fallback.sql  (Membership restructure — Phase 4)
--
-- Credit-based booking with companion confirmation and admin fallback.
--
--   * A member spends a credit to book an available 45-minute slot. The booking
--     is instantly `booked` (guaranteed) — no companion acceptance step.
--   * The companion must CONFIRM by (start − 20 min). If still unconfirmed then,
--     it transfers to admin fallback.
--   * If confirmed but the companion doesn't JOIN within 2 minutes of the start,
--     it also transfers to admin fallback.
--   * Fallback is first-available: any support admin can accept it.
--   * On admin takeover the member's credit is used (admin delivers the call);
--     the absent companion earns nothing (Phase 5 skips earnings for fallback).
--
-- Additive to the existing booking flow (new statuses + a new create RPC); the
-- old offer/trial flow is removed in Phase 7.
-- ===========================================================================

set search_path = '';

-- New columns + wider status set (offer_id becomes optional for credit bookings).
alter table public.bookings
  add column if not exists confirmation_deadline_at timestamptz,
  add column if not exists companion_confirmed_at   timestamptz,
  add column if not exists companion_joined_at      timestamptz,
  add column if not exists admin_fallback_at         timestamptz,
  add column if not exists handled_by_admin_id       uuid references public.accounts(id),
  add column if not exists completed_at              timestamptz;

alter table public.bookings alter column offer_id drop not null;

alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status in ('requested','confirmed','declined','change_proposed','cancelled',
                    'booked','companion_confirmed','admin_fallback','completed'));

-- Create a credit-funded booking: instant `booked`, 45 minutes, consumes a credit.
create or replace function public.create_credit_booking(
  p_companion_profile uuid, p_member_profile uuid, p_starts_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_booked_by uuid := auth.uid(); v_booking uuid;
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

  insert into public.bookings (
    member_profile_id, companion_profile_id, booked_by_account_id, offer_id,
    starts_at, ends_at, timezone, communication_method, status, duration_minutes,
    price_minor, currency, platform_fee_rate, platform_fee_minor, companion_amount_minor,
    is_trial, confirmation_deadline_at
  ) values (
    p_member_profile, p_companion_profile, v_booked_by, null,
    p_starts_at, p_starts_at + interval '45 minutes', 'Europe/London', 'in_app', 'booked', 45,
    833, 'GBP', 15.00, 0, 0,
    false, p_starts_at - interval '20 minutes'
  ) returning id into v_booking;

  -- Consume a credit (raises no_credits → whole booking rolls back if none left).
  perform public.consume_call_credit(p_member_profile, v_booking);
  return v_booking;
end;
$$;
revoke all on function public.create_credit_booking(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.create_credit_booking(uuid, uuid, timestamptz) to authenticated;

-- Companion confirms they will take the call (owner of the companion profile).
create or replace function public.companion_confirm_booking(p_booking uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.bookings;
begin
  select * into b from public.bookings where id = p_booking for update;
  if b.id is null then raise exception 'not_found'; end if;
  if not exists (select 1 from public.profile_access pa
                  where pa.profile_id = b.companion_profile_id and pa.account_id = auth.uid()
                    and pa.access_role = 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if b.status <> 'booked' then return; end if;   -- idempotent / already moved on
  update public.bookings
     set status = 'companion_confirmed', companion_confirmed_at = now(), updated_at = now()
   where id = p_booking;
end;
$$;
revoke all on function public.companion_confirm_booking(uuid) from public, anon;
grant execute on function public.companion_confirm_booking(uuid) to authenticated;

-- Mark that the companion has joined the call (called by the call page on join),
-- so the no-show sweep can tell attendance apart.
create or replace function public.mark_companion_joined(p_booking uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.bookings b
                  join public.profile_access pa on pa.profile_id = b.companion_profile_id
                  where b.id = p_booking and pa.account_id = auth.uid() and pa.access_role = 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.bookings set companion_joined_at = coalesce(companion_joined_at, now()), updated_at = now()
   where id = p_booking;
end;
$$;
revoke all on function public.mark_companion_joined(uuid) from public, anon;
grant execute on function public.mark_companion_joined(uuid) to authenticated;

-- Sweep: move unconfirmed-past-deadline and confirmed-no-show bookings to admin
-- fallback, and notify all admins so the first available can accept.
create or replace function public.sweep_booking_fallbacks()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[]; a record; n integer;
begin
  with moved as (
    update public.bookings
       set status = 'admin_fallback', admin_fallback_at = now(), updated_at = now()
     where (
             (status = 'booked' and confirmation_deadline_at <= now())
          or (status = 'companion_confirmed' and starts_at + interval '2 minutes' <= now()
              and companion_joined_at is null and completed_at is null)
           )
       and starts_at > now() - interval '3 hours'   -- ignore ancient rows
    returning id
  )
  select array_agg(id) into v_ids from moved;

  n := coalesce(array_length(v_ids, 1), 0);
  if n = 0 then return 0; end if;

  -- Notify every support admin once per fallen-back booking.
  for a in select account_id from public.support_admins loop
    insert into public.notifications (user_id, type, title, body, dedupe_key)
    select a.account_id, 'admin_call_fallback',
           'A call needs an admin',
           'A booked call was not confirmed or attended by the companion and needs an admin to take it. Open the internal calls fallback queue to accept it.',
           'admin_call_fallback:' || bid::text
    from unnest(v_ids) as bid
    on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
  end loop;

  return n;
end;
$$;
revoke all on function public.sweep_booking_fallbacks() from public, anon, authenticated;
grant execute on function public.sweep_booking_fallbacks() to service_role;

-- First-available admin accepts a fallback call (first writer wins).
create or replace function public.admin_accept_fallback(p_booking uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.bookings; v_updated integer;
begin
  if not app_private.is_support_admin() then raise exception 'unauthorised: support only'; end if;
  select * into b from public.bookings where id = p_booking for update;
  if b.id is null then raise exception 'not_found'; end if;
  if b.status <> 'admin_fallback' then raise exception 'not_available'; end if;
  if b.handled_by_admin_id is not null then
    return jsonb_build_object('ok', true, 'already', true, 'admin', b.handled_by_admin_id);
  end if;
  update public.bookings set handled_by_admin_id = auth.uid(), updated_at = now()
   where id = p_booking and handled_by_admin_id is null;
  get diagnostics v_updated = row_count;
  return jsonb_build_object('ok', true, 'already', v_updated = 0);
end;
$$;
revoke all on function public.admin_accept_fallback(uuid) from public, anon;
grant execute on function public.admin_accept_fallback(uuid) to authenticated;

-- List of calls currently awaiting an admin (support-only).
create or replace function public.admin_fallback_queue()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app_private.require_support();
  select coalesce(jsonb_agg(to_jsonb(x) order by x.starts_at), '[]'::jsonb) into v from (
    select b.id, b.starts_at, b.admin_fallback_at, b.handled_by_admin_id,
           nullif(trim(coalesce(m.first_name,'')||' '||coalesce(m.last_name,'')),'') as member_name,
           nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),'') as companion_name
    from public.bookings b
    join public.profiles m on m.id = b.member_profile_id
    join public.profiles c on c.id = b.companion_profile_id
    where b.status = 'admin_fallback'
      and b.starts_at > now() - interval '3 hours'
  ) x;
  return v;
end;
$$;
revoke all on function public.admin_fallback_queue() from public, anon;
grant execute on function public.admin_fallback_queue() to authenticated;

-- Run the fallback sweep frequently (every 2 minutes).
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — schedule select public.sweep_booking_fallbacks() every 2 minutes yourself.';
    return;
  end if;
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'sweep-booking-fallbacks';
  perform cron.schedule('sweep-booking-fallbacks', '*/2 * * * *',
    $cron$select public.sweep_booking_fallbacks();$cron$);
  raise notice 'Scheduled sweep-booking-fallbacks every 2 minutes.';
exception when others then
  raise notice 'sweep-booking-fallbacks scheduling skipped (%).', sqlerrm;
end $$;

select pg_notify('pgrst', 'reload schema');
