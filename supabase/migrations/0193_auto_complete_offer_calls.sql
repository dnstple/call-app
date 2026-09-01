-- ===========================================================================
-- 0193_auto_complete_offer_calls.sql
--
-- Close the gap that stopped post-call feedback firing on its own. Feedback
-- (0189 sweep_call_feedback) only picks up bookings that are status='completed'
-- with completed_at set. Credit bookings are auto-completed by 0168, but
-- OFFER / TRIAL bookings (the 'requested' -> 'confirmed' lifecycle) had NO
-- automatic completion at all — they only reached 'completed' via the manual
-- mutual-confirmation flow (0006 submit_completion_confirmation). So a trial
-- call that actually happened sat at 'confirmed' forever and its participants
-- were never asked for feedback (exactly what happened on the first live call).
--
-- This adds a scheduled sweep that completes an ended offer/trial call ONCE the
-- call genuinely took place (a call session started), setting status='completed'
-- + completed_at. Completing an offer/trial booking is financially inert — 0006
-- states plainly that no payment, payout, credit or rating is processed on
-- completion — so this only unblocks the feedback/notification flow; it moves no
-- money. Credit bookings (status booked/companion_confirmed/admin_fallback) are
-- left to 0168; this sweep deliberately targets the 'confirmed' offer/trial
-- status only. No-shows (no session, nobody joined) are left untouched.
-- ===========================================================================

set search_path = '';

create or replace function public.auto_complete_offer_calls()
returns integer language plpgsql security definer set search_path = '' as $$
declare b record; n integer := 0;
begin
  for b in
    select bk.id
      from public.bookings bk
      join public.call_sessions cs on cs.booking_id = bk.id
     where bk.status = 'confirmed'                     -- offer/trial lifecycle only (credit uses 0168)
       and bk.completed_at is null
       and bk.ends_at <= now()
       and bk.ends_at > now() - interval '2 days'      -- ignore ancient rows
       and cs.first_participant_joined_at is not null  -- the call actually started
  loop
    update public.bookings
       set status = 'completed',
           completed_at = coalesce(completed_at, now()),
           updated_at = now()
     where id = b.id and completed_at is null;
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.auto_complete_offer_calls() from public, anon, authenticated;
grant execute on function public.auto_complete_offer_calls() to service_role;

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — schedule select public.auto_complete_offer_calls() every 5 minutes yourself.';
    return;
  end if;
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'auto-complete-offer-calls';
  perform cron.schedule('auto-complete-offer-calls', '*/5 * * * *',
    $cron$select public.auto_complete_offer_calls();$cron$);
  raise notice 'Scheduled auto-complete-offer-calls every 5 minutes.';
exception when others then
  raise notice 'auto-complete-offer-calls scheduling skipped (%).', sqlerrm;
end $$;

select pg_notify('pgrst', 'reload schema');
