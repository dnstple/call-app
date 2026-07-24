-- ============================================================================
-- 0081 — sustain the durable customer-payment projection on finalisation.
-- ============================================================================
-- Stage 3D-D live validation (scenario M1, credit-only trial) proved a gap
-- 0080 left open: 0080 BACKFILLED historical rows so every terminal order
-- carried local_finalisation_status='completed' (and a safe-minimum
-- provider_payment_status), but nothing MAINTAINS that invariant for orders
-- finalised AFTER 0080.
--
--   * CARD orders are finalised by the webhook through
--     app_private.reconcile_payment_order, which already sets the projection
--     (finalising -> completed / reconciliation_required). They are correct.
--   * CREDIT-ONLY orders are finalised SYNCHRONOUSLY inside create_paid_request
--     via public.finalize_paid_order (0043), which flips status='succeeded'
--     (and booking_id) but never touches the projection columns. The order is
--     genuinely, idempotently complete, yet the durable columns stay at their
--     defaults (local='pending', provider='unknown').
--
-- Consequence (pre-0081): a succeeded credit-only order is derived correctly
-- for the customer (app_private.payment_order_customer_status short-circuits
-- on the terminal legacy status) and never enters the pending-paid support
-- queue (provider <> 'succeeded'), so there is no customer-facing or financial
-- defect. But the durable projection — the stated purpose of Stage 3D — is not
-- authoritative for these rows, and monitoring/support reading the raw columns
-- would be misled.
--
-- This migration is PURELY ADDITIVE and touches only the two projection
-- columns (plus finalised_at). It does NOT alter finalize_paid_order,
-- reconcile_payment_order, the booking/credit model, or the validated
-- exactly-once core. A BEFORE trigger fires ONLY when a row reaches a terminal
-- status while local_finalisation_status is still at its 'pending' default —
-- the state reconcile always moves off first — so the card/webhook path is
-- never affected, and reconciliation_required rows (status still non-terminal)
-- are never touched. The derivation mirrors the 0080 backfill exactly.
-- ----------------------------------------------------------------------------

create or replace function app_private.maintain_payment_order_projection()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Only sustain the projection for a row that has just reached a terminal
  -- legacy status while its durable finalisation is still at the default.
  -- reconcile_payment_order always advances local_finalisation_status off
  -- 'pending' (to 'finalising' / 'completed' / 'reconciliation_required')
  -- before any terminal flip, so this guard makes the trigger inert on the
  -- card/webhook path and active only on the synchronous finaliser path.
  if new.local_finalisation_status = 'pending'
     and new.status in ('succeeded', 'failed', 'expired', 'credited',
                        'partially_refunded', 'refunded', 'disputed') then
    new.local_finalisation_status := 'completed';
    new.finalised_at := coalesce(new.finalised_at, now());
    -- SAFE-MINIMUM PROVIDER RULE, identical to the 0080 backfill: assert a
    -- provider state only where provider evidence exists.
    new.provider_payment_status := case
      when new.card_amount_minor = 0 then 'none'
      when new.stripe_payment_intent_id is null
       and new.stripe_checkout_session_id is null then 'unknown'
      when new.status in ('succeeded', 'credited', 'partially_refunded',
                          'refunded', 'disputed') then 'succeeded'
      when new.status = 'failed' then 'failed'
      else 'unknown' end;
  end if;
  return new;
end;
$$;

revoke all on function app_private.maintain_payment_order_projection() from public, anon, authenticated;

drop trigger if exists trg_maintain_payment_order_projection on public.payment_orders;
create trigger trg_maintain_payment_order_projection
  before insert or update on public.payment_orders
  for each row
  execute function app_private.maintain_payment_order_projection();

-- One-time repair for any credit-only order created between 0080 and 0081
-- (e.g. the Stage 3D-D M1 validation order): re-assert the invariant the
-- trigger now maintains going forward. Identical predicate/derivation to the
-- 0080 backfill; safe and idempotent.
update public.payment_orders
   set local_finalisation_status = 'completed',
       finalised_at = coalesce(finalised_at, updated_at),
       provider_payment_status = case
         when card_amount_minor = 0 then 'none'
         when stripe_payment_intent_id is null
          and stripe_checkout_session_id is null then 'unknown'
         when status in ('succeeded', 'credited', 'partially_refunded',
                         'refunded', 'disputed') then 'succeeded'
         when status = 'failed' then 'failed'
         else 'unknown' end
 where local_finalisation_status = 'pending'
   and status in ('succeeded', 'failed', 'expired', 'credited',
                  'partially_refunded', 'refunded', 'disputed');
