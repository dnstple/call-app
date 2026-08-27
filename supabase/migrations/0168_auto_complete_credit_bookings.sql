-- ===========================================================================
-- 0168_auto_complete_credit_bookings.sql  (Membership restructure — Phase 4/5 wiring)
--
-- Completes credit bookings after their end time and triggers the companion
-- payout — delivered by the companion only when the call was confirmed AND the
-- companion joined AND it wasn't taken over by an admin. Runs on a schedule so
-- payout is never client-triggered.
-- ===========================================================================

set search_path = '';

create or replace function public.auto_complete_credit_bookings()
returns integer language plpgsql security definer set search_path = '' as $$
declare b record; n integer := 0;
begin
  for b in
    select id, status, companion_joined_at, handled_by_admin_id
    from public.bookings
    where offer_id is null                       -- credit bookings only
      and completed_at is null
      and status in ('booked','companion_confirmed','admin_fallback')
      and ends_at <= now()
      and ends_at > now() - interval '2 days'    -- ignore very old rows
  loop
    perform public.complete_credit_booking(
      b.id,
      (b.status = 'companion_confirmed'
        and b.companion_joined_at is not null
        and b.handled_by_admin_id is null)
    );
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.auto_complete_credit_bookings() from public, anon, authenticated;
grant execute on function public.auto_complete_credit_bookings() to service_role;

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — schedule select public.auto_complete_credit_bookings() every 5 minutes yourself.';
    return;
  end if;
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'auto-complete-credit-bookings';
  perform cron.schedule('auto-complete-credit-bookings', '*/5 * * * *',
    $cron$select public.auto_complete_credit_bookings();$cron$);
  raise notice 'Scheduled auto-complete-credit-bookings every 5 minutes.';
exception when others then
  raise notice 'auto-complete-credit-bookings scheduling skipped (%).', sqlerrm;
end $$;

select pg_notify('pgrst', 'reload schema');
