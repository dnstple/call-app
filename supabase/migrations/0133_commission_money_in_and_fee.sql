-- 0133 — New commission model, part 1: money-in + actual-fee recording.
--
-- Changes (additive to 0132's calculation core):
--   * quote/create no longer add a customer service fee — the customer pays
--     EXACTLY the Companion's price (total_minor = subtotal_minor). The Stripe
--     fee comes out of the split, not off the customer.
--   * the order snapshots the commission RATE (bps) at creation, and marks the
--     fee calculation pending until the real Stripe fee is known.
--   * record_payment_processing_fee(order, charge, balance_txn, fee) — called by
--     the webhook once the balance transaction is available — computes and
--     snapshots the authoritative split via app_private.compute_commission. It is
--     idempotent: repeated deliveries never rewrite a recorded snapshot.
--   * credit-only orders (no Stripe charge) record a fee of 0 immediately.
--
-- The payout pipeline (earnings/transfers) is rewired in a following migration.
-- Historical rows are untouched: they keep service_fee_minor/commission_minor.

set search_path = '';

-- ---------- quote: price only, snapshot rate ----------
create or replace function public.quote_paid_request(p_member uuid, p_companion uuid, p_offer uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_offer public.conversation_offers;
  v_type text;
  v_subtotal integer;
  v_credit integer;
  v_bps integer;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  if not exists (
    select 1 from public.profile_access pa
    where pa.profile_id = p_member and pa.account_id = auth.uid()
      and pa.can_book and pa.consent_status <> 'withdrawn'
  ) then raise exception 'not_found: member'; end if;
  select * into v_offer from public.conversation_offers
   where id = p_offer and companion_profile_id = p_companion and active;
  if v_offer.id is null then raise exception 'not_found: offer'; end if;

  v_type := case when v_offer.offer_type = 'trial' then 'trial' else 'one_off' end;
  v_subtotal := v_offer.price_minor;
  if v_type = 'trial' and exists (
      select 1 from public.payment_orders
       where member_profile_id = p_member and companion_profile_id = p_companion
         and order_type = 'trial' and status not in ('failed', 'expired')) then
    raise exception 'not_eligible: this Member has already had a trial with this Companion';
  end if;

  v_bps := app_private.commission_bps(v_type = 'trial');
  select coalesce(sum(remaining_minor), 0)::integer into v_credit
    from public.credit_ledger
   where coordinator_account_id = auth.uid() and entry_type = 'credit'
     and remaining_minor > 0 and expires_at > now();

  return jsonb_build_object(
    'type', v_type, 'currency', 'GBP',
    'subtotal_minor', v_subtotal, 'discount_minor', 0,
    'service_fee_minor', 0, 'trial_fee_waived', false,
    'total_minor', v_subtotal,
    'credit_applied_minor', least(v_credit, v_subtotal),
    'card_amount_minor', greatest(0, v_subtotal - v_credit),
    'commission_rate_bps', v_bps,
    'commission_rate_pct', round(v_bps / 100.0, 2),
    'duration_minutes', v_offer.duration_minutes);
end;
$$;
revoke all on function public.quote_paid_request(uuid, uuid, uuid) from public, anon;
grant execute on function public.quote_paid_request(uuid, uuid, uuid) to authenticated;

-- ---------- record the ACTUAL Stripe fee and snapshot the split ----------
create or replace function app_private.record_payment_processing_fee(
  p_order uuid, p_charge text, p_balance_txn text, p_fee_pence integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order public.payment_orders; v_calc jsonb;
begin
  select * into v_order from public.payment_orders where id = p_order for update;
  if v_order.id is null then raise exception 'order_not_found'; end if;
  -- Idempotent: a recorded snapshot is immutable.
  if v_order.fee_calculation_status = 'recorded' then
    return jsonb_build_object('ok', true, 'already_recorded', true,
      'companion_earnings_pence', v_order.companion_earnings_pence);
  end if;
  if p_fee_pence is null or p_fee_pence < 0 or p_fee_pence > v_order.subtotal_minor then
    raise exception 'invalid_fee';
  end if;

  -- gross = the full price the customer paid (credit + card). The Stripe fee is
  -- only ever incurred on the card portion; credit-only orders pass fee = 0.
  v_calc := app_private.compute_commission(v_order.subtotal_minor, p_fee_pence, v_order.order_type = 'trial');

  update public.payment_orders set
    stripe_fee_pence              = p_fee_pence,
    net_after_stripe_pence        = (v_calc->>'net_after_stripe_pence')::integer,
    commission_rate_bps           = (v_calc->>'commission_rate_bps')::integer,
    commission_amount_pence       = (v_calc->>'commission_amount_pence')::integer,
    companion_earnings_pence      = (v_calc->>'companion_earnings_pence')::integer,
    stripe_charge_id              = coalesce(p_charge, stripe_charge_id),
    stripe_balance_transaction_id = coalesce(p_balance_txn, stripe_balance_transaction_id),
    fee_calculation_status        = 'recorded',
    commission_calculated_at      = now(),
    updated_at                    = now()
  where id = p_order;

  return jsonb_build_object('ok', true,
    'companion_earnings_pence', (v_calc->>'companion_earnings_pence')::integer,
    'commission_amount_pence', (v_calc->>'commission_amount_pence')::integer);
end;
$$;
revoke all on function app_private.record_payment_processing_fee(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function app_private.record_payment_processing_fee(uuid, text, text, integer) to service_role;

-- ---------- create the order (price only; rate snapshotted; fee pending) ----------
create or replace function public.create_paid_request(
  p_member uuid, p_companion uuid, p_offer uuid,
  p_starts_at timestamptz, p_idempotency text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_quote jsonb; v_order public.payment_orders; v_applied integer;
begin
  select * into v_order from public.payment_orders where idempotency_key = p_idempotency;
  if v_order.id is not null then
    return jsonb_build_object('order_id', v_order.id, 'status', v_order.status,
      'card_amount_minor', v_order.card_amount_minor);
  end if;

  v_quote := public.quote_paid_request(p_member, p_companion, p_offer);
  if p_starts_at is null or p_starts_at < now() then
    raise exception 'invalid_slot: choose a future time';
  end if;

  insert into public.payment_orders
    (coordinator_account_id, member_profile_id, companion_profile_id,
     order_type, status, subtotal_minor, discount_minor, service_fee_minor,
     credit_applied_minor, card_amount_minor, total_minor,
     commission_rate_pct, commission_minor, commission_rate_bps, fee_calculation_status,
     offer_id, starts_at, duration_minutes, idempotency_key, expires_at)
  values
    (auth.uid(), p_member, p_companion,
     v_quote->>'type', 'pending',
     (v_quote->>'subtotal_minor')::integer, 0, 0,
     (v_quote->>'credit_applied_minor')::integer, (v_quote->>'card_amount_minor')::integer,
     (v_quote->>'total_minor')::integer,
     (v_quote->>'commission_rate_pct')::numeric, 0,
     (v_quote->>'commission_rate_bps')::integer, 'pending',
     p_offer, p_starts_at, (v_quote->>'duration_minutes')::integer,
     p_idempotency, now() + interval '30 minutes')
  returning * into v_order;

  if v_order.credit_applied_minor > 0 then
    v_applied := public.spend_account_credit(
      auth.uid(), v_order.credit_applied_minor,
      case when v_order.order_type = 'trial' then 'trial_purchase' else 'one_off_purchase' end,
      v_order.id, v_order.id, 'Reserved for conversation request', 'spend-' || v_order.id::text);
    if v_applied < v_order.credit_applied_minor then
      update public.payment_orders
         set credit_applied_minor = v_applied, card_amount_minor = total_minor - v_applied
       where id = v_order.id returning * into v_order;
    end if;
  end if;

  -- Credit fully covers the purchase → no Stripe charge, so the processing fee
  -- is 0 and the split can be recorded immediately.
  if v_order.card_amount_minor = 0 then
    perform app_private.finalise_paid_order(v_order.id, 'succeeded', null);
    perform app_private.record_payment_processing_fee(v_order.id, null, null, 0);
    select * into v_order from public.payment_orders where id = v_order.id;
  end if;

  return jsonb_build_object('order_id', v_order.id, 'status', v_order.status,
    'card_amount_minor', v_order.card_amount_minor);
end;
$$;
revoke all on function public.create_paid_request(uuid, uuid, uuid, timestamptz, text) from public, anon;
grant execute on function public.create_paid_request(uuid, uuid, uuid, timestamptz, text) to authenticated;

select pg_notify('pgrst', 'reload schema');
