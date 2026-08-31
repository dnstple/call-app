-- ===========================================================================
-- 0187_no_fallback_for_short_notice.sql
--
-- Allow short-notice credit calls to go ahead. Previously any 'booked' credit
-- call past its confirmation deadline (start − 20 min) was swept to
-- 'admin_fallback'. A call booked LESS than 20 minutes before start is created
-- already past that deadline, so it was instantly fallen back and became
-- unjoinable. There was never a window in which the companion could confirm, so
-- the fallback is pointless.
--
-- Fix: only fall a 'booked' call back to admin if it actually had a confirmation
-- window (created_at < confirmation_deadline_at). Calls booked inside their own
-- window stay 'booked' — which the join gate (0169) treats as joinable — so the
-- call can still happen. Normal lead-time bookings are unaffected. The
-- confirmed-but-no-show branch is unchanged. Mirrors 0162 otherwise.
-- ===========================================================================

set search_path = '';

create or replace function public.sweep_booking_fallbacks()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[]; a record; n integer;
begin
  with moved as (
    update public.bookings
       set status = 'admin_fallback', admin_fallback_at = now(), updated_at = now()
     where (
             (status = 'booked'
                and confirmation_deadline_at <= now()
                and created_at < confirmation_deadline_at)   -- only if there WAS a confirm window
          or (status = 'companion_confirmed' and starts_at + interval '2 minutes' <= now()
              and companion_joined_at is null and completed_at is null)
           )
       and starts_at > now() - interval '3 hours'
    returning id
  )
  select array_agg(id) into v_ids from moved;

  n := coalesce(array_length(v_ids, 1), 0);
  if n = 0 then return 0; end if;

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

select pg_notify('pgrst', 'reload schema');
