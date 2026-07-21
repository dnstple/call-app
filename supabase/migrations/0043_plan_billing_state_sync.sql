-- ============================================================
-- 2G5B state synchronisation — payment_orders ↔ plan_billing_periods (0043).
--
-- A hosted test exposed an inconsistent terminal state: a plan_period order in
-- 'failed' while its billing period stayed 'payment_pending'. Two defects:
--   1. The stripe-billing Edge Function moved the order/period across separate,
--      non-transactional statements and finalise_paid_order had no
--      requires_action branch (so authentication_required was mis-terminalised).
--   2. renew_plan_billing_period / process_plan_renewals did NOT treat
--      'payment_failed' as terminal, so a failed period was re-priced and its
--      status flipped back to 'payment_pending' while the order stayed 'failed'.
--
-- This migration makes ONE transactional RPC the single authority for every
-- plan_period terminal/intermediate transition, keeps order + period in lockstep
-- per the required state map, treats payment_failed as terminal, and repairs
-- existing inconsistent rows. The successful allowance grant, credit-first
-- pricing, funding-mode and booking-generation safeguards are unchanged.
--
-- State map (order ↔ period):
--   pending          ↔ payment_pending      (retryable; charge_due target)
--   processing       ↔ processing
--   requires_action  ↔ action_required      (recoverable; credit retained)
--   failed           ↔ payment_failed       (terminal; credit released once)
--   succeeded        ↔ paid                 (grant occurrences once)
-- Safe failure codes: payment_method_missing, stripe_customer_missing,
--   card_declined, authentication_required, payment_cancelled, provider_error.
-- Raw card details, PaymentIntent client secrets and Stripe error objects are
-- never stored.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Single authority for plan_period state transitions.
--    p_outcome ∈ { succeeded, processing, authentication_required,
--                  payment_method_missing, stripe_customer_missing,
--                  card_declined, payment_cancelled, failed, expired,
--                  provider_error }.
--    Idempotent: once the order is terminal (succeeded/failed/expired/…),
--    every repeat is a no-op — so credit is released at most once, allowance
--    is granted at most once, and each notification is deduplicated.
-- ------------------------------------------------------------
create or replace function app_private.settle_plan_billing_order(
  p_order uuid, p_outcome text, p_intent text default null, p_reason text default null
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.payment_orders;
  v_bp public.plan_billing_periods;
  v_code text;
begin
  select * into v_order from public.payment_orders where id = p_order for update;
  if v_order.id is null or v_order.order_type <> 'plan_period' then return; end if;
  -- Only in-flight orders can transition; terminal orders are a safe no-op.
  if v_order.status not in ('pending', 'requires_action', 'processing') then return; end if;

  select * into v_bp from public.plan_billing_periods where payment_order_id = p_order for update;

  -- ---------------- SUCCESS: order succeeded ↔ period paid ----------------
  if p_outcome = 'succeeded' then
    update public.payment_orders
       set status = 'succeeded', failure_reason = null,
           stripe_payment_intent_id = coalesce(p_intent, stripe_payment_intent_id),
           updated_at = now()
     where id = p_order;
    -- Grant EXACTLY occurrences_count, once (guarded by the order-keyed reason).
    if v_bp.id is not null and v_bp.occurrences_count > 0
       and not exists (select 1 from public.package_credit_ledger
                       where package_purchase_id = v_bp.allowance_purchase_id
                         and reason = 'plan-billing:' || p_order::text) then
      insert into public.package_credit_ledger
        (package_purchase_id, entry_type, quantity, created_by_account_id, reason)
      values (v_bp.allowance_purchase_id, 'grant', v_bp.occurrences_count,
              v_order.coordinator_account_id, 'plan-billing:' || p_order::text);
    end if;
    if v_bp.id is not null then
      update public.plan_billing_periods
         set status = 'paid', failure_reason = null,
             allowance_credits_granted = occurrences_count, updated_at = now()
       where id = v_bp.id;
    end if;
    perform app_private.notify_account(
      v_order.coordinator_account_id, 'plan_billed', 'Plan payment received',
      'This month’s plan conversations are funded and ready to schedule.',
      null, 'plan-billed:' || p_order::text);
    return;
  end if;

  -- ---------------- INTERMEDIATE: order processing ↔ period processing ----------------
  if p_outcome = 'processing' then
    update public.payment_orders set status = 'processing', updated_at = now() where id = p_order;
    if v_bp.id is not null then
      update public.plan_billing_periods set status = 'processing', updated_at = now() where id = v_bp.id;
    end if;
    return;
  end if;

  -- ---------------- RECOVERABLE: order requires_action ↔ period action_required ----------------
  --   Credit reservation is RETAINED while payment is still recoverable
  --   (missing card, or the bank needs the coordinator to authenticate).
  if p_outcome in ('authentication_required', 'payment_method_missing', 'stripe_customer_missing') then
    v_code := p_outcome;
    update public.payment_orders
       set status = 'requires_action', failure_reason = v_code, updated_at = now()
     where id = p_order;
    if v_bp.id is not null then
      update public.plan_billing_periods
         set status = 'action_required', failure_reason = v_code, updated_at = now()
       where id = v_bp.id;
    end if;
    perform app_private.notify_account(
      v_order.coordinator_account_id, 'plan_billing_action', 'Action needed for your plan',
      case when v_code = 'authentication_required'
           then 'Your bank needs you to confirm this month’s plan payment.'
           else 'Add a payment method to fund this month’s plan conversations.' end,
      null, 'plan-billing-action:' || p_order::text);
    return;
  end if;

  -- ---------------- TRANSIENT: leave BOTH retryable (never terminal-with-pending) ----------------
  --   A provider/infrastructure hiccup resets to the retryable pair so the next
  --   daily charge_due run picks the order up again. Credit stays reserved.
  if p_outcome = 'provider_error' then
    update public.payment_orders
       set status = 'pending', failure_reason = 'provider_error', updated_at = now()
     where id = p_order;
    if v_bp.id is not null then
      update public.plan_billing_periods
         set status = 'payment_pending', failure_reason = 'provider_error', updated_at = now()
       where id = v_bp.id;
    end if;
    return;
  end if;

  -- ---------------- TERMINAL FAILURE: order failed ↔ period payment_failed ----------------
  --   Permanent decline / cancellation / expiry. Release the reserved account
  --   credit EXACTLY once (idempotent by 'release-<order>'), grant NOTHING,
  --   notify the coordinator once.
  v_code := case
    when p_outcome = 'card_declined' then 'card_declined'
    when p_outcome = 'payment_cancelled' then 'payment_cancelled'
    when p_outcome = 'expired' then 'provider_error'
    else coalesce(nullif(p_reason, ''), 'card_declined')
  end;
  update public.payment_orders
     set status = case when p_outcome = 'expired' then 'expired' else 'failed' end,
         failure_reason = v_code, updated_at = now()
   where id = p_order;
  if v_order.credit_applied_minor > 0 then
    perform public.issue_account_credit(
      v_order.coordinator_account_id, v_order.credit_applied_minor,
      'platform_failure', v_order.id,
      'Reservation released: plan payment did not complete', 'release-' || v_order.id::text);
  end if;
  if v_bp.id is not null then
    update public.plan_billing_periods
       set status = 'payment_failed', failure_reason = v_code, updated_at = now()
     where id = v_bp.id;
  end if;
  perform app_private.notify_account(
    v_order.coordinator_account_id, 'plan_billing_failed', 'Plan payment didn’t go through',
    'We couldn’t take payment for your plan this month. Please review your payment method.',
    null, 'plan-billing-failed:' || p_order::text);
end;
$$;
revoke all on function app_private.settle_plan_billing_order(uuid, text, text, text) from public, anon, authenticated;

-- Service-role wrapper used by the stripe-billing Edge Function so that EVERY
-- terminal/intermediate transition it drives goes through the single authority.
create or replace function public.settle_plan_billing(
  p_order uuid, p_outcome text, p_intent text default null, p_reason text default null
)
returns void
language sql security definer
set search_path = ''
as $$
  select app_private.settle_plan_billing_order(p_order, p_outcome, p_intent, p_reason);
$$;
revoke all on function public.settle_plan_billing(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.settle_plan_billing(uuid, text, text, text) to service_role;

-- ------------------------------------------------------------
-- 2. finalise_paid_order — delegate plan_period orders to the single authority
--    (webhook 'succeeded'/'failed' still route here). The trial/one-off funded
--    booking path is byte-identical to 0040.
-- ------------------------------------------------------------
create or replace function app_private.finalise_paid_order(
  p_order uuid, p_outcome text, p_intent text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.payment_orders;
  v_booking uuid;
begin
  select * into v_order from public.payment_orders where id = p_order for update;
  if v_order.id is null then return; end if;

  -- 2G5B recurring plan billing → single-authority state sync.
  if v_order.order_type = 'plan_period' then
    perform app_private.settle_plan_billing_order(p_order, p_outcome, p_intent, null);
    return;
  end if;

  if v_order.status not in ('pending', 'requires_action', 'processing') then return; end if;

  -- ---- unchanged: single trial / one-off funded booking ----
  if p_outcome = 'succeeded' then
    update public.payment_orders
       set status = 'succeeded',
           stripe_payment_intent_id = coalesce(p_intent, stripe_payment_intent_id),
           updated_at = now()
     where id = p_order;
    insert into public.bookings
      (member_profile_id, companion_profile_id, booked_by_account_id, offer_id,
       starts_at, ends_at, timezone, communication_method, status, duration_minutes,
       price_minor, currency, platform_fee_rate, platform_fee_minor,
       companion_amount_minor, is_trial)
    values
      (v_order.member_profile_id, v_order.companion_profile_id,
       v_order.coordinator_account_id, v_order.offer_id,
       v_order.starts_at, v_order.starts_at + make_interval(mins => v_order.duration_minutes),
       'Europe/London', 'in_app', 'requested', v_order.duration_minutes,
       v_order.subtotal_minor, 'GBP', v_order.commission_rate_pct,
       v_order.commission_minor,
       v_order.subtotal_minor - v_order.commission_minor, v_order.order_type = 'trial')
    returning id into v_booking;
    update public.payment_orders set booking_id = v_booking where id = p_order;
  else
    update public.payment_orders
       set status = case when p_outcome = 'expired' then 'expired' else 'failed' end,
           failure_reason = p_outcome, updated_at = now()
     where id = p_order;
    if v_order.credit_applied_minor > 0 then
      perform public.issue_account_credit(
        v_order.coordinator_account_id, v_order.credit_applied_minor,
        'platform_failure', v_order.id,
        'Reservation released: payment did not complete', 'release-' || v_order.id::text);
    end if;
  end if;
end;
$$;
revoke all on function app_private.finalise_paid_order(uuid, text, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Renewal engine — treat 'payment_failed' as TERMINAL so a failed period is
--    never re-priced back to 'payment_pending'. Only the two skip lists change;
--    pricing, credit-first, grant and idempotency are otherwise identical to 0040.
-- ------------------------------------------------------------
create or replace function public.renew_plan_billing_period(p_plan uuid, p_period_start date)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_plan public.conversation_plans;
  v_bp public.plan_billing_periods;
  v_end date;
  v_occ integer;
  v_per integer;
  v_gross integer;
  v_discount integer;
  v_net integer;
  v_credit integer;
  v_applied integer := 0;
  v_card integer;
  v_order public.payment_orders;
  v_order_id uuid;
  v_key text;
begin
  select * into v_plan from public.conversation_plans where id = p_plan for update;
  if v_plan.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if not v_plan.billing_enabled then return jsonb_build_object('ok', false, 'reason', 'not_billed'); end if;

  -- One worker per period; a settled/in-flight/terminally-failed period is a no-op.
  select * into v_bp from public.plan_billing_periods
   where plan_id = p_plan and period_start = p_period_start for update;
  if v_bp.id is not null and v_bp.status in
     ('paid', 'processing', 'payment_pending', 'action_required', 'payment_failed', 'closed') then
    return jsonb_build_object('ok', true, 'repeat', true, 'status', v_bp.status, 'period_id', v_bp.id);
  end if;

  v_end := app_private.monthly_period_end(p_period_start);
  v_per := v_plan.per_conversation_price_minor;
  select count(*)::integer into v_occ
    from public.plan_schedule_slots s
    join generate_series(p_period_start, (v_end - 1), interval '1 day') d(day)
      on extract(isodow from d.day)::int = s.iso_day
    where s.plan_id = p_plan;
  v_gross := v_occ * v_per;
  v_discount := (v_gross * 10) / 100;
  v_net := v_gross - v_discount;

  if v_net = 0 then
    insert into public.plan_billing_periods
      (plan_id, coordinator_account_id, period_start, period_end, status,
       occurrences_count, gross_minor, discount_minor, net_minor,
       credit_applied_minor, card_amount_minor, allowance_purchase_id)
    values (p_plan, v_plan.created_by_account_id, p_period_start, v_end, 'closed',
            0, 0, 0, 0, 0, 0, v_plan.allowance_purchase_id)
    on conflict (plan_id, period_start) do update set status = 'closed', updated_at = now()
    returning * into v_bp;
    return jsonb_build_object('ok', true, 'status', 'closed', 'occurrences', 0, 'period_id', v_bp.id);
  end if;

  v_key := 'plan-bill-' || p_plan::text || '-' || p_period_start::text;
  insert into public.payment_orders
    (coordinator_account_id, member_profile_id, companion_profile_id, plan_id,
     order_type, status, subtotal_minor, discount_minor, service_fee_minor,
     credit_applied_minor, card_amount_minor, total_minor,
     commission_rate_pct, commission_minor, idempotency_key, expires_at)
  values
    (v_plan.created_by_account_id, v_plan.member_profile_id, v_plan.companion_profile_id, p_plan,
     'plan_period', 'pending', v_gross, v_discount, 0,
     0, v_net, v_net, 0, 0, v_key, now() + interval '3 days')
  on conflict (idempotency_key) do nothing
  returning * into v_order;
  if v_order.id is null then
    select * into v_order from public.payment_orders where idempotency_key = v_key;
  end if;
  v_order_id := v_order.id;

  select coalesce(sum(remaining_minor), 0)::integer into v_credit
    from public.credit_ledger
   where coordinator_account_id = v_plan.created_by_account_id
     and entry_type = 'credit' and remaining_minor > 0
     and (expires_at is null or expires_at > now());
  if v_credit > 0 then
    v_applied := public.spend_account_credit(
      v_plan.created_by_account_id, least(v_credit, v_net), 'plan_renewal',
      v_order_id, v_order_id, 'Reserved for plan billing period', 'spend-' || v_order_id::text);
  end if;
  v_card := v_net - v_applied;
  update public.payment_orders
     set credit_applied_minor = v_applied, card_amount_minor = v_card, updated_at = now()
   where id = v_order_id;

  insert into public.plan_billing_periods
    (plan_id, coordinator_account_id, period_start, period_end, status,
     occurrences_count, gross_minor, discount_minor, net_minor,
     credit_applied_minor, card_amount_minor, allowance_purchase_id, payment_order_id)
  values (p_plan, v_plan.created_by_account_id, p_period_start, v_end,
          case when v_card = 0 then 'processing' else 'payment_pending' end,
          v_occ, v_gross, v_discount, v_net, v_applied, v_card,
          v_plan.allowance_purchase_id, v_order_id)
  on conflict (plan_id, period_start) do update set
    status = case when v_card = 0 then 'processing' else 'payment_pending' end,
    occurrences_count = v_occ, gross_minor = v_gross, discount_minor = v_discount, net_minor = v_net,
    credit_applied_minor = v_applied, card_amount_minor = v_card,
    payment_order_id = v_order_id, updated_at = now()
  returning * into v_bp;

  if v_card = 0 then
    perform app_private.finalise_paid_order(v_order_id, 'succeeded', null);
    select * into v_bp from public.plan_billing_periods where id = v_bp.id;
  end if;

  return jsonb_build_object('ok', true, 'period_id', v_bp.id, 'order_id', v_order_id,
    'status', v_bp.status, 'occurrences', v_occ, 'net_minor', v_net,
    'credit_applied_minor', v_applied, 'card_amount_minor', v_card);
end;
$$;
revoke all on function public.renew_plan_billing_period(uuid, date) from public, anon, authenticated;
grant execute on function public.renew_plan_billing_period(uuid, date) to service_role;

-- ------------------------------------------------------------
-- 4. Renewal orchestrator — exclude terminally-failed periods too, so a failed
--    month is never resurrected. Otherwise identical to 0040.
-- ------------------------------------------------------------
create or replace function public.process_plan_renewals()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_period date := date_trunc('month', now())::date;
  v_count integer := 0;
  v_errors text := '';
begin
  for v_row in
    select p.id
    from public.conversation_plans p
    where p.status = 'active' and p.billing_enabled and p.funding_mode = 'recurring'
      and not exists (
        select 1 from public.plan_billing_periods bp
        where bp.plan_id = p.id and bp.period_start = v_period
          and bp.status in ('paid', 'processing', 'payment_pending', 'action_required',
                            'payment_failed', 'closed'))
    limit 100
    for update of p skip locked
  loop
    begin
      perform public.renew_plan_billing_period(v_row.id, v_period);
      v_count := v_count + 1;
    exception when others then
      v_errors := v_errors || v_row.id::text || ': ' || sqlerrm || '; ';
    end;
  end loop;
  return jsonb_build_object('period', v_period, 'processed', v_count, 'errors', nullif(v_errors, ''));
end;
$$;
revoke all on function public.process_plan_renewals() from public, anon, authenticated;
grant execute on function public.process_plan_renewals() to service_role;

-- ------------------------------------------------------------
-- 5. DATA REPAIR — bring every existing plan_period period into line with its
--    terminal/intermediate order. Status-only sync (no credit movement): failed
--    orders already released their reservation through finalise; this only
--    corrects periods that were flipped back by the pre-0043 renewal race.
-- ------------------------------------------------------------
update public.plan_billing_periods bp
   set status = 'payment_failed',
       failure_reason = coalesce(bp.failure_reason, po.failure_reason, 'card_declined'),
       updated_at = now()
  from public.payment_orders po
 where bp.payment_order_id = po.id
   and po.order_type = 'plan_period'
   and po.status = 'failed'
   and bp.status <> 'payment_failed';

update public.plan_billing_periods bp
   set status = 'action_required',
       failure_reason = coalesce(bp.failure_reason, po.failure_reason, 'authentication_required'),
       updated_at = now()
  from public.payment_orders po
 where bp.payment_order_id = po.id
   and po.order_type = 'plan_period'
   and po.status = 'requires_action'
   and bp.status <> 'action_required';

update public.plan_billing_periods bp
   set status = 'processing', updated_at = now()
  from public.payment_orders po
 where bp.payment_order_id = po.id
   and po.order_type = 'plan_period'
   and po.status = 'processing'
   and bp.status <> 'processing';

update public.plan_billing_periods bp
   set status = 'paid',
       allowance_credits_granted = bp.occurrences_count,
       failure_reason = null, updated_at = now()
  from public.payment_orders po
 where bp.payment_order_id = po.id
   and po.order_type = 'plan_period'
   and po.status = 'succeeded'
   and bp.status <> 'paid';

-- ------------------------------------------------------------
-- 6. Reconciliation invariant. Returns the number of plan_period orders whose
--    period status has drifted from the required mapping — must be zero. Kept as
--    a service-role helper so it can be asserted as a live/hosted invariant.
-- ------------------------------------------------------------
create or replace function app_private.plan_billing_state_drift()
returns integer
language sql stable security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.payment_orders po
  join public.plan_billing_periods bp on bp.payment_order_id = po.id
  where po.order_type = 'plan_period'
    and (
      (po.status = 'failed' and bp.status <> 'payment_failed')
      or (po.status = 'requires_action' and bp.status <> 'action_required')
      or (po.status = 'succeeded' and bp.status <> 'paid')
      or (po.status = 'processing' and bp.status <> 'processing')
    );
$$;
revoke all on function app_private.plan_billing_state_drift() from public, anon, authenticated;
grant execute on function app_private.plan_billing_state_drift() to service_role;

select pg_notify('pgrst', 'reload schema');
