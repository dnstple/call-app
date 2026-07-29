-- ============================================================================
-- 0082 — superseded/foreign-intent containment in reconcile_payment_order.
-- ============================================================================
-- Stage 3D-D live validation (scenario M3, off-session SCA) exposed a
-- launch-blocking finalisation defect:
--
--   When a saved card needs off-session authentication, stripe-payments creates
--   an off-session PaymentIntent that carries metadata.payment_order_id, Stripe
--   rejects it with `authentication_required`, and the app opens a HOSTED
--   Checkout Session for the same order. The superseded off-session intent is
--   still metadata-linked to the order, so when Stripe later fires its
--   `payment_intent.canceled` / `payment_intent.payment_failed`, the webhook
--   maps that event back to the order and calls reconcile_payment_order with a
--   FAILED/CANCELED provider status. The failed/canceled branch had NO
--   intent-authority check, so it marked the order `failed` and released the
--   reservation — beating the hosted Checkout success. When the genuine success
--   then arrived, the order was already terminal, so the status-guarded
--   finalise could not advance it (`finalise_incomplete`): the customer was
--   charged but left stuck in "manual confirmation check".
--
-- Fix (additive, single branch): a terminal FAILURE/CANCEL event may only fail
-- an order when it carries the order's AUTHORITATIVE stored intent. A foreign /
-- superseded intent's terminal event is a benign no-op. The genuine hosted
-- intent's failure still matches the stored intent and still fails the order
-- (scenario M4 is unaffected). The success path already enforced the symmetric
-- `intent_mismatch` guard (0080 l.219-230); this closes the same gap on the
-- failure side. Nothing else in the row-locked, idempotent finaliser changes.
--
-- The companion stripe-payments change records the hosted SCA session's
-- PaymentIntent (and session id) as the order's authoritative funding BEFORE
-- returning, so the guard below always has the correct intent to compare.
-- ----------------------------------------------------------------------------

create or replace function app_private.reconcile_payment_order(
  p_order uuid, p_intent text, p_provider_status text,
  p_amount_minor bigint, p_currency text, p_event_at timestamptz,
  p_metadata_order uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.payment_orders;
  v_status text;
  v_already boolean;
begin
  select * into v from public.payment_orders where id = p_order for update;
  if v.id is null then
    return jsonb_build_object('ok', false, 'reason', 'order_not_found');
  end if;

  -- Expected-intent verification: a stored intent id is authoritative. A
  -- different intent NEVER finalises this order.
  if p_intent is not null and v.stripe_payment_intent_id is not null
     and v.stripe_payment_intent_id <> p_intent then
    -- 0082 SUPERSEDED/FOREIGN-INTENT CONTAINMENT. During an off-session SCA
    -- handoff the superseded off-session PaymentIntent is still metadata-linked
    -- to this order; when it later goes canceled/failed the webhook maps that
    -- event back here with a FOREIGN intent id. A foreign TERMINAL FAILURE
    -- carries no financial signal about the order's authoritative funding (the
    -- hosted Checkout session's intent, recorded before the handoff), so it is
    -- a benign no-op — never a failure and never a reconciliation flag. Without
    -- this, the stale cancel raced ahead of the hosted success and left the
    -- customer charged but stuck ('finalise_incomplete').
    if p_provider_status in ('failed', 'canceled') then
      return jsonb_build_object('ok', true, 'ignored', 'foreign_intent_terminal',
                                'order_id', v.id);
    end if;
    -- Any OTHER foreign event (e.g. a second intent reporting success) is a
    -- genuine reconciliation concern: two funding sources for one order.
    update public.payment_orders
       set local_finalisation_status = 'reconciliation_required',
           reconciliation_code = 'intent_mismatch',
           last_reconciliation_at = now(), updated_at = now()
     where id = p_order
       and status not in ('succeeded', 'credited', 'partially_refunded', 'refunded', 'disputed');
    return jsonb_build_object('ok', false, 'reason', 'intent_mismatch', 'order_id', v.id);
  end if;

  -- Metadata/ownership linkage: when the provider object's recorded order
  -- linkage is known and points at a DIFFERENT purchase, never finalise.
  if p_metadata_order is not null and p_metadata_order <> p_order then
    update public.payment_orders
       set local_finalisation_status = 'reconciliation_required',
           reconciliation_code = 'metadata_mismatch',
           last_reconciliation_at = now(), updated_at = now()
     where id = p_order
       and status not in ('succeeded', 'credited', 'partially_refunded', 'refunded', 'disputed');
    return jsonb_build_object('ok', false, 'reason', 'metadata_mismatch', 'order_id', v.id);
  end if;

  v_status := case when p_provider_status in
      ('requires_payment_method', 'requires_confirmation', 'requires_action',
       'processing', 'succeeded', 'failed', 'canceled')
    then p_provider_status else 'unknown' end;

  -- Projection (always safe; never regresses a terminal local state).
  update public.payment_orders
     set provider_payment_status = v_status,
         provider_synced_at = now(),
         provider_event_at = coalesce(p_event_at, provider_event_at),
         updated_at = now()
   where id = p_order;

  v_already := v.status in ('succeeded', 'credited', 'partially_refunded', 'refunded', 'disputed');

  if v_status = 'succeeded' then
    -- Amount and currency must match the local snapshot EXACTLY.
    if p_amount_minor is not null and p_amount_minor <> v.card_amount_minor then
      update public.payment_orders
         set local_finalisation_status = 'reconciliation_required',
             reconciliation_code = 'amount_mismatch',
             last_reconciliation_at = now(), updated_at = now()
       where id = p_order and not v_already;
      return jsonb_build_object('ok', false, 'reason', 'amount_mismatch', 'order_id', v.id);
    end if;
    if p_currency is not null and upper(p_currency) <> 'GBP' then
      update public.payment_orders
         set local_finalisation_status = 'reconciliation_required',
             reconciliation_code = 'currency_mismatch',
             last_reconciliation_at = now(), updated_at = now()
       where id = p_order and not v_already;
      return jsonb_build_object('ok', false, 'reason', 'currency_mismatch', 'order_id', v.id);
    end if;

    if v_already then
      -- Idempotent repeat: settle the projection, change nothing financial.
      update public.payment_orders
         set local_finalisation_status = 'completed',
             finalised_at = coalesce(finalised_at, now()),
             reconciliation_code = null,
             updated_at = now()
       where id = p_order;
      return jsonb_build_object('ok', true, 'already_finalised', true, 'order_id', v.id);
    end if;

    update public.payment_orders
       set local_finalisation_status = 'finalising', updated_at = now()
     where id = p_order;
    begin
      perform app_private.finalise_paid_order(p_order, 'succeeded', p_intent);
    exception when others then
      update public.payment_orders
         set local_finalisation_status = 'reconciliation_required',
             reconciliation_code = 'finalise_error',
             last_reconciliation_at = now(), updated_at = now()
       where id = p_order;
      return jsonb_build_object('ok', false, 'reason', 'finalise_error', 'order_id', v.id);
    end;
    select * into v from public.payment_orders where id = p_order;
    if v.status in ('succeeded', 'credited', 'partially_refunded', 'refunded', 'disputed') then
      update public.payment_orders
         set local_finalisation_status = 'completed',
             finalised_at = coalesce(finalised_at, now()),
             reconciliation_code = null, updated_at = now()
       where id = p_order;
      return jsonb_build_object('ok', true, 'finalised', true, 'order_id', v.id,
                                'booking_id', v.booking_id);
    end if;
    -- Provider success but the guarded finaliser would not settle (e.g. the
    -- order had already expired locally): never guess — flag it.
    update public.payment_orders
       set local_finalisation_status = 'reconciliation_required',
           reconciliation_code = 'finalise_incomplete',
           last_reconciliation_at = now(), updated_at = now()
     where id = p_order;
    return jsonb_build_object('ok', false, 'reason', 'finalise_incomplete', 'order_id', v.id);
  end if;

  if v_status in ('failed', 'canceled') then
    -- Any locally terminal order repeats idempotently (success-family AND
    -- failed/expired): nothing financial may run twice.
    if v_already or v.status in ('failed', 'expired') then
      return jsonb_build_object('ok', true, 'already_finalised', true, 'order_id', v.id);
    end if;
    -- A foreign/superseded intent's terminal failure was already contained by
    -- the intent-authority guard at the top of this function; any failure that
    -- reaches here is the order's AUTHORITATIVE intent (or an order with no
    -- stored intent), so the existing failure semantics apply unchanged.
    -- Existing failure semantics (credit released exactly once inside).
    perform app_private.finalise_paid_order(
      p_order,
      case when v_status = 'canceled' then 'payment_cancelled' else 'failed' end,
      p_intent);
    update public.payment_orders
       set local_finalisation_status = 'completed',
           finalised_at = coalesce(finalised_at, now()), updated_at = now()
     where id = p_order;
    return jsonb_build_object('ok', true, 'failed', true, 'order_id', v.id);
  end if;

  -- Non-terminal provider states: projection only.
  select * into v from public.payment_orders where id = p_order;
  return jsonb_build_object('ok', true, 'projected', true, 'order_id', v.id,
    'customer_status', app_private.payment_order_customer_status(v));
end;
$$;
revoke all on function app_private.reconcile_payment_order(uuid, text, text, bigint, text, timestamptz, uuid)
  from public, anon, authenticated;
