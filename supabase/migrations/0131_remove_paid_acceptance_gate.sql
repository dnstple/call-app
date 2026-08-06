-- 0131 — Remove the paid-acceptance payout gate.
--
-- Current, approved design (see BookingDetail "held payout" model): a Companion
-- MAY accept a paid conversation without a live payout account. The earning is
-- created and simply HELD (transfer_state 'not_ready') until they connect their
-- payout account, at which point app_private.companion_payments_ready gates the
-- ACTUAL transfer. Migration 0033's gate_paid_acceptance trigger instead blocked
-- the requested→confirmed transition outright ("not_ready: set up payments
-- before accepting paid conversations"), contradicting that design and
-- stranding Companions who hadn't yet onboarded.
--
-- Remove the trigger and its function. Payout SAFETY is unchanged: no money can
-- move to a Companion until companion_payments_ready is true at transfer time.
-- Additive; apply after 0130.

set search_path = '';

drop trigger if exists bookings_paid_acceptance_gate on public.bookings;
drop function if exists app_private.gate_paid_acceptance();

select pg_notify('pgrst', 'reload schema');
