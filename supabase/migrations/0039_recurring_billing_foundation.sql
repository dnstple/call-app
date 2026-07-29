-- ============================================================
-- 2G5A — recurring conversation billing: FOUNDATION (migration 0039).
-- Controlling design: docs/payments-architecture.md §2 (application-managed
-- off-session billing), §7 (credit-first ordering).
--
-- This stage is ADDITIVE and READ-ONLY with respect to money: it introduces
-- the monthly billing-period model and a coordinator-scoped PREVIEW that
-- prices an upcoming period from the plan's actual weekly schedule, applies
-- the 10% monthly discount, and shows the credit-first split (credit before
-- card). It moves NO money, creates NO Stripe intent, and changes NO existing
-- table or function — so no completed safeguard (allowance funding, holds,
-- attendance, issue resolution) is affected. The renewal/charge ENGINE that
-- populates plan_billing_periods and takes off-session card payment is 2G5B.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Billing periods (model for 2G5B; read-only to clients).
--    One immutable row per (plan, period_start). Credit-first invariant is
--    enforced by CHECKs so no future writer can violate the ordering.
-- ------------------------------------------------------------
create table if not exists public.plan_billing_periods (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.conversation_plans(id) on delete cascade,
  coordinator_account_id uuid not null references public.accounts(id),
  period_start date not null,
  period_end date not null,                       -- exclusive
  status text not null default 'draft' check (status in
    ('draft', 'preview', 'payment_pending', 'paid', 'failed', 'partially_credited', 'closed')),
  occurrences_count integer not null default 0 check (occurrences_count >= 0),
  currency text not null default 'GBP' check (currency = 'GBP'),
  gross_minor integer not null default 0 check (gross_minor >= 0),
  discount_minor integer not null default 0 check (discount_minor >= 0),
  net_minor integer not null default 0 check (net_minor >= 0),
  credit_applied_minor integer not null default 0 check (credit_applied_minor >= 0),
  card_amount_minor integer not null default 0 check (card_amount_minor >= 0),
  payment_order_id uuid references public.payment_orders(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plan_id, period_start),
  check (period_start < period_end),
  check (net_minor = gross_minor - discount_minor),
  check (credit_applied_minor + card_amount_minor = net_minor)
);
create index if not exists plan_billing_periods_plan_idx
  on public.plan_billing_periods (plan_id, period_start desc);
alter table public.plan_billing_periods enable row level security;
-- Coordinator (the plan payer) reads their OWN periods. No client writes at
-- all — the 2G5B engine is service-role only.
drop policy if exists "billing periods: coordinator reads own" on public.plan_billing_periods;
create policy "billing periods: coordinator reads own" on public.plan_billing_periods
  for select to authenticated using (coordinator_account_id = auth.uid());

-- ------------------------------------------------------------
-- 2. Calendar-safe monthly period bounds (29/30/31-safe).
--    Postgres month arithmetic clamps to the last valid day, so a 31st
--    anchor rolls to 28/29/30 in short months without double-counting.
-- ------------------------------------------------------------
create or replace function app_private.monthly_period_end(p_start date)
returns date
language sql immutable
set search_path = ''
as $$
  select (p_start + interval '1 month')::date;
$$;
revoke all on function app_private.monthly_period_end(date) from public, anon;

-- ------------------------------------------------------------
-- 3. Read-only period preview (coordinator-scoped).
--    Prices the period from the plan's ACTUAL weekly schedule, applies the
--    10% monthly discount, and shows the credit-first split. NO writes, NO
--    Stripe, NO money movement. Neutral not_found for anyone but the payer.
-- ------------------------------------------------------------
create or replace function public.preview_plan_billing_period(
  p_plan uuid, p_period_start date
)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_plan public.conversation_plans;
  v_end date;
  v_occ integer;
  v_per integer;
  v_gross integer;
  v_discount integer;
  v_net integer;
  v_credit integer;
  v_credit_applied integer;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  select * into v_plan from public.conversation_plans where id = p_plan;
  -- Only the plan's payer (Coordinator who created it) may preview billing.
  if v_plan.id is null or v_plan.created_by_account_id <> auth.uid() then
    raise exception 'not_found: plan';
  end if;

  v_end := app_private.monthly_period_end(p_period_start);
  v_per := v_plan.per_conversation_price_minor;

  -- Occurrences = every weekly-schedule slot instance falling in [start, end).
  select count(*)::integer into v_occ
  from public.plan_schedule_slots s
  join generate_series(p_period_start, (v_end - 1), interval '1 day') d(day)
    on extract(isodow from d.day)::int = s.iso_day
  where s.plan_id = p_plan;

  v_gross := v_occ * v_per;
  v_discount := (v_gross * 10) / 100;            -- 10% monthly discount line
  v_net := v_gross - v_discount;

  -- Credit-first: the payer's non-expired account credit is applied BEFORE
  -- any card charge (docs §7). Read-only sum; never spends here.
  select coalesce(sum(remaining_minor), 0)::integer into v_credit
  from public.credit_ledger
  where coordinator_account_id = auth.uid()
    and entry_type = 'credit'
    and remaining_minor > 0
    and (expires_at is null or expires_at > now());
  v_credit_applied := least(v_credit, v_net);

  return jsonb_build_object(
    'plan_id', p_plan,
    'period_start', p_period_start,
    'period_end', v_end,
    'currency', v_plan.currency,
    'frequency_per_week', v_plan.frequency_per_week,
    'per_conversation_minor', v_per,
    'occurrences', v_occ,
    'gross_minor', v_gross,
    'discount_pct', 10,
    'discount_minor', v_discount,
    'net_minor', v_net,
    'credit_available_minor', v_credit,
    'credit_applied_minor', v_credit_applied,
    'card_amount_minor', v_net - v_credit_applied,
    'estimate', true);
end;
$$;
revoke all on function public.preview_plan_billing_period(uuid, date) from public, anon;
grant execute on function public.preview_plan_billing_period(uuid, date) to authenticated;
