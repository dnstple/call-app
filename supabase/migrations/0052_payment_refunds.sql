-- ============================================================
-- 2G6C-1 — Card refunds, account-credit restoration & post-transfer adjustments
-- (migration 0052).
--
-- Approach: Option B — a SEPARATE support-only refund action, leaving the
-- validated issue-resolution flow (and its notifications) unchanged. A remedy is
-- allocated CREDIT-FIRST: the originally credit-funded portion is restored to the
-- account-credit ledger, and only the remainder is queued as a Stripe CARD
-- refund. Total remedy = credit restored + card refunded, never both for the same
-- value. Refunds are created against the order's PaymentIntent (the only Stripe
-- payment id persisted — there is NO Charge id). Account-credit-only remedies
-- never call Stripe. Recurring-plan occurrence issues are capped at
-- companion_earnings.payer_charge_minor, so one occurrence can never expose the
-- whole month. Post-transfer refunds do NOT reverse the Stripe transfer — the
-- platform absorbs it and records an auditable settlement adjustment for support.
--
-- All monetary values are derived and validated server-side; no client supplies
-- amounts, allocations or Stripe ids. Additive only.
-- ============================================================

-- ------------------------------------------------------------
-- 0. A distinct credit-ledger source for restored ORIGINAL PAYMENT value, so it
--    is never confused with discretionary goodwill (refund_resolution) credit.
-- ------------------------------------------------------------
do $$
begin
  alter table public.credit_ledger drop constraint if exists credit_ledger_source_type_check;
  alter table public.credit_ledger add constraint credit_ledger_source_type_check check (source_type in (
    'companion_declined', 'eligible_cancellation', 'plan_reduction', 'plan_paused',
    'plan_ended', 'platform_failure', 'refund_resolution', 'support_adjustment',
    'trial_purchase', 'one_off_purchase', 'plan_renewal', 'plan_addition', 'service_fee',
    'payment_restoration'));
end $$;

-- ------------------------------------------------------------
-- 1. payment_refunds — one auditable row per approved refund decision. Detailed
--    settlement data is private (RLS on, NO client policies): service-role writes,
--    support reads via RPC. card_refund_minor is the ONLY portion Stripe touches.
-- ------------------------------------------------------------
create table if not exists public.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_order_id uuid not null references public.payment_orders(id),
  booking_id uuid references public.bookings(id),
  plan_id uuid references public.conversation_plans(id),
  plan_billing_period_id uuid references public.plan_billing_periods(id),
  conversation_issue_id uuid references public.conversation_issues(id),
  issue_resolution_id uuid references public.issue_resolutions(id),
  companion_earning_id uuid references public.companion_earnings(id),
  payer_account_id uuid not null references public.accounts(id),
  remedy_minor integer not null check (remedy_minor >= 0),
  credit_restore_minor integer not null default 0 check (credit_restore_minor >= 0),
  card_refund_minor integer not null default 0 check (card_refund_minor >= 0),
  currency text not null default 'GBP' check (currency = 'GBP'),
  stripe_payment_intent_id text,
  stripe_charge_id text,
  stripe_refund_id text unique,
  idempotency_key text not null unique,
  state text not null default 'requested' check (state in
    ('requested', 'processing', 'succeeded', 'failed_retryable', 'failed_permanent', 'cancelled')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  failure_code text,
  failure_message text,
  requested_by uuid references public.accounts(id),
  requested_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (remedy_minor = credit_restore_minor + card_refund_minor)
);
create index if not exists payment_refunds_state_idx on public.payment_refunds (state);
create index if not exists payment_refunds_order_idx on public.payment_refunds (payment_order_id);
alter table public.payment_refunds enable row level security;
-- No client policies at all.

-- ------------------------------------------------------------
-- 2. settlement_adjustments — records the platform-funded exposure when a
--    customer refund is approved AFTER the companion earning was already
--    transferred. The historical transfer is never mutated here.
-- ------------------------------------------------------------
create table if not exists public.settlement_adjustments (
  id uuid primary key default gen_random_uuid(),
  refund_id uuid not null references public.payment_refunds(id),
  companion_earning_id uuid not null references public.companion_earnings(id),
  transfer_attempt_id uuid references public.companion_transfer_attempts(id),
  companion_account_id uuid not null references public.accounts(id),
  amount_minor integer not null check (amount_minor >= 0),
  currency text not null default 'GBP' check (currency = 'GBP'),
  adjustment_type text not null default 'customer_refund_after_transfer'
    check (adjustment_type in ('customer_refund_after_transfer')),
  state text not null default 'open' check (state in ('open', 'acknowledged', 'resolved')),
  recovery_strategy text not null default 'platform_absorbed'
    check (recovery_strategy in ('platform_absorbed', 'future_offset', 'manual_recovery')),
  support_review text not null default 'pending' check (support_review in ('pending', 'reviewed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (refund_id, companion_earning_id)
);
alter table public.settlement_adjustments enable row level security;
-- No client policies at all.

-- ------------------------------------------------------------
-- 3. Refundable-balance calculation (internal). Returns the remaining
--    credit-restorable and card-refundable amounts for an order, reserving any
--    in-flight (requested/processing) and succeeded card refunds and any
--    non-terminal credit restorations.
-- ------------------------------------------------------------
create or replace function app_private.order_refundable_balance(p_order uuid)
returns table (credit_restorable integer, card_refundable integer)
language sql stable security definer
set search_path = ''
as $$
  select
    greatest(o.credit_applied_minor - coalesce((
      select sum(r.credit_restore_minor) from public.payment_refunds r
      where r.payment_order_id = o.id and r.state <> 'cancelled' and r.state <> 'failed_permanent'), 0), 0),
    greatest(o.card_amount_minor - coalesce((
      select sum(r.card_refund_minor) from public.payment_refunds r
      where r.payment_order_id = o.id and r.state in ('requested', 'processing', 'succeeded')), 0), 0)
  from public.payment_orders o
  where o.id = p_order;
$$;
revoke all on function app_private.order_refundable_balance(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. request_payment_refund — SUPPORT-ONLY. Derives everything server-side,
--    allocates credit-first, restores credit idempotently and creates ONE
--    idempotent card-refund row (finalising internally when the card portion is
--    zero). Records a post-transfer settlement adjustment when applicable.
--    p_source_kind ∈ {'order','issue'}. The caller supplies ONLY the source id,
--    the requested remedy, a reason and an idempotency key.
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
  v_attempt uuid;
begin
  if not app_private.is_support_admin() then
    raise exception 'not_found: refund source';
  end if;
  if p_remedy_minor is null or p_remedy_minor < 0 then
    raise exception 'invalid_amounts: remedy must be non-negative';
  end if;
  -- Idempotent: an identical prior request returns its safe result.
  select * into v_existing from public.payment_refunds where idempotency_key = p_idempotency;
  if v_existing.id is not null then
    return jsonb_build_object('ok', true, 'repeat', true, 'refund_id', v_existing.id,
      'state', v_existing.state, 'credit_restore_minor', v_existing.credit_restore_minor,
      'card_refund_minor', v_existing.card_refund_minor);
  end if;

  -- Resolve the order + occurrence cap, locking the financial source.
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
    -- Occurrence cap: one recurring occurrence never exposes the whole period.
    v_cap := coalesce(v_earning.payer_charge_minor, v_order.total_minor);
    -- Subtract goodwill credit already issued for this issue (no double remedy).
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

  -- Credit-first allocation.
  v_credit := least(p_remedy_minor, v_credit_restorable);
  v_card := p_remedy_minor - v_credit;
  if v_card > v_card_refundable then
    raise exception 'remedy_exceeds_refundable: card portion over the remaining card balance';
  end if;

  insert into public.payment_refunds
    (payment_order_id, booking_id, plan_id, plan_billing_period_id, conversation_issue_id,
     companion_earning_id, payer_account_id, remedy_minor, credit_restore_minor, card_refund_minor,
     stripe_payment_intent_id, stripe_charge_id, idempotency_key,
     state, requested_by)
  values
    (v_order.id, v_order.booking_id, v_order.plan_id, v_earning.plan_billing_period_id, v_issue.id,
     v_earning.id, v_order.coordinator_account_id, p_remedy_minor, v_credit, v_card,
     v_order.stripe_payment_intent_id, null, p_idempotency,
     case when v_card = 0 then 'succeeded' else 'requested' end, auth.uid())
  returning * into v_refund;

  -- Restore the credit-funded portion once (idempotent by the refund row).
  if v_credit > 0 then
    perform public.issue_account_credit(
      v_order.coordinator_account_id, v_credit, 'payment_restoration', v_refund.id,
      'Refund: original account credit restored', 'refund-credit-' || v_refund.id::text);
  end if;

  -- Zero-card remedy finalises internally + notifies now (no Stripe).
  if v_card = 0 then
    update public.payment_refunds set completed_at = now(), updated_at = now() where id = v_refund.id;
    perform app_private.notify_account(
      v_order.coordinator_account_id, 'refund_processed', 'Account credit restored',
      'Account credit has been restored to your account.',
      v_order.booking_id, 'refund-credit-done:' || v_refund.id::text);
  end if;

  -- Post-transfer exposure: the companion was already paid → record an
  -- auditable, platform-absorbed adjustment (never reverse the transfer here).
  if v_earning.id is not null then
    v_transferred := (v_earning.transfer_state = 'transferred')
      or exists (select 1 from public.companion_transfer_attempts ta
                 where ta.earning_id = v_earning.id and ta.state = 'succeeded');
    if v_transferred then
      select id into v_attempt from public.companion_transfer_attempts
        where earning_id = v_earning.id and state = 'succeeded' limit 1;
      insert into public.settlement_adjustments
        (refund_id, companion_earning_id, transfer_attempt_id, companion_account_id, amount_minor)
      values (v_refund.id, v_earning.id, v_attempt, v_earning.companion_account_id, p_remedy_minor)
      on conflict (refund_id, companion_earning_id) do nothing;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'refund_id', v_refund.id, 'state', v_refund.state,
    'credit_restore_minor', v_credit, 'card_refund_minor', v_card,
    'settlement_adjustment', v_transferred);
end;
$$;
revoke all on function public.request_payment_refund(text, uuid, integer, text, text) from public, anon;
grant execute on function public.request_payment_refund(text, uuid, integer, text, text) to authenticated; -- gated by is_support_admin()

-- ------------------------------------------------------------
-- 5. Claim worker (service-role). FOR UPDATE SKIP LOCKED. Fixture-scopeable:
--    hosted tests pass explicit refund ids in p_ids; production passes null and
--    claims all eligible card refunds. Stable Stripe idempotency key per refund.
-- ------------------------------------------------------------
create or replace function public.claim_payment_refunds(p_limit integer default 20, p_ids uuid[] default null)
returns table (
  refund_id uuid, payment_intent_id text, amount_minor integer, currency text,
  payer_account_id uuid, stripe_idempotency_key text
)
language plpgsql security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  r record;
begin
  for r in
    select rf.id, rf.stripe_payment_intent_id, rf.card_refund_minor, rf.payer_account_id
    from public.payment_refunds rf
    where rf.state in ('requested', 'failed_retryable')
      and rf.card_refund_minor > 0
      and rf.stripe_payment_intent_id is not null
      and (p_ids is null or rf.id = any(p_ids))
    order by rf.requested_at
    limit greatest(p_limit, 0)
    for update of rf skip locked
  loop
    update public.payment_refunds
       set state = 'processing', attempt_count = attempt_count + 1,
           failure_code = null, failure_message = null, claimed_at = now(), updated_at = now()
     where id = r.id;
    refund_id := r.id; payment_intent_id := r.stripe_payment_intent_id;
    amount_minor := r.card_refund_minor; currency := 'GBP'; payer_account_id := r.payer_account_id;
    stripe_idempotency_key := 'refund-' || r.id::text; -- stable ⇒ exactly-once
    return next;
  end loop;
end;
$$;
revoke all on function public.claim_payment_refunds(integer, uuid[]) from public, anon, authenticated;
grant execute on function public.claim_payment_refunds(integer, uuid[]) to service_role;

-- Stale-claim recovery. A stale 'processing' row with no Stripe id is safe to
-- retry (the Stripe idempotency key is stable). One WITH a Stripe id is left for
-- webhook reconciliation.
create or replace function public.recover_stale_refunds(p_minutes integer default 30)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare v_count integer;
begin
  update public.payment_refunds
     set state = 'failed_retryable', failure_code = 'stale_claim',
         failure_message = 'Worker did not finalise in time; safe to retry.', updated_at = now()
   where state = 'processing' and stripe_refund_id is null
     and claimed_at < now() - make_interval(mins => greatest(p_minutes, 1));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.recover_stale_refunds(integer) from public, anon, authenticated;
grant execute on function public.recover_stale_refunds(integer) to service_role;

-- ------------------------------------------------------------
-- 6. Finalisation RPCs (service-role) — called by the Edge Function AND the
--    webhook; each idempotent. Success never increases the remedy, never
--    attaches one Stripe refund id to two rows, and marks the order
--    partially_refunded / refunded.
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
  -- Order-level refunded/partially_refunded bookkeeping (never client-driven).
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
end;
$$;
revoke all on function public.finalize_refund_succeeded(uuid, text, text) from public, anon, authenticated;
grant execute on function public.finalize_refund_succeeded(uuid, text, text) to service_role;

create or replace function public.finalize_refund_failed_retryable(p_refund uuid, p_code text, p_message text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_rf public.payment_refunds;
begin
  select * into v_rf from public.payment_refunds where id = p_refund for update;
  if v_rf.id is null or v_rf.state = 'succeeded' then return; end if; -- never un-succeed
  update public.payment_refunds
     set state = 'failed_retryable', failure_code = left(coalesce(p_code, 'provider_error'), 100),
         failure_message = left(coalesce(p_message, ''), 500), updated_at = now()
   where id = p_refund;
end; $$;
revoke all on function public.finalize_refund_failed_retryable(uuid, text, text) from public, anon, authenticated;
grant execute on function public.finalize_refund_failed_retryable(uuid, text, text) to service_role;

create or replace function public.finalize_refund_failed_permanent(p_refund uuid, p_code text, p_message text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_rf public.payment_refunds;
begin
  select * into v_rf from public.payment_refunds where id = p_refund for update;
  if v_rf.id is null or v_rf.state = 'succeeded' then return; end if;
  update public.payment_refunds
     set state = 'failed_permanent', failure_code = left(coalesce(p_code, 'permanent_error'), 100),
         failure_message = left(coalesce(p_message, ''), 500), completed_at = now(), updated_at = now()
   where id = p_refund;
  perform app_private.notify_account(
    v_rf.payer_account_id, 'refund_failed', 'We could not complete your refund',
    'We could not process your refund automatically. Our team is looking into it.',
    v_rf.booking_id, 'refund-failed:' || v_rf.id::text);
end; $$;
revoke all on function public.finalize_refund_failed_permanent(uuid, text, text) from public, anon, authenticated;
grant execute on function public.finalize_refund_failed_permanent(uuid, text, text) to service_role;

create or replace function public.finalize_refund_cancelled(p_refund uuid, p_reason text default 'cancelled')
returns void language plpgsql security definer set search_path = '' as $$
declare v_rf public.payment_refunds;
begin
  select * into v_rf from public.payment_refunds where id = p_refund for update;
  if v_rf.id is null or v_rf.state in ('succeeded', 'cancelled') then return; end if;
  update public.payment_refunds
     set state = 'cancelled', failure_code = left(coalesce(p_reason, 'cancelled'), 100),
         completed_at = now(), updated_at = now()
   where id = p_refund;
end; $$;
revoke all on function public.finalize_refund_cancelled(uuid, text) from public, anon, authenticated;
grant execute on function public.finalize_refund_cancelled(uuid, text) to service_role;

-- Webhook resolver: find the internal refund row by the Stripe refund id.
create or replace function public.refund_id_for_stripe(p_stripe_refund_id text)
returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.payment_refunds where stripe_refund_id = p_stripe_refund_id;
$$;
revoke all on function public.refund_id_for_stripe(text) from public, anon, authenticated;
grant execute on function public.refund_id_for_stripe(text) to service_role;

-- ------------------------------------------------------------
-- 7. Support-only operational overview (support-admin gated; no Stripe errors,
--    refund ids or adjustment details leak to normal users).
-- ------------------------------------------------------------
create or replace function public.support_refund_overview()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: overview'; end if;
  select jsonb_build_object(
    'requested', (select count(*) from public.payment_refunds where state = 'requested'),
    'processing', (select count(*) from public.payment_refunds where state = 'processing'),
    'failed_retryable', (select count(*) from public.payment_refunds where state = 'failed_retryable'),
    'failed_permanent', (select count(*) from public.payment_refunds where state = 'failed_permanent'),
    'succeeded', (select count(*) from public.payment_refunds where state = 'succeeded'),
    'credit_only', (select count(*) from public.payment_refunds where card_refund_minor = 0),
    'mixed', (select count(*) from public.payment_refunds where card_refund_minor > 0 and credit_restore_minor > 0),
    'stale_processing', (select count(*) from public.payment_refunds
                         where state = 'processing' and stripe_refund_id is null
                           and claimed_at < now() - interval '30 minutes'),
    'settlement_adjustments_open', (select count(*) from public.settlement_adjustments where state = 'open')
  ) into v;
  return v;
end; $$;
revoke all on function public.support_refund_overview() from public, anon;
grant execute on function public.support_refund_overview() to authenticated; -- gated by is_support_admin()

select pg_notify('pgrst', 'reload schema');
