-- 0137 — Close the fee-timing / completion ordering gap that strands earnings.
--
-- Problem observed on a real booking: a one-off call was paid, then COMPLETED
-- before the Stripe fee webhook recorded the fee. ensure_companion_earning (0134)
-- (a) refuses to mint unless fee_calculation_status = 'recorded' (correct), and
-- (b) only mints while the booking is 'confirmed'. So the earning was skipped at
-- the confirmed stage (fee not yet known) and could never be created afterwards
-- because the booking had moved to 'completed'. Net result: money collected, fee
-- recorded, but NO companion earning and nothing to pay out.
--
-- Fixes (all additive / behaviour-preserving except the two intended changes):
--   1. ensure_companion_earning now also mints for a 'completed' booking (a
--      completed booking was necessarily accepted, so the "only accepted bookings
--      earn" invariant still holds), and — when it mints for an already-completed
--      booking with no open issue — releases it straight to 'payable' (the normal
--      release path already ran before the earning existed, so it must self-release).
--   2. record_payment_processing_fee now calls ensure_companion_earning after
--      recording the fee, so a fee that lands AFTER acceptance/completion still
--      creates the earning. This is the durable safety net.
--   3. One-time backfill: create (and release) earnings for any already
--      confirmed/completed booking that has a succeeded, fee-recorded order but no
--      earning.

set search_path = '';

-- ------------------------------------------------------------
-- 1. ensure_companion_earning — 0134 body verbatim, with the status guard
--    widened to include 'completed' and a self-release for completed bookings.
-- ------------------------------------------------------------
create or replace function app_private.ensure_companion_earning(p_booking uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_b public.bookings;
  v_order public.payment_orders;
  v_plan public.conversation_plans;
  v_period public.plan_billing_periods;
  v_companion_account uuid;
  v_basis integer; v_rate numeric; v_commission integer; v_net integer; v_charge integer;
  v_plan_id uuid := null; v_period_id uuid := null; v_id uuid;
  v_occ integer; v_ordinal integer; v_earn integer; v_comm integer; v_tot integer;
  v_created boolean := false;
begin
  select id into v_id from public.companion_earnings where booking_id = p_booking;
  if v_id is not null then return v_id; end if;

  select * into v_b from public.bookings where id = p_booking;
  if v_b.id is null then return null; end if;

  -- INVARIANT: only an ACCEPTED booking may ever earn. A 'completed' booking was
  -- necessarily accepted (requested → confirmed → completed), so it qualifies too.
  if v_b.status not in ('confirmed', 'completed') then return null; end if;

  -- Path A: a directly-funded booking (one-off / trial) — snapshot from order.
  select * into v_order from public.payment_orders
   where booking_id = p_booking and provider = 'stripe_test' and status = 'succeeded'
   for update;
  if v_order.id is not null then
    -- Defer until the ACTUAL Stripe fee is recorded — never pay on an estimate.
    if v_order.fee_calculation_status is distinct from 'recorded' then return null; end if;
    v_basis      := v_order.subtotal_minor - v_order.discount_minor;
    v_rate       := round(coalesce(v_order.commission_rate_bps, 0) / 100.0, 2);
    v_commission := coalesce(v_order.commission_amount_pence, 0);
    v_net        := coalesce(v_order.companion_earnings_pence, 0);
    v_charge     := v_order.total_minor;
  else
    -- Path B: a recurring-plan occurrence funded by a PAID billing period.
    if v_b.plan_id is null or v_b.booking_source <> 'package_credit' then return null; end if;
    select * into v_plan from public.conversation_plans where id = v_b.plan_id;
    if v_plan.id is null or v_plan.funding_mode <> 'recurring' then return null; end if;
    select * into v_period from public.plan_billing_periods
     where plan_id = v_b.plan_id and status = 'paid'
       and period_start = date_trunc('month', (v_b.starts_at at time zone v_b.timezone))::date
     for update;
    if v_period.id is null or v_period.payment_order_id is null or v_period.occurrences_count < 1 then
      return null;
    end if;
    select * into v_order from public.payment_orders where id = v_period.payment_order_id;
    if v_order.id is null or v_order.status <> 'succeeded' then return null; end if;
    if v_order.fee_calculation_status is distinct from 'recorded' then return null; end if;

    -- Deterministic 0-based occurrence ordinal within the paid month.
    select count(*) into v_ordinal from public.bookings b2
     where b2.plan_id = v_b.plan_id and b2.booking_source = 'package_credit'
       and date_trunc('month', (b2.starts_at at time zone b2.timezone))
           = date_trunc('month', (v_b.starts_at at time zone v_b.timezone))
       and (b2.starts_at < v_b.starts_at or (b2.starts_at = v_b.starts_at and b2.id < v_b.id));

    v_occ  := greatest(v_period.occurrences_count, 1);
    v_earn := coalesce(v_order.companion_earnings_pence, 0);
    v_comm := coalesce(v_order.commission_amount_pence, 0);
    v_tot  := v_order.total_minor;
    v_net        := (v_earn / v_occ) + case when v_ordinal < (v_earn - (v_earn / v_occ) * v_occ) then 1 else 0 end;
    v_commission := (v_comm / v_occ) + case when v_ordinal < (v_comm - (v_comm / v_occ) * v_occ) then 1 else 0 end;
    v_charge     := (v_tot  / v_occ) + case when v_ordinal < (v_tot  - (v_tot  / v_occ) * v_occ) then 1 else 0 end;
    v_basis      := v_b.price_minor;
    v_rate       := round(coalesce(v_order.commission_rate_bps, 0) / 100.0, 2);
    v_plan_id    := v_b.plan_id;
    v_period_id  := v_period.id;
  end if;

  select pa.account_id into v_companion_account
  from public.profile_access pa
  where pa.profile_id = v_b.companion_profile_id
    and pa.access_role = 'owner' and pa.consent_status <> 'withdrawn'
  limit 1;
  if v_companion_account is null then return null; end if;

  insert into public.companion_earnings
    (booking_id, payment_order_id, companion_account_id, companion_profile_id,
     member_profile_id, payer_account_id, basis_minor, commission_rate_pct,
     commission_minor, net_minor, plan_id, plan_billing_period_id, payer_charge_minor)
  values
    (p_booking, v_order.id, v_companion_account, v_b.companion_profile_id,
     v_b.member_profile_id, v_order.coordinator_account_id,
     v_basis, v_rate, v_commission, v_net, v_plan_id, v_period_id, v_charge)
  on conflict (booking_id) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.companion_earnings where booking_id = p_booking;
  else
    v_created := true;
  end if;

  -- If the earning is minted for an ALREADY-completed booking, the normal
  -- pending→payable release already ran (before the earning existed), so it must
  -- self-release now. make_earning_payable independently re-checks evidence holds.
  if v_created and v_b.status = 'completed'
     and not exists (select 1 from public.conversation_issues i
                     where i.booking_id = p_booking and i.state <> 'resolved') then
    perform app_private.make_earning_payable(v_id);
  end if;

  return v_id;
end;
$$;
revoke all on function app_private.ensure_companion_earning(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. record_payment_processing_fee — 0133 body verbatim, plus: after recording
--    the fee, attempt earning creation for the order's booking. Closes the gap
--    where a fee lands after the booking is already accepted/completed.
-- ------------------------------------------------------------
create or replace function app_private.record_payment_processing_fee(
  p_order uuid, p_charge text, p_balance_txn text, p_fee_pence integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order public.payment_orders; v_calc jsonb;
begin
  select * into v_order from public.payment_orders where id = p_order for update;
  if v_order.id is null then raise exception 'order_not_found'; end if;
  if v_order.fee_calculation_status = 'recorded' then
    return jsonb_build_object('ok', true, 'already_recorded', true,
      'companion_earnings_pence', v_order.companion_earnings_pence);
  end if;
  if p_fee_pence is null or p_fee_pence < 0 or p_fee_pence > v_order.subtotal_minor then
    raise exception 'invalid_fee';
  end if;

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

  -- Safety net: now that the fee is known, mint any earning that was skipped
  -- because the fee wasn't recorded yet when the booking was accepted/completed.
  if v_order.booking_id is not null then
    perform app_private.ensure_companion_earning(v_order.booking_id);
  end if;

  return jsonb_build_object('ok', true,
    'companion_earnings_pence', (v_calc->>'companion_earnings_pence')::integer,
    'commission_amount_pence', (v_calc->>'commission_amount_pence')::integer);
end;
$$;
revoke all on function app_private.record_payment_processing_fee(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function app_private.record_payment_processing_fee(uuid, text, text, integer) to service_role;

-- ------------------------------------------------------------
-- 3. One-time backfill: create + release earnings for confirmed/completed
--    bookings that have a succeeded, fee-recorded order but no earning yet.
-- ------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select b.id
    from public.bookings b
    join public.payment_orders po
      on po.booking_id = b.id and po.status = 'succeeded'
     and po.fee_calculation_status = 'recorded'
    where b.status in ('confirmed', 'completed')
      and not exists (select 1 from public.companion_earnings e where e.booking_id = b.id)
  loop
    perform app_private.ensure_companion_earning(r.id);
  end loop;
end $$;

select pg_notify('pgrst', 'reload schema');
