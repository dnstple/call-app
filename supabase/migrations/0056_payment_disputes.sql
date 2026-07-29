-- ============================================================
-- 2G6D — Stripe disputes & chargebacks (migration 0056). Additive; NOT applied
-- by this branch. Records disputes and RECONCILES fund movement separately from
-- dispute status. Never fights disputes, submits evidence, reverses transfers or
-- debits connected accounts. A platform-loss adjustment is created ONLY when
-- funds are actually withdrawn AND the affected companion money was already
-- transferred. One payment order can fund MANY occurrence earnings, so exposure
-- is allocated across earnings via payment_dispute_earnings.
--
-- Allocation rule (deterministic, capped, server-derived): for a mapped dispute
-- on order O with Stripe disputed amount D, walk the order's affected occurrence
-- earnings (net_minor>0, state<>'reversed') ascending by created_at, id and give
-- each earning min(remaining_D, earning.payer_charge_minor); the running total
-- never exceeds min(D, O.card_amount_minor, Σ payer_charge caps). Each allocated
-- earning is held from transfer until the dispute resolves in our favour.
-- ============================================================

-- ------------------------------------------------------------
-- 0. Webhook retry model: events must not be permanently 'processed' before
--    their DB side effects succeed. Existing processed rows keep idempotency.
-- ------------------------------------------------------------
alter table public.stripe_webhook_events
  add column if not exists status text not null default 'received'
    check (status in ('received', 'processing', 'processed', 'failed'));
update public.stripe_webhook_events set status = 'processed' where processed_at is not null and status = 'received';

-- ------------------------------------------------------------
-- 1. payment_disputes — private dispute ledger. Raw provider status is FREE TEXT
--    (a new Stripe status must never break webhook processing); a stable
--    internal_state carries the checked operational lifecycle.
-- ------------------------------------------------------------
create table if not exists public.payment_disputes (
  id uuid primary key default gen_random_uuid(),
  stripe_dispute_id text not null unique,
  payment_order_id uuid references public.payment_orders(id),
  stripe_payment_intent_id text,
  stripe_charge_id text,
  disputed_amount_minor integer not null default 0 check (disputed_amount_minor >= 0),
  currency text not null default 'GBP',
  reason text,
  provider_status text,                       -- RAW Stripe status; intentionally uncheck-constrained
  internal_state text not null default 'unresolved'
    check (internal_state in ('unresolved', 'open', 'under_review', 'won', 'lost', 'closed_warning')),
  evidence_due_at timestamptz,
  funds_withdrawn boolean not null default false,
  funds_withdrawn_at timestamptz,
  funds_reinstated boolean not null default false,
  funds_reinstated_at timestamptz,
  outcome text,
  failure_code text,
  support_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists payment_disputes_order_idx on public.payment_disputes (payment_order_id);
create index if not exists payment_disputes_state_idx on public.payment_disputes (internal_state);
alter table public.payment_disputes enable row level security;
-- No client policies.

-- ------------------------------------------------------------
-- 2. payment_dispute_earnings — per-earning exposure allocation + hold.
-- ------------------------------------------------------------
create table if not exists public.payment_dispute_earnings (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references public.payment_disputes(id),
  earning_id uuid not null references public.companion_earnings(id),
  allocated_minor integer not null check (allocated_minor >= 0),
  hold_state text not null default 'held' check (hold_state in ('held', 'released')),
  transfer_state_observed text,
  exposure_adjustment_id uuid references public.settlement_adjustments(id),
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (dispute_id, earning_id)
);
create index if not exists dispute_earnings_earning_idx on public.payment_dispute_earnings (earning_id);
alter table public.payment_dispute_earnings enable row level security;
-- No client policies.

-- ------------------------------------------------------------
-- 3. settlement_adjustments — extended to carry dispute exposure. refund_id
--    becomes nullable and a nullable dispute_id is added; historical refund rows
--    are untouched and never reinterpreted.
-- ------------------------------------------------------------
alter table public.settlement_adjustments alter column refund_id drop not null;
alter table public.settlement_adjustments add column if not exists dispute_id uuid references public.payment_disputes(id);
do $$
begin
  alter table public.settlement_adjustments drop constraint if exists settlement_adjustments_adjustment_type_check;
  alter table public.settlement_adjustments add constraint settlement_adjustments_adjustment_type_check
    check (adjustment_type in ('customer_refund_after_transfer', 'dispute_after_transfer'));
  alter table public.settlement_adjustments add constraint settlement_adjustments_source_present
    check (num_nonnulls(refund_id, dispute_id) = 1); -- exactly one source: refund XOR dispute
exception when duplicate_object then null;
end $$;
create unique index if not exists settlement_adjustments_one_per_dispute_earning
  on public.settlement_adjustments (dispute_id, companion_earning_id) where dispute_id is not null;

-- ------------------------------------------------------------
-- 4. Internal helpers.
-- ------------------------------------------------------------
create or replace function app_private.dispute_internal_state(p_provider_status text)
returns text language sql immutable set search_path = '' as $$
  select case lower(coalesce(p_provider_status, ''))
    when 'warning_needs_response' then 'open'
    when 'needs_response' then 'open'
    when 'warning_under_review' then 'under_review'
    when 'under_review' then 'under_review'
    when 'won' then 'won'
    when 'lost' then 'lost'
    when 'warning_closed' then 'closed_warning'
    else 'open'  -- unknown/new statuses remain recordable and visible as 'open'
  end;
$$;
revoke all on function app_private.dispute_internal_state(text) from public, anon, authenticated;

-- Map an unmapped dispute to its order and place occurrence holds. Idempotent.
create or replace function app_private.map_and_hold_dispute(p_dispute uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_d public.payment_disputes;
  v_order public.payment_orders;
  v_remaining integer;
  r record;
  v_alloc integer;
begin
  select * into v_d from public.payment_disputes where id = p_dispute for update;
  if v_d.id is null or v_d.payment_order_id is not null then return; end if; -- already mapped

  select * into v_order from public.payment_orders
    where stripe_payment_intent_id = v_d.stripe_payment_intent_id for update;
  if v_order.id is null and v_d.stripe_charge_id is not null then
    -- Charge fallback: the only reliable charge linkage is a prior refund row.
    select o.* into v_order from public.payment_orders o
      join public.payment_refunds rf on rf.payment_order_id = o.id
     where rf.stripe_charge_id = v_d.stripe_charge_id
     limit 1;
    if v_order.id is not null then
      perform 1 from public.payment_orders where id = v_order.id for update;
    end if;
  end if;
  if v_order.id is null then return; end if; -- stays 'unresolved'; support will see it

  update public.payment_disputes set payment_order_id = v_order.id, updated_at = now() where id = p_dispute;
  update public.payment_orders set status = 'disputed', updated_at = now()
    where id = v_order.id and status in ('succeeded', 'partially_refunded');

  -- Cap total exposure by the disputed amount AND the order's card-funded value.
  v_remaining := least(v_d.disputed_amount_minor, v_order.card_amount_minor);
  for r in
    select e.id, e.payer_charge_minor, e.transfer_state, e.net_minor
    from public.companion_earnings e
    where e.payment_order_id = v_order.id and e.net_minor > 0 and e.state <> 'reversed'
    order by e.created_at, e.id
    for update
  loop
    exit when v_remaining <= 0;
    v_alloc := least(v_remaining, coalesce(r.payer_charge_minor, r.net_minor));
    if v_alloc <= 0 then continue; end if;
    insert into public.payment_dispute_earnings
      (dispute_id, earning_id, allocated_minor, hold_state, transfer_state_observed)
    values (p_dispute, r.id, v_alloc, 'held', r.transfer_state)
    on conflict (dispute_id, earning_id) do nothing;
    v_remaining := v_remaining - v_alloc;
  end loop;
end;
$$;
revoke all on function app_private.map_and_hold_dispute(uuid) from public, anon, authenticated;

-- Restore an order out of 'disputed' ONLY once no OTHER dispute is still active
-- (so several disputes on one order never release the order prematurely). The
-- restored status reflects any successful card refunds already recorded.
create or replace function app_private.restore_order_after_dispute(p_order uuid, p_exclude_dispute uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_paid integer;
begin
  if p_order is null then return; end if;
  if exists (
    select 1 from public.payment_disputes d
    where d.payment_order_id = p_order and d.id <> p_exclude_dispute
      and (d.internal_state in ('open', 'under_review')
           or (d.funds_withdrawn and not d.funds_reinstated))
  ) then
    return; -- another dispute still holds this order in contention
  end if;
  select coalesce(sum(card_refund_minor), 0) into v_paid from public.payment_refunds
    where payment_order_id = p_order and state = 'succeeded';
  update public.payment_orders o
     set status = case when v_paid = 0 then 'succeeded'
                       when v_paid >= o.card_amount_minor and o.card_amount_minor > 0 then 'refunded'
                       else 'partially_refunded' end,
         updated_at = now()
   where o.id = p_order and o.status = 'disputed';
end;
$$;
revoke all on function app_private.restore_order_after_dispute(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 5. Service-role webhook RPCs. Idempotent, out-of-order tolerant, never move a
--    terminal outcome backwards, never issue refunds/credits/evidence.
-- ------------------------------------------------------------
create or replace function public.record_dispute_upsert(
  p_stripe_dispute_id text, p_payment_intent text, p_charge text,
  p_amount integer, p_currency text, p_reason text, p_provider_status text, p_evidence_due timestamptz
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_state text;
begin
  insert into public.payment_disputes
    (stripe_dispute_id, stripe_payment_intent_id, stripe_charge_id, disputed_amount_minor,
     currency, reason, provider_status, internal_state, evidence_due_at)
  values (p_stripe_dispute_id, p_payment_intent, p_charge, coalesce(p_amount, 0),
          coalesce(nullif(upper(p_currency), ''), 'GBP'), p_reason, p_provider_status,
          'unresolved', p_evidence_due)
  on conflict (stripe_dispute_id) do update set
    stripe_payment_intent_id = coalesce(public.payment_disputes.stripe_payment_intent_id, excluded.stripe_payment_intent_id),
    stripe_charge_id = coalesce(public.payment_disputes.stripe_charge_id, excluded.stripe_charge_id),
    provider_status = excluded.provider_status,
    reason = coalesce(excluded.reason, public.payment_disputes.reason),
    evidence_due_at = coalesce(excluded.evidence_due_at, public.payment_disputes.evidence_due_at),
    updated_at = now()
  returning id into v_id;
  if v_id is null then select id into v_id from public.payment_disputes where stripe_dispute_id = p_stripe_dispute_id; end if;

  -- Advance the internal state from the provider status, but NEVER move a
  -- terminal outcome backwards.
  v_state := app_private.dispute_internal_state(p_provider_status);
  update public.payment_disputes
     set internal_state = v_state, updated_at = now()
   where id = v_id and internal_state not in ('won', 'lost', 'closed_warning');

  perform app_private.map_and_hold_dispute(v_id); -- maps + holds if not yet mapped
end;
$$;
revoke all on function public.record_dispute_upsert(text, text, text, integer, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_dispute_upsert(text, text, text, integer, text, text, text, timestamptz) to service_role;

create or replace function public.record_dispute_closed(
  p_stripe_dispute_id text, p_provider_status text, p_outcome text
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_d public.payment_disputes; v_state text;
begin
  select * into v_d from public.payment_disputes where stripe_dispute_id = p_stripe_dispute_id for update;
  if v_d.id is null then return; end if;
  if v_d.internal_state in ('won', 'lost', 'closed_warning') then return; end if; -- already terminal
  v_state := app_private.dispute_internal_state(coalesce(p_outcome, p_provider_status));
  if v_state not in ('won', 'lost', 'closed_warning') then v_state := 'lost'; end if; -- a close is terminal
  update public.payment_disputes
     set internal_state = v_state, provider_status = p_provider_status, outcome = p_outcome,
         closed_at = now(), updated_at = now()
   where id = v_d.id;
  -- Won / warning-closed with no loss → release holds (no platform-loss adjustment).
  if v_state in ('won', 'closed_warning') then
    update public.payment_dispute_earnings
       set hold_state = 'released', released_at = now(), updated_at = now()
     where dispute_id = v_d.id and hold_state = 'held';
    perform app_private.restore_order_after_dispute(v_d.payment_order_id, v_d.id);
  end if; -- 'lost' keeps holds; any exposure is realised only on funds_withdrawn
end;
$$;
revoke all on function public.record_dispute_closed(text, text, text) from public, anon, authenticated;
grant execute on function public.record_dispute_closed(text, text, text) to service_role;

create or replace function public.record_dispute_funds_withdrawn(p_stripe_dispute_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_d public.payment_disputes; r record; v_attempt uuid; v_adj uuid; v_transferred boolean;
begin
  select * into v_d from public.payment_disputes where stripe_dispute_id = p_stripe_dispute_id for update;
  if v_d.id is null then return; end if;
  update public.payment_disputes
     set funds_withdrawn = true, funds_withdrawn_at = coalesce(funds_withdrawn_at, now()), updated_at = now()
   where id = v_d.id;
  -- For each held allocation whose companion money was ALREADY transferred,
  -- create exactly one exposure adjustment (idempotent by exposure_adjustment_id).
  for r in
    select pde.id as pde_id, pde.earning_id, pde.allocated_minor
    from public.payment_dispute_earnings pde
    where pde.dispute_id = v_d.id and pde.exposure_adjustment_id is null
    for update
  loop
    v_transferred := exists (select 1 from public.companion_earnings e
                             where e.id = r.earning_id
                               and (e.transfer_state = 'transferred'
                                    or exists (select 1 from public.companion_transfer_attempts ta
                                               where ta.earning_id = e.id and ta.state = 'succeeded')));
    if not v_transferred then continue; end if;
    select id into v_attempt from public.companion_transfer_attempts
      where earning_id = r.earning_id and state = 'succeeded' limit 1;
    insert into public.settlement_adjustments
      (refund_id, dispute_id, companion_earning_id, transfer_attempt_id, companion_account_id,
       amount_minor, adjustment_type)
    select null, v_d.id, r.earning_id, v_attempt, e.companion_account_id, r.allocated_minor, 'dispute_after_transfer'
    from public.companion_earnings e where e.id = r.earning_id
    on conflict (dispute_id, companion_earning_id) do nothing
    returning id into v_adj;
    if v_adj is null then
      select id into v_adj from public.settlement_adjustments
        where dispute_id = v_d.id and companion_earning_id = r.earning_id;
    end if;
    update public.payment_dispute_earnings set exposure_adjustment_id = v_adj, updated_at = now()
      where id = r.pde_id;
  end loop;
end;
$$;
revoke all on function public.record_dispute_funds_withdrawn(text) from public, anon, authenticated;
grant execute on function public.record_dispute_funds_withdrawn(text) to service_role;

create or replace function public.record_dispute_funds_reinstated(p_stripe_dispute_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_d public.payment_disputes;
begin
  select * into v_d from public.payment_disputes where stripe_dispute_id = p_stripe_dispute_id for update;
  if v_d.id is null then return; end if;
  update public.payment_disputes
     set funds_reinstated = true, funds_reinstated_at = coalesce(funds_reinstated_at, now()), updated_at = now()
   where id = v_d.id;
  -- Resolve (never delete) any exposure adjustments, and release holds.
  update public.settlement_adjustments set state = 'resolved', updated_at = now()
   where dispute_id = v_d.id and state <> 'resolved';
  update public.payment_dispute_earnings
     set hold_state = 'released', released_at = now(), updated_at = now()
   where dispute_id = v_d.id and hold_state = 'held';
  -- Funds are back: the order may leave 'disputed' unless another dispute is active.
  perform app_private.restore_order_after_dispute(v_d.payment_order_id, v_d.id);
end;
$$;
revoke all on function public.record_dispute_funds_reinstated(text) from public, anon, authenticated;
grant execute on function public.record_dispute_funds_reinstated(text) to service_role;

create or replace function public.reconcile_unresolved_dispute(
  p_stripe_dispute_id text, p_payment_intent text, p_charge text
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_d public.payment_disputes;
begin
  select * into v_d from public.payment_disputes where stripe_dispute_id = p_stripe_dispute_id for update;
  if v_d.id is null or v_d.payment_order_id is not null then return; end if;
  update public.payment_disputes
     set stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent),
         stripe_charge_id = coalesce(stripe_charge_id, p_charge), updated_at = now()
   where id = v_d.id;
  perform app_private.map_and_hold_dispute(v_d.id);
end;
$$;
revoke all on function public.reconcile_unresolved_dispute(text, text, text) from public, anon, authenticated;
grant execute on function public.reconcile_unresolved_dispute(text, text, text) to service_role;

create or replace function public.dispute_id_for_stripe(p_stripe_dispute_id text)
returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.payment_disputes where stripe_dispute_id = p_stripe_dispute_id;
$$;
revoke all on function public.dispute_id_for_stripe(text) from public, anon, authenticated;
grant execute on function public.dispute_id_for_stripe(text) to service_role;

-- ------------------------------------------------------------
-- 6. Refund interaction (additive guards) — block NEW card refunds on a disputed
--    order and prevent claiming any queued refund for it. Successful refunds are
--    untouched. request_payment_refund body identical to 0055 + the dispute gate.
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

  -- 2G6D: an active dispute blocks a NEW refund on this order (successful refunds
  -- are untouched; queued ones are excluded from claiming by claim_payment_refunds).
  if exists (select 1 from public.payment_disputes d
             where d.payment_order_id = v_order.id and d.internal_state in ('open', 'under_review', 'lost')) then
    raise exception 'order_disputed: this order has an active dispute; refunds are blocked';
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

  if v_earning.id is not null then
    v_transferred := (v_earning.transfer_state = 'transferred')
      or exists (select 1 from public.companion_transfer_attempts ta
                 where ta.earning_id = v_earning.id and ta.state = 'succeeded');
  end if;

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

-- Prevent claiming any queued refund whose order has an active dispute (additive
-- redefine of 0052's claim; body identical + the dispute exclusion).
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
      and not exists (select 1 from public.payment_disputes d
                      where d.payment_order_id = rf.payment_order_id
                        and d.internal_state in ('open', 'under_review', 'lost'))
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
    stripe_idempotency_key := 'refund-' || r.id::text;
    return next;
  end loop;
end;
$$;
revoke all on function public.claim_payment_refunds(integer, uuid[]) from public, anon, authenticated;
grant execute on function public.claim_payment_refunds(integer, uuid[]) to service_role;

-- ------------------------------------------------------------
-- 7. Transfer hold — the settlement worker must not transfer an earning under an
--    active dispute hold. Additive redefine of 0050's claim; body identical + the
--    dispute-hold exclusion.
-- ------------------------------------------------------------
create or replace function public.claim_plan_transfers(p_limit integer default 20)
returns table (
  attempt_id uuid, earning_id uuid, companion_account_id uuid, companion_profile_id uuid,
  connected_account_id text, amount_minor integer, currency text, booking_id uuid,
  stripe_idempotency_key text
)
language plpgsql security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  r record;
  v_attempt uuid;
begin
  for r in
    select e.id as earning_id, e.companion_account_id, e.companion_profile_id, e.booking_id,
           e.net_minor, ca.stripe_account_id
    from public.companion_earnings e
    join public.connected_accounts ca on ca.account_id = e.companion_account_id
    join public.payment_orders po on po.id = e.payment_order_id and po.status = 'succeeded'
    left join public.plan_billing_periods bp on bp.id = e.plan_billing_period_id
    where e.state = 'payable'
      and e.net_minor > 0
      and e.transfer_state in ('not_ready', 'ready', 'failed')
      and e.currency = 'GBP' and ca.default_currency = 'gbp'
      and (e.plan_billing_period_id is null or bp.status = 'paid')
      and app_private.companion_payments_ready(e.companion_profile_id)
      and not exists (select 1 from public.conversation_issues i
                      where i.booking_id = e.booking_id and i.state <> 'resolved')
      and not exists (select 1 from public.companion_transfer_attempts ta
                      where ta.earning_id = e.id
                        and ta.state in ('processing', 'succeeded', 'failed_permanent'))
      and not exists (select 1 from public.payment_dispute_earnings pde
                      join public.payment_disputes d on d.id = pde.dispute_id
                      where pde.earning_id = e.id and pde.hold_state = 'held'
                        and d.internal_state in ('unresolved', 'open', 'under_review', 'lost'))
    order by e.payable_at nulls last, e.created_at
    limit greatest(p_limit, 0)
    for update of e skip locked
  loop
    insert into public.companion_transfer_attempts
      (earning_id, companion_account_id, companion_profile_id, connected_account_id,
       amount_minor, currency, state, attempt_count, idempotency_key, claimed_at)
    values
      (r.earning_id, r.companion_account_id, r.companion_profile_id, r.stripe_account_id,
       r.net_minor, 'GBP', 'processing', 1, 'transfer-' || r.earning_id::text, now())
    on conflict (earning_id) do update set
      state = 'processing',
      attempt_count = public.companion_transfer_attempts.attempt_count + 1,
      connected_account_id = excluded.connected_account_id,
      amount_minor = excluded.amount_minor,
      failure_code = null, failure_message = null,
      claimed_at = now(), updated_at = now()
    returning id into v_attempt;

    update public.companion_earnings set transfer_state = 'processing', updated_at = now()
     where id = r.earning_id;

    attempt_id := v_attempt; earning_id := r.earning_id;
    companion_account_id := r.companion_account_id; companion_profile_id := r.companion_profile_id;
    connected_account_id := r.stripe_account_id; amount_minor := r.net_minor; currency := 'GBP';
    booking_id := r.booking_id;
    stripe_idempotency_key := 'transfer-' || r.earning_id::text;
    return next;
  end loop;
end;
$$;
revoke all on function public.claim_plan_transfers(integer) from public, anon, authenticated;
grant execute on function public.claim_plan_transfers(integer) to service_role;

-- ------------------------------------------------------------
-- 8. Support-only dispute overview (support-admin gated).
-- ------------------------------------------------------------
create or replace function public.support_dispute_overview()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: overview'; end if;
  select jsonb_build_object(
    'unresolved', (select count(*) from public.payment_disputes where internal_state = 'unresolved'),
    'open', (select count(*) from public.payment_disputes where internal_state in ('open', 'under_review')),
    'won', (select count(*) from public.payment_disputes where internal_state = 'won'),
    'lost', (select count(*) from public.payment_disputes where internal_state = 'lost'),
    'funds_withdrawn', (select count(*) from public.payment_disputes where funds_withdrawn),
    'funds_reinstated', (select count(*) from public.payment_disputes where funds_reinstated),
    'open_exposure', (select count(*) from public.settlement_adjustments
                      where adjustment_type = 'dispute_after_transfer' and state <> 'resolved'),
    'held_earnings', (select count(*) from public.payment_dispute_earnings where hold_state = 'held'),
    'recent', coalesce((
      select jsonb_agg(x) from (
        select jsonb_build_object('id', id, 'stripe_dispute_id', stripe_dispute_id,
          'internal_state', internal_state, 'provider_status', provider_status,
          'disputed_amount_minor', disputed_amount_minor, 'evidence_due_at', evidence_due_at,
          'payment_order_id', payment_order_id, 'funds_withdrawn', funds_withdrawn,
          'funds_reinstated', funds_reinstated, 'outcome', outcome) as x
        from public.payment_disputes order by created_at desc limit 20) s), '[]'::jsonb)
  ) into v;
  return v;
end; $$;
revoke all on function public.support_dispute_overview() from public, anon;
grant execute on function public.support_dispute_overview() to authenticated; -- gated by is_support_admin()

-- ------------------------------------------------------------
-- 9. Atomic, recoverable webhook claim. FOR UPDATE serialises concurrent
--    deliveries of the SAME event: only ONE invocation gets true, an already
--    'processed' event is a safe no-op, and a STALE 'processing' row (a crashed
--    worker, redelivered after Stripe's backoff) is re-claimable — so a failed
--    or interrupted side effect is always retried, never permanently stranded.
-- ------------------------------------------------------------
create or replace function public.claim_webhook_event(p_id text, p_stale_minutes integer default 5)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v public.stripe_webhook_events;
begin
  select * into v from public.stripe_webhook_events where id = p_id for update;
  if v.id is null then return false; end if;             -- row must be pre-inserted
  if v.status = 'processed' then return false; end if;   -- idempotent skip
  if v.status = 'processing'
     and v.received_at > now() - make_interval(mins => greatest(p_stale_minutes, 1)) then
    return false;                                        -- another worker is actively processing
  end if;
  update public.stripe_webhook_events set status = 'processing' where id = p_id;
  return true;                                           -- this invocation owns the event
end;
$$;
revoke all on function public.claim_webhook_event(text, integer) from public, anon, authenticated;
grant execute on function public.claim_webhook_event(text, integer) to service_role;

select pg_notify('pgrst', 'reload schema');
