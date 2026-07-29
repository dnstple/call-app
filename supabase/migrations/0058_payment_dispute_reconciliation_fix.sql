-- ============================================================
-- 2G6D reconciliation fix (migration 0058) — additive; 0056 and 0057 are
-- immutable and already applied hosted.
--
-- Defect (hosted): reconcile_unresolved_dispute did not persist payment_order_id
-- for a dispute that was originally recorded before its order existed.
--
-- Root cause: 0057's reconcile updated the stored identifiers with
--   stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent)
-- i.e. the ORIGINAL value wins. A genuinely unmapped dispute was recorded with a
-- PaymentIntent that matched no order; coalesce therefore KEPT that stale, non-
-- matching identifier and discarded the corrected one supplied at reconcile time.
-- app_private.map_and_hold_dispute then looked the order up by the stale PI, found
-- nothing, and returned without mapping — so payment_order_id stayed null even
-- though the matching order now existed.
--
-- Fix: reconcile is an explicit RE-resolution. It must prefer the identifiers
-- supplied at reconcile time (they are the correction), falling back to the stored
-- ones only when the caller supplies null. It then runs the SAME deterministic
-- map/allocate/hold helper (PaymentIntent first, charge fallback only if needed),
-- RE-SELECTS the dispute after that helper writes, advances internal_state only
-- once actually mapped, and returns a clear result: mapped / already_mapped /
-- still_unresolved. It never accepts client-supplied order ids or monetary values.
--
-- The result type changes (void -> text), so the function is dropped and
-- recreated. No table, index, constraint, or historical row is touched.
-- ============================================================

drop function if exists public.reconcile_unresolved_dispute(text, text, text);

create or replace function public.reconcile_unresolved_dispute(
  p_stripe_dispute_id text, p_payment_intent text, p_charge text
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_d public.payment_disputes;
  v_order uuid;
begin
  -- Lock the dispute row for the duration of the reconciliation.
  select * into v_d from public.payment_disputes
    where stripe_dispute_id = p_stripe_dispute_id for update;
  if v_d.id is null then return 'still_unresolved'; end if;

  -- Idempotent: an already-mapped dispute is never re-touched. No allocations,
  -- holds, status changes, or identifier rewrites happen on a repeat call.
  if v_d.payment_order_id is not null then return 'already_mapped'; end if;

  -- Adopt the identifiers supplied at reconcile time (the correction), keeping the
  -- stored value only when the caller supplies null. Stripe identifiers only —
  -- order ids and amounts are never accepted from the caller.
  update public.payment_disputes
     set stripe_payment_intent_id = coalesce(p_payment_intent, stripe_payment_intent_id),
         stripe_charge_id = coalesce(p_charge, stripe_charge_id),
         updated_at = now()
   where id = v_d.id;

  -- Deterministic mapping + allocation + holds: resolves by PaymentIntent first,
  -- charge fallback only if necessary; snapshots/marks the order status the same
  -- way the normal creation path does. This helper writes payment_order_id.
  perform app_private.map_and_hold_dispute(v_d.id);

  -- Re-select AFTER the helper wrote, rather than trusting the stale local row.
  select payment_order_id into v_order from public.payment_disputes where id = v_d.id;
  if v_order is null then
    return 'still_unresolved'; -- genuinely unmatched; remains stored + unresolved
  end if;

  -- Now mapped: advance internal_state from the raw provider status, never moving a
  -- terminal outcome backwards.
  update public.payment_disputes
     set internal_state = app_private.dispute_internal_state(provider_status), updated_at = now()
   where id = v_d.id
     and internal_state not in ('won', 'lost', 'closed_warning');

  return 'mapped';
end;
$$;
revoke all on function public.reconcile_unresolved_dispute(text, text, text) from public, anon, authenticated;
grant execute on function public.reconcile_unresolved_dispute(text, text, text) to service_role;

select pg_notify('pgrst', 'reload schema');
