-- ============================================================
-- 2G6C audit fix — persist the approved refund reason (migration 0053).
--
-- 0052's request_payment_refund accepted p_reason but never stored it. This adds
-- a required, length-bounded reason column to payment_refunds, backfills any
-- rows created before this migration, and redefines request_payment_refund so
-- the reason is trimmed, required, bounded and PERSISTED — visible only through
-- the support-only operational view, never sent to Stripe metadata and never in
-- a customer notification. Amounts, allocation, worker, webhook and state-machine
-- behaviour are byte-identical to 0052; only the reason handling is added.
-- ============================================================

alter table public.payment_refunds add column if not exists reason text;
update public.payment_refunds set reason = 'Migrated: reason not recorded' where reason is null;
alter table public.payment_refunds alter column reason set not null;
do $$
begin
  alter table public.payment_refunds
    add constraint payment_refunds_reason_len check (char_length(reason) between 1 and 500);
exception when duplicate_object then null;
end $$;

-- ------------------------------------------------------------
-- request_payment_refund — identical to 0052 except p_reason is validated
-- (trimmed, required, ≤500 chars) and persisted on the refund row.
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
  v_reason text;
begin
  if not app_private.is_support_admin() then
    raise exception 'not_found: refund source';
  end if;
  if p_remedy_minor is null or p_remedy_minor < 0 then
    raise exception 'invalid_amounts: remedy must be non-negative';
  end if;
  -- Reason: required, trimmed, length-bounded. Validated before the idempotency
  -- lookup so an empty reason is always rejected.
  v_reason := left(trim(coalesce(p_reason, '')), 500);
  if v_reason = '' then
    raise exception 'reason_required: an approved-refund reason is required';
  end if;
  -- Idempotent: an identical prior request returns its safe result WITHOUT
  -- overwriting the originally-recorded reason.
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

  if v_card = 0 then
    update public.payment_refunds set completed_at = now(), updated_at = now() where id = v_refund.id;
    perform app_private.notify_account(
      v_order.coordinator_account_id, 'refund_processed', 'Account credit restored',
      'Account credit has been restored to your account.',
      v_order.booking_id, 'refund-credit-done:' || v_refund.id::text);
  end if;

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
-- support_refund_overview — REDEFINED to also expose the reason on the most
-- recent refunds (support-only surface; never a client-visible column).
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
    'settlement_adjustments_open', (select count(*) from public.settlement_adjustments where state = 'open'),
    'recent', coalesce((
      select jsonb_agg(x) from (
        select jsonb_build_object('id', id, 'state', state, 'remedy_minor', remedy_minor,
          'card_refund_minor', card_refund_minor, 'credit_restore_minor', credit_restore_minor,
          'reason', reason) as x
        from public.payment_refunds order by created_at desc limit 20) s), '[]'::jsonb)
  ) into v;
  return v;
end; $$;
revoke all on function public.support_refund_overview() from public, anon;
grant execute on function public.support_refund_overview() to authenticated; -- gated by is_support_admin()

select pg_notify('pgrst', 'reload schema');
