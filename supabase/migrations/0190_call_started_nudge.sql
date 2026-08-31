-- ===========================================================================
-- 0190_call_started_nudge.sql
--
-- If a participant hasn't joined 5 minutes after the call's start time (and the
-- call is still running), nudge them: in-app + SMS "your call has started —
-- please join now." One nudge per person per call (deduped). Uses the join
-- evidence in call_attendance_evidence (companion_first_joined_at /
-- member_first_joined_at) as the "has joined" signal, and the existing outbox +
-- transport for SMS. Service role (pg_cron).
-- ===========================================================================

set search_path = '';

create or replace function public.sweep_call_started_nudge()
returns integer language plpgsql security definer set search_path = '' as $$
declare b record; ev record; n integer := 0; a uuid; v_link text;
begin
  for b in
    select bk.id, bk.member_profile_id, bk.companion_profile_id, bk.booked_by_account_id, bk.ends_at
    from public.bookings bk
    where bk.status in ('confirmed','booked','companion_confirmed')
      and bk.starts_at <= now() - interval '5 minutes'   -- 5+ min after start
      and bk.ends_at   >  now()                           -- call still in progress
  loop
    select * into ev from public.call_attendance_evidence where booking_id = b.id;
    v_link := 'https://apricoti.co.uk/#/conversations/' || b.id::text || '/call';

    -- Companion hasn't joined (no evidence row, or no first-join timestamp).
    if ev.companion_first_joined_at is null then
      a := app_private.profile_owner_account(b.companion_profile_id);
      if a is not null then
        perform app_private.notify_account(a, 'call_started', 'Your call has started',
          'Your call has started — please join now.', b.id,
          'call_started:' || b.id::text || ':' || a::text);
        perform app_private.queue_failover_sms(b.id, a, 'call_started',
          'Apricoti: Your call has started — please join now: ' || v_link,
          'call_started:' || b.id::text || ':' || a::text);
        n := n + 1;
      end if;
    end if;

    -- Member/booker hasn't joined.
    if ev.member_first_joined_at is null and b.booked_by_account_id is not null then
      a := b.booked_by_account_id;
      perform app_private.notify_account(a, 'call_started', 'Your call has started',
        'Your call has started — please join now.', b.id,
        'call_started:' || b.id::text || ':' || a::text);
      perform app_private.queue_failover_sms(b.id, a, 'call_started',
        'Apricoti: Your call has started — please join now: ' || v_link,
        'call_started:' || b.id::text || ':' || a::text);
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;
revoke all on function public.sweep_call_started_nudge() from public, anon, authenticated;
grant execute on function public.sweep_call_started_nudge() to service_role;

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — schedule select public.sweep_call_started_nudge() every ~2 minutes.';
    return;
  end if;
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'sweep-call-started-nudge';
  perform cron.schedule('sweep-call-started-nudge', '*/2 * * * *', $cron$select public.sweep_call_started_nudge();$cron$);
  raise notice 'Scheduled sweep-call-started-nudge every 2 minutes.';
exception when others then
  raise notice 'call-started nudge scheduling skipped (%).', sqlerrm;
end $$;

select pg_notify('pgrst', 'reload schema');
