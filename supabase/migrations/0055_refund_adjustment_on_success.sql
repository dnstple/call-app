-- ============================================================
-- 2G6C fix — settlement adjustment on refund SUCCESS + missing-PaymentIntent
-- guard (migration 0055).
--
-- Bug 1: request_payment_refund recorded a post-transfer settlement_adjustment
-- immediately whenever the earning was already transferred — even for a card
-- refund still in 'requested', which may later FAIL. A platform-loss adjustment
-- must exist only once the customer remedy actually SUCCEEDS. Fix: adjustment
-- creation moves into the transactional success path (finalize_refund_succeeded,
-- which the worker AND the webhook call). Terminally-succeeded credit-only
-- remedies still record it at request time (they are already 'succeeded').
--
-- Bug 2: an order with card_amount_minor > 0 but a NULL stripe_payment_intent_id
-- (e.g. order fd1b05cb) can never be card-refunded, yet a 'requested' row was
-- created and silently never claimed (the worker filters null PaymentIntents).
-- Fix: request_payment_refund now raises a clear 'missing_payment_identifier'
-- when the card portion has no PaymentIntent. order_refundable_balance is
-- deliberately UNCHANGED — it reports the DATABASE card allocation (what was
-- card-funded), which is distinct from PROVIDER refundability; it must not be
-- silently reduced just because the PaymentIntent is missing.
--
-- Amounts, allocation, worker, webhook and refund state-machine behaviour are
-- otherwise identical to 0052/0053. Additive only.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Idempotent, transferred-only adjustment recorder. Creates exactly one
--    settlement_adjustment per (refund, earning) — and ONLY when the earning was
--    actually transferred. Safe to call from any success path.
-- ------------------------------------------------------------
create or replace function app_private.maybe_record_settlement_adjustment(p_refund uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_rf public.payment_refunds;
  v_e public.companion_earnings;
  v_attempt uuid;
begin
  select * into v_rf from public.payment_refunds where id = p_refund;
  if v_rf.id is null or v_rf.companion_earning_id is null then return; end if;
  select * into v_e from public.companion_earnings where id = v_rf.companion_earning_id;
  if v_e.id is null then return; end if;
  if not ((v_e.transfer_state = 'transferred')
          or exists (select 1 from public.companion_transfer_attempts ta
                     where ta.earning_id = v_e.id and ta.state = 'succeeded')) then
    return; -- not transferred → no platform-loss exposure
  end if;
  select id into v_attempt from public.companion_transfer_attempts
    where earning_id = v_e.id and state = 'succeeded' limit 1;
  insert into public.settlement_adjustments
    (refund_id, companion_earning_id, transfer_attempt_id, companion_account_id, amount_minor)
  values (v_rf.id, v_e.id, v_attempt, v_e.companion_account_id, v_rf.remedy_minor)
  on conflict (refund_id, companion_earning_id) do nothing; -- exactly once
end;
$$;
revoke all on function app_private.maybe_record_settlement_adjustment(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. request_payment_refund — identical to 0053 except: (a) a missing-
--    PaymentIntent guard on the card portion, and (b) the settlement adjustment
--    is recorded ONLY for terminally-succeeded (credit-only) remedies here;
--    card remedies record it on success in finalize_refund_succeeded.
-- ------------------------------------------------------------
create or replace function public.request_payment_refund(
  p_source_kind text, p_source_id uuid, p_remedy_minor integer,
  p_reason text, p_idempotency text
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.payment_orders;
  v_issue public.conversation_issues;
  v_earning public.companion_earnings;
  v_cap integer;
  v_prior_issue_credit integer := 0;
  v_issue_refunded integer := 0;
  v_credit_restorable integer;
  v_card_refundable integer;
  v_credit integer;
  v_card integer;
  v_refund public.payment_refunds;
  v_existing public.payment_refunds;
  v_transferred boolean := false;
  v_reason text;
begin
  if not app_private.is_support_admin() then
    raise exception 'not_found: refund source';
  end if;
  if p_remedy_minor is null or p_remedy_minor < 0 then
    raise exception 'invalid_amounts: remedy must be non-negative';
  end if;
  v_reason := left(trim(coalesce(p_reason, '')), 500);
  if v_reason = '' then
    raise exception 'reason_required: an approved-refund reason is required';
  end if;
  select * into v_existing from public.payment_refunds where idempotency_key = p_idempotency;
  if v_existing.id is not null then
    return jsonb_build_object('ok', true, 'repeat', true, 'refund_id', v_existing.id,
      'state', v_existing.state, 'credit_restore_minor', v_existing.credit_restore_minor,
      'card_refund_minor', v_existing.card_refund_minor);
  end if;

  if p_source_kind = 'order' then
    select * into v_order from public.payment_orders where id = p_source_id for update;
    if v_order.id is null then raise exception 'not_found: refund source'; end if;
    v_cap := v_order.total_minor;
  elsif p_source_kind = 'issue' then
    select * into v_issue from public.conversation_issues where id = p_source_id for update;
    if v_issue.id is null or v_issue.earning_id is null then raise exception 'not_found: refund source'; end if;
    select * into v_earning from public.companion_earnings where id = v_issue.earning_id for update;
    if v_earning.id is null then raise exception 'not_found: refund source'; end if;
    select * into v_order from public.payment_orders where id = v_earning.payment_order_id for update;
    if v_order.id is null then raise exception 'not_found: refund source'; end if;
    v_cap := coalesce(v_earning.payer_charge_minor, v_order.total_minor);
    select coalesce(sum(amount_minor), 0) into v_prior_issue_credit
      from public.credit_ledger
      where source_id = v_issue.id and entry_type = 'credit' and source_type = 'refund_resolution';
    select coalesce(sum(remedy_minor), 0) into v_issue_refunded
      from public.payment_refunds
      where conversation_issue_id = v_issue.id and state <> 'cancelled' and state <> 'failed_permanent';
  else
    raise exception 'invalid_outcome: unknown refund source kind';
  end if;

  if v_order.provider <> 'stripe_test' or v_order.status not in ('succeeded', 'partially_refunded') then
    raise exception 'not_refundable: the order has no settled payment to refund';
  end if;

  v_cap := greatest(v_cap - v_issue_refunded - v_prior_issue_credit, 0);
  select credit_restorable, card_refundable into v_credit_restorable, v_card_refundable
    from app_private.order_refundable_balance(v_order.id);

  if p_remedy_minor > v_cap then
    raise exception 'remedy_exceeds_refundable: over the remaining occurrence/order cap';
  end if;
  if p_remedy_minor > (v_credit_restorable + v_card_refundable) then
    raise exception 'remedy_exceeds_refundable: over the remaining refundable funding';
  end if;

  v_credit := least(p_remedy_minor, v_credit_restorable);
  v_card := p_remedy_minor - v_credit;
  if v_card > v_card_refundable then
    raise exception 'remedy_exceeds_refundable: card portion over the remaining card balance';
  end if;
  -- Provider capability: a card portion needs a real PaymentIntent to refund.
  if v_card > 0 and v_order.stripe_payment_intent_id is null then
    raise exception 'missing_payment_identifier: no Stripe PaymentIntent to refund the card portion';
  end if;

  insert into public.payment_refunds
    (payment_order_id, booking_id, plan_id, plan_billing_period_id, conversation_issue_id,
     companion_earning_id, payer_account_id, remedy_minor, credit_restore_minor, card_refund_minor,
     stripe_payment_intent_id, stripe_charge_id, idempotency_key,
     state, requested_by, reason)
  values
    (v_order.id, v_order.booking_id, v_order.plan_id, v_earning.plan_billing_period_id, v_issue.id,
     v_earning.id, v_order.coordinator_account_id, p_remedy_minor, v_credit, v_card,
     v_order.stripe_payment_intent_id, null, p_idempotency,
     case when v_card = 0 then 'succeeded' else 'requested' end, auth.uid(), v_reason)
  returning * into v_refund;

  if v_credit > 0 then
    perform public.issue_account_credit(
      v_order.coordinator_account_id, v_credit, 'payment_restoration', v_refund.id,
      'Refund: original account credit restored', 'refund-credit-' || v_refund.id::text);
  end if;

  -- Post-transfer exposure flag (informational only in the return).
  if v_earning.id is not null then
    v_transferred := (v_earning.transfer_state = 'transferred')
      or exists (select 1 from public.companion_transfer_attempts ta
                 where ta.earning_id = v_earning.id and ta.state = 'succeeded');
  end if;

  -- A zero-card remedy is terminally SUCCEEDED now → notify + (only if
  -- transferred) record the adjustment. A card remedy stays 'requested' and its
  -- adjustment, if any, is recorded on success in finalize_refund_succeeded.
  if v_card = 0 then
    update public.payment_refunds set completed_at = now(), updated_at = now() where id = v_refund.id;
    perform app_private.notify_account(
      v_order.coordinator_account_id, 'refund_processed', 'Account credit restored',
      'Account credit has been restored to your account.',
      v_order.booking_id, 'refund-credit-done:' || v_refund.id::text);
    perform app_private.maybe_record_settlement_adjustment(v_refund.id);
  end if;

  return jsonb_build_object('ok', true, 'refund_id', v_refund.id, 'state', v_refund.state,
    'credit_restore_minor', v_credit, 'card_refund_minor', v_card,
    'settlement_adjustment', v_transferred);
end;
$$;
revoke all on function public.request_payment_refund(text, uuid, integer, text, text) from public, anon;
grant execute on function public.request_payment_refund(text, uuid, integer, text, text) to authenticated;

-- ------------------------------------------------------------
-- 3. finalize_refund_succeeded — identical to 0052 plus recording the
--    post-transfer settlement adjustment on ACTUAL success (idempotent; the
--    top-of-function 'succeeded' guard means it runs at most once, and the
--    unique (refund, earning) index is belt-and-braces). Called by both the
--    worker and the webhook.
-- ------------------------------------------------------------
create or replace function public.finalize_refund_succeeded(
  p_refund uuid, p_stripe_refund_id text, p_charge_id text default null
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_rf public.payment_refunds;
  v_paid integer;
begin
  select * into v_rf from public.payment_refunds where id = p_refund for update;
  if v_rf.id is null or v_rf.state = 'succeeded' then return; end if; -- idempotent
  update public.payment_refunds
     set state = 'succeeded',
         stripe_refund_id = coalesce(stripe_refund_id, p_stripe_refund_id),
         stripe_charge_id = coalesce(stripe_charge_id, p_charge_id),
         failure_code = null, failure_message = null, completed_at = now(), updated_at = now()
   where id = p_refund;
  select coalesce(sum(card_refund_minor), 0) into v_paid from public.payment_refunds
   where payment_order_id = v_rf.payment_order_id and state = 'succeeded';
  update public.payment_orders o
     set status = case when v_paid >= o.card_amount_minor and o.card_amount_minor > 0
                       then 'refunded' else 'partially_refunded' end,
         updated_at = now()
   where o.id = v_rf.payment_order_id and o.status in ('succeeded', 'partially_refunded');
  perform app_private.notify_account(
    v_rf.payer_account_id, 'refund_processed', 'Refund processed',
    'Your refund has been processed to your original payment method.',
    v_rf.booking_id, 'refund-done:' || v_rf.id::text);
  -- Record the platform-loss adjustment ONLY now that the refund truly succeeded.
  perform app_private.maybe_record_settlement_adjustment(p_refund);
end;
$$;
revoke all on function public.finalize_refund_succeeded(uuid, text, text) from public, anon, authenticated;
grant execute on function public.finalize_refund_succeeded(uuid, text, text) to service_role;

select pg_notify('pgrst', 'reload schema');
