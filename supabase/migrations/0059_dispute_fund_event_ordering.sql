-- ============================================================
-- 2G6D final correction (migration 0059) — out-of-order dispute fund events.
-- Additive to the immutable 0056/0057/0058. No existing financial behaviour is
-- changed except to close a silent-no-op hole.
--
-- Genuine provider evidence (Stripe test mode):
--   dispute du_1Tvh3DD8sYiWjL8NHw0VzoDv / pi_3Tvh3CD8sYiWjL8N1xqaT3Rp /
--   order d9111eee-25c6-4e7c-92cd-986d2f508557.
--   charge.dispute.funds_withdrawn was RECEIVED after created but FINISHED first
--   (17:01:53.760 vs 17:01:54.055). record_dispute_funds_withdrawn ran before the
--   dispute row existed, hit `if v_d.id is null then return;` and returned WITHOUT
--   error, so stripe_webhook_events was permanently marked processed
--   (result = dispute_funds_withdrawn) while payment_disputes.funds_withdrawn
--   stayed false. Because the event id is now 'processed', a Stripe resend of the
--   same id is an idempotent no-op — the side effect was lost forever.
--
-- Two independent guards (defence in depth):
--   * the webhook now upserts the dispute from the full event object BEFORE the
--     fund RPC (see stripe-webhook) — the row always exists first; and
--   * this migration makes the fund RPCs raise a RETRYABLE error instead of
--     silently succeeding when the dispute row is absent, so a missing side effect
--     can NEVER be marked processed (the webhook returns HTTP 500 and Stripe
--     retries). It also adds a service-role-only reconciliation RPC to repair a
--     dispute whose fund event was already (wrongly) marked processed.
-- ============================================================

-- ------------------------------------------------------------
-- 1. record_dispute_funds_withdrawn — identical to 0057 EXCEPT the missing-row
--    branch now raises a retryable error instead of returning silently.
-- ------------------------------------------------------------
create or replace function public.record_dispute_funds_withdrawn(p_stripe_dispute_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_d public.payment_disputes; r record; v_attempt uuid; v_adj uuid; v_transferred boolean;
begin
  select * into v_d from public.payment_disputes where stripe_dispute_id = p_stripe_dispute_id for update;
  if v_d.id is null then
    -- Never a silent success: the dispute must exist first. Retryable so the
    -- webhook returns 500 and Stripe redelivers once created has landed.
    raise exception 'dispute_absent_retryable: funds_withdrawn %', p_stripe_dispute_id;
  end if;
  update public.payment_disputes
     set funds_withdrawn = true, funds_withdrawn_at = coalesce(funds_withdrawn_at, now()), updated_at = now()
   where id = v_d.id;
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
    on conflict (dispute_id, companion_earning_id) where dispute_id is not null do nothing
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

-- ------------------------------------------------------------
-- 2. record_dispute_funds_reinstated — identical to 0056 EXCEPT the missing-row
--    branch now raises a retryable error instead of returning silently.
-- ------------------------------------------------------------
create or replace function public.record_dispute_funds_reinstated(p_stripe_dispute_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_d public.payment_disputes;
begin
  select * into v_d from public.payment_disputes where stripe_dispute_id = p_stripe_dispute_id for update;
  if v_d.id is null then
    raise exception 'dispute_absent_retryable: funds_reinstated %', p_stripe_dispute_id;
  end if;
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

-- ------------------------------------------------------------
-- 3. Service-role-only recovery for an ALREADY-processed event whose fund side
--    effect was lost (the genuine du_1Tvh3... case). Provider identifiers only —
--    the caller can never supply a payment order, an earning, or a monetary
--    allocation. Mapping + allocation + exposure come entirely from the trusted
--    2G6D routines. Idempotent: re-running once the flag is set is a safe no-op
--    (allocations and adjustments are guarded by their unique indexes).
-- ------------------------------------------------------------
create or replace function public.reconcile_dispute_fund_event(
  p_stripe_dispute_id text,
  p_kind text,
  p_payment_intent text default null,
  p_charge text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_d public.payment_disputes;
begin
  if p_kind not in ('funds_withdrawn', 'funds_reinstated') then
    raise exception 'invalid_kind: %', p_kind;
  end if;

  select * into v_d from public.payment_disputes where stripe_dispute_id = p_stripe_dispute_id for update;
  if v_d.id is null then
    -- Recovery repairs an EXISTING dispute; if the row is genuinely missing the
    -- created/updated event must be (re)processed first.
    raise exception 'dispute_not_found: %', p_stripe_dispute_id;
  end if;

  -- If still unmapped and provider identifiers are supplied, map it first via the
  -- trusted reconcile (PaymentIntent first, charge fallback) — no client order id.
  if v_d.payment_order_id is null and (p_payment_intent is not null or p_charge is not null) then
    perform public.reconcile_unresolved_dispute(p_stripe_dispute_id, p_payment_intent, p_charge);
  end if;

  -- Apply the proven fund movement through the normal trusted RPC.
  if p_kind = 'funds_withdrawn' then
    perform public.record_dispute_funds_withdrawn(p_stripe_dispute_id);
  else
    perform public.record_dispute_funds_reinstated(p_stripe_dispute_id);
  end if;

  select * into v_d from public.payment_disputes where id = v_d.id;
  return jsonb_build_object(
    'dispute_id', v_d.id,
    'payment_order_id', v_d.payment_order_id,
    'funds_withdrawn', v_d.funds_withdrawn,
    'funds_reinstated', v_d.funds_reinstated,
    'internal_state', v_d.internal_state);
end;
$$;
revoke all on function public.reconcile_dispute_fund_event(text, text, text, text) from public, anon, authenticated;
grant execute on function public.reconcile_dispute_fund_event(text, text, text, text) to service_role;

select pg_notify('pgrst', 'reload schema');
