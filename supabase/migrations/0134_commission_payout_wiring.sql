-- 0134 — New commission model, part 3: payout pipeline (earnings).
--
-- ensure_companion_earning now pays the AUTHORITATIVE post-fee amount:
--   * one-off / trial (direct order): net_minor = order.companion_earnings_pence,
--     commission_minor = order.commission_amount_pence. The earning is created
--     ONLY once fee_calculation_status = 'recorded' — so no payout is ever
--     released before the actual Stripe fee is known.
--   * recurring-plan occurrence (paid billing period): the PERIOD's order carries
--     the post-fee split; each occurrence gets a deterministic largest-remainder
--     slice of companion_earnings_pence / commission / charge so the per-call rows
--     sum EXACTLY to the period totals. Remainder pennies go to the earliest
--     occurrences (and, being the Companion's earnings, to the Companion).
--
-- Body is otherwise identical to 0068 (same guards, same conflict handling).

set search_path = '';

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
begin
  select id into v_id from public.companion_earnings where booking_id = p_booking;
  if v_id is not null then return v_id; end if;

  select * into v_b from public.bookings where id = p_booking;
  if v_b.id is null then return null; end if;

  -- INVARIANT: only an ACCEPTED (confirmed) booking may ever earn.
  if v_b.status <> 'confirmed' then return null; end if;

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
    -- Largest-remainder: base slice + 1 for the first (total - base*occ) occurrences.
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
  end if;
  return v_id;
end;
$$;
revoke all on function app_private.ensure_companion_earning(uuid) from public, anon, authenticated;

select pg_notify('pgrst', 'reload schema');
