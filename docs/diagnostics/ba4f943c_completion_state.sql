-- ============================================================
-- READ-ONLY diagnostic for the "needs attention / earnings ready but can't
-- submit review" booking. Run against hosted Supabase (SQL editor) as a
-- privileged role. Returns booking state, party relationships, completion /
-- attendance / review / issue / earning / transfer / notification state.
--
-- SELECT-only. Mutates nothing. Replace the id below if needed.
-- ============================================================
\set booking_id '''ba4f943c-3e8d-4d4c-900d-fa551ccc5387'''

-- 1. Booking status, times, participants, requester (all columns).
select 'booking' as section, b.*
from public.bookings b
where b.id = :booking_id;

-- 2. Party account ownership (owner = own login; coordinator = manages the member).
select 'profile_access' as section,
  pa.profile_id, pa.account_id, pa.access_role, pa.can_edit, pa.can_book, pa.consent_status,
  case when pa.profile_id = b.member_profile_id then 'member'
       when pa.profile_id = b.companion_profile_id then 'companion' else 'other' end as side
from public.bookings b
join public.profile_access pa on pa.profile_id in (b.member_profile_id, b.companion_profile_id)
where b.id = :booking_id
order by side, pa.access_role;

-- 3. Completion confirmations (per participant side).
select 'completion_confirmations' as section, cc.*
from public.completion_confirmations cc
where cc.booking_id = :booking_id;

-- 4. Companion-submitted / system attendance.
select 'conversation_attendance' as section, ca.*
from public.conversation_attendance ca
where ca.booking_id = :booking_id;

-- 5. Reviews + ratings.
select 'conversation_reviews' as section, cr.*
from public.conversation_reviews cr
where cr.booking_id = :booking_id;
select 'ratings' as section, r.*
from public.ratings r
where r.booking_id = :booking_id;

-- 6. Open/closed issues.
select 'conversation_issues' as section, ci.id, ci.state, ci.category, ci.created_at, ci.resolved_at
from public.conversation_issues ci
where ci.booking_id = :booking_id;

-- 7. Earning status (the companion's payout state).
select 'companion_earnings' as section,
  e.id, e.state, e.transfer_state, e.basis_minor, e.net_minor, e.payable_at,
  e.companion_account_id, e.payment_order_id
from public.companion_earnings e
where e.booking_id = :booking_id;

-- 8. Transfer / payout attempts for that earning.
select 'companion_transfer_attempts' as section, ta.id, ta.state, ta.stripe_transfer_id, ta.amount_minor, ta.created_at
from public.companion_transfer_attempts ta
join public.companion_earnings e on e.id = ta.earning_id
where e.booking_id = :booking_id;

-- 9. Payment order (funding) for the booking.
select 'payment_orders' as section, o.id, o.status, o.total_minor, o.card_amount_minor, o.provider
from public.payment_orders o
where o.booking_id = :booking_id;

-- 10. The authoritative read-model each side sees (run as the relevant account
--     via the app; shown here for reference — these are SECURITY DEFINER RPCs):
--       select public.get_companion_completion_state('ba4f943c-...'::uuid);  -- companion
--       select public.get_review_state('ba4f943c-...'::uuid);                -- member/coordinator

-- 11. Related notifications (safe columns only).
select 'notifications' as section, n.type, n.title, n.created_at, n.read
from public.notifications n
where n.related_booking_id = :booking_id
order by n.created_at desc
limit 20;
