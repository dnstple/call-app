-- ============================================================
-- READ-ONLY scan for the completion/earning invariant break (booking ba4f943c
-- class). Run against hosted Supabase as a privileged role. SELECT-only —
-- mutates nothing. Each query returns a count + the affected booking ids so the
-- blast radius is known before any repair. This also tells us whether financial
-- reconciliation needs a new invariant.
--
-- Authoritative rule: only an ACCEPTED (status='confirmed') booking may have
-- attendance, completion prompts or earnings.
-- ============================================================

-- 1. Non-accepted booking with a finalised took_place attendance.
select 'A_nonconfirmed_attendance' as check, count(*) as n,
       array_agg(a.booking_id) as booking_ids
from public.conversation_attendance a
join public.bookings b on b.id = a.booking_id
where a.outcome = 'took_place' and coalesce(a.finalised, true)
  and b.status <> 'confirmed';

-- 2. Non-accepted booking with a payable/transferred earning.
select 'B_nonconfirmed_earning_live' as check, count(*) as n,
       array_agg(e.booking_id) as booking_ids
from public.companion_earnings e
join public.bookings b on b.id = e.booking_id
where b.status <> 'confirmed'
  and (e.state = 'payable' or e.transfer_state in ('processing', 'transfer_pending', 'transferred'));

-- 3. Earning with NO qualifying completion evidence (non-confirmed booking AND
--    no attendance row at all).
select 'C_earning_no_evidence' as check, count(*) as n,
       array_agg(e.booking_id) as booking_ids
from public.companion_earnings e
join public.bookings b on b.id = e.booking_id
where b.status <> 'confirmed'
  and not exists (select 1 from public.conversation_attendance a where a.booking_id = e.booking_id);

-- 4. Review prompt emitted for a non-accepted booking.
select 'D_review_prompt_nonconfirmed' as check, count(distinct n.related_booking_id) as n,
       array_agg(distinct n.related_booking_id) as booking_ids
from public.notifications n
join public.bookings b on b.id = n.related_booking_id
where n.type = 'review_prompt' and b.status <> 'confirmed';

-- 5. Attendance reminder emitted for a non-accepted booking.
select 'E_attendance_reminder_nonconfirmed' as check, count(distinct n.related_booking_id) as n,
       array_agg(distinct n.related_booking_id) as booking_ids
from public.notifications n
join public.bookings b on b.id = n.related_booking_id
where n.type = 'attendance_reminder' and b.status <> 'confirmed';

-- 6. Transfer attempt stuck 'processing' with no provider id beyond a retry
--    threshold (30 min) — reconciliation candidate (independent of status).
select 'F_transfer_processing_no_provider' as check, count(*) as n,
       array_agg(ta.earning_id) as earning_ids
from public.companion_transfer_attempts ta
where ta.state in ('processing', 'queued')
  and ta.stripe_transfer_id is null
  and ta.created_at < now() - interval '30 minutes';

-- 7. Roll-up: every booking implicated by any check above.
select 'G_all_affected_bookings' as check, count(*) as n, array_agg(id) as booking_ids
from (
  select a.booking_id as id from public.conversation_attendance a join public.bookings b on b.id = a.booking_id
    where a.outcome = 'took_place' and coalesce(a.finalised, true) and b.status <> 'confirmed'
  union
  select e.booking_id from public.companion_earnings e join public.bookings b on b.id = e.booking_id
    where b.status <> 'confirmed' and (e.state = 'payable' or e.transfer_state in ('processing','transfer_pending','transferred'))
  union
  select n.related_booking_id from public.notifications n join public.bookings b on b.id = n.related_booking_id
    where n.type in ('review_prompt','attendance_reminder') and b.status <> 'confirmed'
) s;
