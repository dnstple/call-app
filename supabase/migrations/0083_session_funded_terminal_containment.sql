-- ============================================================================
-- 0083 — session-funded terminal containment (completes the 0082 fix).
-- ============================================================================
-- The second hosted M3 run (order 28fb2dde) proved 0082's guard insufficient:
-- on current Stripe API versions a payment-mode Checkout Session does NOT
-- create its PaymentIntent at session-creation time — session.payment_intent
-- is null until the customer completes payment. So the Edge function stored
-- stripe_checkout_session_id but stripe_payment_intent_id stayed NULL, the
-- 0082 intent-authority guard (which requires a stored intent to compare) never
-- engaged, and the superseded off-session intent's cancel again failed the
-- order ahead of the hosted success -> finalise_incomplete, customer charged,
-- no booking.
--
-- Correct rule, which needs no intent at creation time: once a hosted Checkout
-- Session is recorded on the order, HOSTED FUNDING IS AUTHORITATIVE. From that
-- moment a terminal (failed/canceled) intent event may fail the order ONLY if
-- it carries the order's stored authoritative intent — which only exists after
-- the session completes (checkout.session.completed stores it via the
-- finaliser's coalesce). Any other terminal intent event against a
-- session-funded order is a superseded/foreign attempt: a benign no-op.
--
-- Failure paths that remain fully intact for session-funded orders:
--   * genuine post-completion failure: carries the stored intent -> matches;
--   * customer cancellation / abandonment: the order fails through the expiry
--     path (finalise_paid_order 'expired'/'failed'), which never runs through
--     this reconcile branch;
--   * card-declined non-SCA orders (no session stored): unchanged.
-- Success, mismatch (amount/currency/metadata/foreign-success) and idempotency
-- semantics are byte-identical to 0082. finalise_paid_order is untouched.
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
    -- 0082: a foreign TERMINAL FAILURE carries no financial signal about the
    -- order's authoritative funding — benign no-op, never a failure or a flag.
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

  -- 0083 SESSION-FUNDED CONTAINMENT (before ANY projection): once a hosted
  -- Checkout Session is recorded, hosted funding is authoritative. A terminal
  -- intent event may touch this order ONLY when it carries the stored
  -- authoritative intent (which exists only after session completion — Stripe
  -- creates the session's PaymentIntent at completion, so it is NULL during
  -- the authentication window). The superseded off-session intent's cancel —
  -- and any other foreign terminal event — carries no signal about this
  -- order's real funding: it must not fail the order, must not flag it, and
  -- must not even project a provider state. Cancellation/abandonment fails
  -- through the expiry path instead, which never runs through this branch.
  if p_provider_status in ('failed', 'canceled')
     and v.stripe_checkout_session_id is not null
     and (v.stripe_payment_intent_id is null
          or p_intent is null
          or p_intent <> v.stripe_payment_intent_id) then
    return jsonb_build_object('ok', true, 'ignored', 'session_funded_foreign_terminal',
                              'order_id', v.id);
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
    -- (Foreign/superseded terminal events were already contained by the
    -- session-funded and intent-authority guards at the top of this function;
    -- any failure reaching here is the order's authoritative funding.)
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
