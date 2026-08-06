-- 0132 — Commission model foundation (additive).
--
-- Introduces the AUTHORITATIVE commission calculation and the payment fields it
-- needs, WITHOUT yet rewiring the payment flow (that is a separate, reviewed
-- step because it changes customer-facing pricing). This migration is safe and
-- additive: it adds columns/functions and changes no existing behaviour.
--
-- New model (integer pence): the customer pays exactly the Companion's price;
-- Stripe's ACTUAL fee is deducted; Apricoti takes commission from the remainder;
-- the Companion receives the rest.
--   net_after_stripe = gross - stripe_fee
--   commission_bps   = trial ? 0 : 1000
--   commission       = round(net * bps / 10000)   -- half away from zero
--   companion        = net - commission           -- remainder → Companion
--   invariant: gross = stripe_fee + commission + companion   (always exact)

set search_path = '';

-- ---------- payment snapshot fields ----------
alter table public.payment_orders
  add column if not exists stripe_fee_pence integer,
  add column if not exists net_after_stripe_pence integer,
  add column if not exists commission_rate_bps integer,
  add column if not exists commission_amount_pence integer,
  add column if not exists companion_earnings_pence integer,
  add column if not exists stripe_charge_id text,
  add column if not exists stripe_balance_transaction_id text,
  add column if not exists fee_calculation_status text
    not null default 'pending'
    check (fee_calculation_status in ('pending', 'recorded', 'not_applicable')),
  add column if not exists commission_calculated_at timestamptz;

-- ---------- authoritative rate ----------
-- Single source of truth for the rate. Historical rows keep their snapshotted
-- commission_rate_bps and must never be recalculated when this changes.
create or replace function app_private.commission_bps(p_is_trial boolean)
returns integer language sql immutable set search_path = '' as $$
  select case when p_is_trial then 0 else 1000 end;
$$;
revoke all on function app_private.commission_bps(boolean) from public, anon;
grant execute on function app_private.commission_bps(boolean) to authenticated, service_role;

-- ---------- authoritative integer-pence breakdown ----------
-- round(numeric) in Postgres rounds half AWAY FROM ZERO, matching the required
-- monetary rounding; the remainder is absorbed by the Companion by construction.
create or replace function app_private.compute_commission(
  p_gross_pence integer, p_stripe_fee_pence integer, p_is_trial boolean)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_bps integer; v_net integer; v_commission integer; v_earnings integer;
begin
  if p_gross_pence is null or p_gross_pence < 0 then raise exception 'invalid_gross'; end if;
  if p_stripe_fee_pence is null or p_stripe_fee_pence < 0 then raise exception 'invalid_fee'; end if;
  if p_stripe_fee_pence > p_gross_pence then raise exception 'fee_exceeds_gross'; end if;
  v_bps := app_private.commission_bps(p_is_trial);
  v_net := p_gross_pence - p_stripe_fee_pence;
  v_commission := round(v_net::numeric * v_bps / 10000)::integer;
  v_earnings := v_net - v_commission;   -- remainder → Companion
  return jsonb_build_object(
    'gross_pence', p_gross_pence,
    'stripe_fee_pence', p_stripe_fee_pence,
    'net_after_stripe_pence', v_net,
    'commission_rate_bps', v_bps,
    'commission_amount_pence', v_commission,
    'companion_earnings_pence', v_earnings);
end;
$$;
revoke all on function app_private.compute_commission(integer, integer, boolean) from public, anon;
grant execute on function app_private.compute_commission(integer, integer, boolean) to authenticated, service_role;

select pg_notify('pgrst', 'reload schema');
