-- ============================================================
-- Outcome-confirmation read-model fix (migration 0051).
--
-- Bug: after both sides confirmed a funded conversation (companion via
-- conversation_attendance → payable earning; coordinator via
-- conversation_reviews), the detail banner and the "Needs your attention" list
-- still said "waiting for both sides to confirm". Those surfaces derive from
-- bookings.status, which STAYS 'confirmed' — a booking is technically confirmed
-- even once the outcome is complete — and from the legacy completion_confirmations
-- table, which is never written for funded bookings.
--
-- Fix (additive, read-model only): expose per-side outcome-confirmation flags and
-- the caller's side on my_bookings so the list AND detail derive completion from
-- the SAME authoritative fields. Existence-only booleans (never the private
-- review text). Sources per side:
--   member/coordinator  → a conversation_reviews row (2G4) OR a legacy
--                         completion_confirmations 'member' row;
--   companion           → a conversation_attendance row (2G4) OR a legacy
--                         completion_confirmations 'companion' row.
-- No completion, earning or issue RULES are changed. bookings is unaltered since
-- the view's last definition, so `create or replace ... b.*` only appends columns.
-- The view runs with owner privileges (not security_invoker), so the existence
-- subqueries are correct for either participant.
-- ============================================================
create or replace view public.my_bookings as
select
  b.*,
  pm.first_name as member_first_name,
  left(pm.last_name, 1) as member_last_initial,
  pc.first_name as companion_first_name,
  left(pc.last_name, 1) as companion_last_initial,
  (exists (select 1 from public.conversation_reviews cr where cr.booking_id = b.id)
   or exists (select 1 from public.completion_confirmations cc
              where cc.booking_id = b.id and cc.participant_side = 'member'))
    as member_outcome_submitted,
  (exists (select 1 from public.conversation_attendance ca where ca.booking_id = b.id)
   or exists (select 1 from public.completion_confirmations cc
              where cc.booking_id = b.id and cc.participant_side = 'companion'))
    as companion_outcome_submitted,
  case
    when app_private.can_edit_profile(b.companion_profile_id) then 'companion'
    when b.booked_by_account_id = auth.uid() or app_private.can_act_for_member(b.member_profile_id) then 'member'
    else null
  end as your_side
from public.bookings b
join public.profiles pm on pm.id = b.member_profile_id
join public.profiles pc on pc.id = b.companion_profile_id
where b.booked_by_account_id = auth.uid()
   or app_private.has_profile_access(b.member_profile_id)
   or app_private.has_profile_access(b.companion_profile_id);

select pg_notify('pgrst', 'reload schema');
