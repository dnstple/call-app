-- ============================================================
-- 2G6D hosted fixes (migration 0057) — additive; 0056 is immutable.
--
-- Two defects surfaced after 0056 was applied hosted:
--
-- (1) 42P10 in record_dispute_funds_withdrawn. Its
--     `on conflict (dispute_id, companion_earning_id) do nothing` could not infer
--     the arbiter index because that index is PARTIAL
--     (`... where dispute_id is not null`); ON CONFLICT inference requires the
--     index predicate. The exposure adjustment was therefore never inserted, and
--     reinstatement later found zero adjustments (downstream failure 2).
--     Fix: redefine the function with the matching ON CONFLICT predicate — it now
--     targets the existing partial unique index exactly. No index is changed, so
--     "exactly one dispute adjustment per (dispute, earning)", the refund_id XOR
--     dispute_id constraint, existing refund adjustments and no-duplicate-on-
--     repeat are all preserved.
--
-- (2) An unmapped dispute was stored with internal_state='open'.
--     record_dispute_upsert advanced internal_state from the provider status
--     UNCONDITIONALLY, even when no order could be mapped. Fix: advance the
--     internal state from the provider status ONLY once the dispute is mapped
--     (payment_order_id is not null); an unmapped dispute stays 'unresolved'.
--     reconcile_unresolved_dispute now advances the state after a successful
--     mapping. Unknown provider statuses remain recordable ('open' once mapped).
--
-- No hosted rows are dropped or reinterpreted. create-or-replace only.
-- ============================================================

-- ------------------------------------------------------------
-- 1. record_dispute_funds_withdrawn — ON CONFLICT now matches the partial index.
--    Body identical to 0056 except the ON CONFLICT predicate.
-- ------------------------------------------------------------
create or replace function public.record_dispute_funds_withdrawn(p_stripe_dispute_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_d public.payment_disputes; r record; v_attempt uuid; v_adj uuid; v_transferred boolean;
begin
  select * into v_d from public.payment_disputes where stripe_dispute_id = p_stripe_dispute_id for update;
  if v_d.id is null then return; end if;
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
-- 2. record_dispute_upsert — advance internal_state ONLY once mapped, so an
--    unmapped dispute stays 'unresolved'. Body identical to 0056 except the
--    internal-state update moves after map_and_hold and is gated on a mapped
--    order.
-- ------------------------------------------------------------
create or replace function public.record_dispute_upsert(
  p_stripe_dispute_id text, p_payment_intent text, p_charge text,
  p_amount integer, p_currency text, p_reason text, p_provider_status text, p_evidence_due timestamptz
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
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

  -- Map first (may set payment_order_id + place holds); then advance the
  -- internal state from the provider status ONLY if now mapped — an unmapped
  -- dispute stays 'unresolved'. Terminal outcomes are never moved backwards.
  perform app_private.map_and_hold_dispute(v_id);
  update public.payment_disputes
     set internal_state = app_private.dispute_internal_state(provider_status), updated_at = now()
   where id = v_id and payment_order_id is not null
     and internal_state not in ('won', 'lost', 'closed_warning');
end;
$$;
revoke all on function public.record_dispute_upsert(text, text, text, integer, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_dispute_upsert(text, text, text, integer, text, text, text, timestamptz) to service_role;

-- ------------------------------------------------------------
-- 3. reconcile_unresolved_dispute — after a successful late mapping, derive the
--    stable internal state from the recorded provider status (idempotent;
--    unmapped stays 'unresolved'; terminal never regresses).
-- ------------------------------------------------------------
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
  update public.payment_disputes
     set internal_state = app_private.dispute_internal_state(provider_status), updated_at = now()
   where id = v_d.id and payment_order_id is not null
     and internal_state not in ('won', 'lost', 'closed_warning');
end;
$$;
revoke all on function public.reconcile_unresolved_dispute(text, text, text) from public, anon, authenticated;
grant execute on function public.reconcile_unresolved_dispute(text, text, text) to service_role;

select pg_notify('pgrst', 'reload schema');
