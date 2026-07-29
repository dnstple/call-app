-- ============================================================================
-- 0076_scoped_plan_renewal_execution.sql  (Stage 3C2-B)
--
-- The SECOND scoped financial operation: production-grade, record-scoped
-- plan_renewal execution. An authorised operations administrator previews,
-- confirms and executes an approved operation run carrying ≤25 EXPLICIT
-- recurring-plan UUIDs; execution affects ONLY those plans. An empty scope never
-- means "all due plans" — no due-plan candidate query may expand an approved run.
--
-- ADDITIVE ONLY (0001–0075 immutable). This migration:
--   * additively extends the financial_operation_run_items outcome vocabulary
--     and the run-event action vocabulary (supersets — no existing row can
--     violate them) with plan-renewal outcomes/actions;
--   * adds ONE authoritative read-only classifier
--     app_private.classify_plan_renewal(p_plan_id, p_as_of) used by BOTH preview
--     and execution, so they can never disagree. It computes the exact monthly
--     billing-period key (date_trunc('month', p_as_of)), the authoritative
--     occurrence count (plan_schedule_slots × the period's days), the exact
--     server-side pricing snapshot (per-conversation price × occurrences, 10%
--     plan discount) and the credit-first allocation prediction — and mutates
--     NOTHING;
--   * adds app_private.execute_scoped_plan_renewal(p_run_id) — the record-scoped
--     executor, following the hardened Stage 3C2-A architecture: inert without
--     the wrapper's transaction-local run+operation context, independently
--     revalidates run/type/confirmed/expiry/scope/control/environment, captures
--     ONE v_as_of at execution start (deterministic due-date semantics for the
--     whole run), deduplicates scope deterministically, locks each plan FOR
--     UPDATE, classifies via the shared classifier UNDER that lock, and — only
--     for an eligible plan — delegates the transition to the EXISTING
--     authoritative public.renew_plan_billing_period (0043; never reimplemented,
--     never weakened). Each record runs in its own savepoint so a record-specific
--     SQL failure is contained. Revoked from PUBLIC, anon, authenticated AND
--     service_role — the support wrapper is the only supported entry point;
--   * redefines public.support_execute_operation_run from the EXACT applied 0075
--     body, changing ONLY the addition of the plan_renewal branch (context then
--     delegate). The earning_release branch and every 0074/0075 guard, including
--     the deduplicated control_blocked structured-result contract, are unchanged;
--   * redefines public.support_preview_operation_run from the EXACT applied 0075
--     body, changing ONLY the addition of a plan_renewal branch that builds rows
--     from the shared classifier (side-effect-free; one row per DISTINCT
--     requested plan id in first-occurrence order; unknown ids => not_found
--     without aborting siblings).
--
-- PROVIDER BOUNDARY (audited): renewal preparation + credit-covered settlement
-- are 100% database-side. renew_plan_billing_period creates the idempotent
-- payment order ('plan-bill-<plan>-<period>'), reserves account credit FIRST
-- (spend_account_credit, idempotent 'spend-<order>'), then:
--   card_amount = 0  → settles through app_private.finalise_paid_order →
--                      settle_plan_billing_order: order succeeded, period 'paid',
--                      allowance granted AT SETTLEMENT (existing contract);
--   card_amount > 0  → the period stops in 'payment_pending'. Provider charging
--                      lives EXCLUSIVELY in the separate 0044 charge_due path.
-- This migration performs NO Stripe/provider call, creates NO PaymentIntent,
-- never marks a card-funded order paid, adds/alters NO cron, and does NOT invoke
-- process_plan_renewals or any other global worker. It does not touch
-- ba4f943c / the 177 findings, enables no control, and changes no environment.
--
-- Authoritative eligibility (audited from 0040/0042/0043 cumulative):
--   plan.status = 'active' (paused/ended/requested/declined never renew);
--   plan.billing_enabled = true; plan.funding_mode = 'recurring';
--   no existing period for the target month in
--     ('paid','processing','payment_pending','action_required','payment_failed',
--      'closed') — those are authority no-ops (paid/closed/processing =>
--     already renewed; payment_pending/action_required => provider work already
--     pending; payment_failed => terminal, never resurrected);
--   occurrences = schedule-slot weekday matches inside [period_start, period_end);
--   net = 0 → the authority records a 'closed' zero period;
--   concurrency boundary = unique(plan_id, period_start) + the order
--   idempotency key, not application checks alone.
-- ============================================================================

-- ============================================================
-- 1. ADDITIVE extension of the per-item outcome vocabulary (superset).
-- ============================================================
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.financial_operation_run_items'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%outcome%';
  if c is not null then execute format('alter table public.financial_operation_run_items drop constraint %I', c); end if;
end $$;
alter table public.financial_operation_run_items
  add constraint financial_operation_run_items_outcome_check check (outcome in (
    -- Stage 3C2-A earning_release (unchanged)
    'released', 'already_payable', 'not_found', 'not_yet_eligible', 'issue_held',
    'evidence_held', 'reversed', 'transfer_already_started', 'invalid_state', 'failed',
    -- Stage 3C2-B plan_renewal
    'renewed_credit_covered', 'renewal_prepared', 'closed_zero_occurrences',
    'already_renewed', 'action_required_existing', 'payment_failed_existing',
    'plan_not_active', 'plan_paused', 'plan_ended', 'billing_not_enabled', 'not_recurring'));

-- ============================================================
-- 2. ADDITIVE extension of the run-event action vocabulary (superset).
-- ============================================================
alter table public.financial_operation_run_events
  drop constraint if exists financial_operation_run_events_action_check;
alter table public.financial_operation_run_events
  add constraint financial_operation_run_events_action_check check (action in (
    'requested', 'preview_generated', 'confirmation_requested', 'execution_started',
    'record_claimed', 'record_skipped', 'record_succeeded', 'record_failed',
    'cancelled', 'expired', 'control_blocked',
    'item_released', 'item_skipped', 'item_failed',
    'item_renewed', 'item_prepared',
    'execution_succeeded', 'execution_partially_succeeded', 'execution_failed'));

-- ============================================================
-- 3. SINGLE PLAN-RENEWAL AUTHORITY (read-only classifier). Used by BOTH preview
--    and execution. Computes against ONE explicit plan for ONE explicit as-of
--    instant; never selects arbitrary due plans; mutates nothing; exposes no
--    payment-method identifiers, provider ids or secrets (predicted credit is
--    capped at the period net so the account balance is not disclosed).
-- ============================================================
create or replace function app_private.classify_plan_renewal(p_plan_id uuid, p_as_of timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  p public.conversation_plans;
  bp public.plan_billing_periods;
  v_period date; v_end date;
  v_occ integer; v_gross integer; v_discount integer; v_net integer;
  v_credit integer; v_applied integer; v_card integer;
  v_pm_ready boolean;
  v_outcome text; v_reason text; v_eligible boolean := false; v_provider boolean := false;
  v_reasons text[] := '{}';
begin
  v_period := date_trunc('month', p_as_of)::date;
  v_end := app_private.monthly_period_end(v_period);

  select * into p from public.conversation_plans where id = p_plan_id;
  if p.id is null then
    return jsonb_build_object('id', p_plan_id, 'found', false, 'outcome', 'not_found', 'eligible', false,
      'current_state', null, 'reason_code', 'plan_not_found', 'period_start', v_period, 'period_end', v_end,
      'expected_next_state', null, 'blocking_reasons', to_jsonb(array['not_found']),
      'blocked_by_open_issue', false, 'blocked_by_dispute', false, 'blocked_by_evidence_hold', false);
  end if;

  select * into bp from public.plan_billing_periods where plan_id = p_plan_id and period_start = v_period;

  if p.status = 'paused' then
    v_outcome := 'plan_paused'; v_reason := 'plan_paused'; v_reasons := array_append(v_reasons, 'plan_paused');
  elsif p.status = 'ended' then
    v_outcome := 'plan_ended'; v_reason := 'plan_ended'; v_reasons := array_append(v_reasons, 'plan_ended');
  elsif p.status <> 'active' then
    v_outcome := 'plan_not_active'; v_reason := 'plan_status_' || p.status; v_reasons := array_append(v_reasons, 'plan_not_active');
  elsif p.funding_mode <> 'recurring' then
    v_outcome := 'not_recurring'; v_reason := 'funding_mode_' || p.funding_mode; v_reasons := array_append(v_reasons, 'not_recurring');
  elsif not p.billing_enabled then
    v_outcome := 'billing_not_enabled'; v_reason := 'billing_not_enabled'; v_reasons := array_append(v_reasons, 'billing_not_enabled');
  elsif bp.id is not null and bp.status in ('paid', 'closed', 'processing') then
    v_outcome := 'already_renewed';
    v_reason := case when bp.status = 'processing' then 'settlement_in_flight' else 'period_' || bp.status end;
    v_reasons := array_append(v_reasons, 'already_renewed');
  elsif bp.id is not null and bp.status in ('payment_pending', 'action_required') then
    v_outcome := 'action_required_existing'; v_reason := 'period_' || bp.status; v_provider := true;
    v_reasons := array_append(v_reasons, 'provider_action_already_pending');
  elsif bp.id is not null and bp.status = 'payment_failed' then
    v_outcome := 'payment_failed_existing'; v_reason := 'period_payment_failed_terminal';
    v_reasons := array_append(v_reasons, 'payment_failed_terminal');
  end if;

  if v_outcome is not null then
    return jsonb_build_object('id', p_plan_id, 'found', true, 'outcome', v_outcome, 'eligible', false,
      'current_state', p.status || case when bp.id is null then '' else '/' || bp.status end,
      'plan_status', p.status, 'existing_period_status', bp.status,
      'reason_code', v_reason, 'period_start', v_period, 'period_end', v_end,
      'provider_action_required', v_provider, 'currency', p.currency,
      'expected_next_state', coalesce(bp.status, p.status),
      'blocking_reasons', to_jsonb(v_reasons),
      'blocked_by_open_issue', false, 'blocked_by_dispute', false, 'blocked_by_evidence_hold', false);
  end if;

  -- Eligible path: authoritative occurrence count + pricing snapshot (identical
  -- arithmetic to renew_plan_billing_period; read-only here).
  select count(*)::integer into v_occ
    from public.plan_schedule_slots s
    join generate_series(v_period, (v_end - 1), interval '1 day') d(day)
      on extract(isodow from d.day)::int = s.iso_day
    where s.plan_id = p_plan_id;
  v_gross := v_occ * p.per_conversation_price_minor;
  v_discount := (v_gross * 10) / 100;
  v_net := v_gross - v_discount;

  if v_net = 0 then
    v_outcome := 'closed_zero_occurrences'; v_eligible := true; v_reason := 'no_billable_occurrences';
    v_applied := 0; v_card := 0;
  else
    select coalesce(sum(remaining_minor), 0)::integer into v_credit
      from public.credit_ledger
     where coordinator_account_id = p.created_by_account_id
       and entry_type = 'credit' and remaining_minor > 0
       and (expires_at is null or expires_at > p_as_of);
    v_applied := least(v_credit, v_net);            -- capped: never exposes the full balance
    v_card := v_net - v_applied;
    if v_card = 0 then
      v_outcome := 'renewed_credit_covered'; v_eligible := true; v_reason := 'credit_covers_period';
    else
      v_outcome := 'renewal_prepared'; v_eligible := true; v_provider := true;
      select exists (select 1 from public.stripe_customers
                     where account_id = p.created_by_account_id and payment_method_ready = true)
        into v_pm_ready;
      v_reason := case when v_pm_ready then 'provider_charge_pending' else 'payment_method_required' end;
    end if;
  end if;

  return jsonb_build_object('id', p_plan_id, 'found', true, 'outcome', v_outcome, 'eligible', v_eligible,
    'current_state', p.status || case when bp.id is null then '' else '/' || bp.status end,
    'plan_status', p.status, 'existing_period_status', bp.status,
    'reason_code', v_reason, 'period_start', v_period, 'period_end', v_end,
    'occurrences', v_occ, 'gross_minor', v_gross, 'discount_minor', v_discount, 'net_minor', v_net,
    'credit_applied_minor', v_applied, 'card_amount_minor', v_card, 'currency', p.currency,
    'provider_action_required', v_provider, 'payment_method_ready', coalesce(v_pm_ready, true),
    'expected_next_state', case v_outcome when 'closed_zero_occurrences' then 'closed'
                                          when 'renewed_credit_covered' then 'paid'
                                          else 'payment_pending' end,
    'blocking_reasons', to_jsonb(v_reasons),
    'blocked_by_open_issue', false, 'blocked_by_dispute', false, 'blocked_by_evidence_hold', false);
end;
$$;
revoke all on function app_private.classify_plan_renewal(uuid, timestamptz) from public, anon, authenticated;
grant execute on function app_private.classify_plan_renewal(uuid, timestamptz) to service_role;

-- ============================================================
-- 4. THE RECORD-SCOPED PLAN-RENEWAL EXECUTOR. Inert unless invoked inside the
--    authorised wrapper's transaction-local context (begin_scoped_operation_
--    execution, reused unchanged from 0075). The state transition itself is the
--    EXISTING authoritative public.renew_plan_billing_period — never
--    reimplemented, never called for an ineligible plan. Revoked from every
--    client role AND service_role.
-- ============================================================
create or replace function app_private.execute_scoped_plan_renewal(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.financial_operation_runs;
  v_env text; v_ctrl text; v_max int;
  v_as_of timestamptz; v_period date;
  v_rec record; v_cls jsonb; v_res jsonb; v_bp public.plan_billing_periods;
  v_outcome text; v_reason text; v_before text; v_after text; v_details jsonb;
  v_requested int := 0; v_renewed int := 0; v_prepared int := 0; v_already int := 0;
  v_skipped int := 0; v_failed int := 0;
  v_run_state text; v_summary_action text; v_event text;
begin
  -- --- (0) UNFORGEABLE CONTEXT GATE: refuse before any plan read/lock/mutation
  -- unless the wrapper bound THIS run + plan_renewal in THIS transaction.
  if nullif(current_setting('app.scoped_op_exec_op', true), '') is distinct from 'plan_renewal'
     or nullif(current_setting('app.scoped_op_exec_run', true), '') is distinct from p_run_id::text then
    raise exception 'execution_context_required: the scoped executor runs only inside an authorised operation wrapper';
  end if;

  -- --- INDEPENDENT REVALIDATION (defence in depth; wrapper + context fn also check) ---
  select * into v_run from public.financial_operation_runs where id = p_run_id for update;   -- serialise executions of one run
  if v_run.id is null then raise exception 'not_found: run'; end if;
  if v_run.operation_type <> 'plan_renewal' then raise exception 'operation_mismatch: % is not plan_renewal', v_run.operation_type; end if;
  if v_run.executed_at is not null or v_run.state = 'completed' or v_run.state = 'failed' then
    return coalesce(v_run.result_summary, '{}'::jsonb)
      || jsonb_build_object('ok', v_run.rows_failed = 0, 'executed', false, 'already_executed', true,
                            'run_id', p_run_id, 'operation_type', 'plan_renewal');
  end if;
  if v_run.state = 'cancelled' then raise exception 'run_cancelled: this run was cancelled'; end if;
  if v_run.expires_at <= now() then
    update public.financial_operation_runs set state = 'expired' where id = p_run_id;
    raise exception 'run_expired: this run has expired';
  end if;
  if v_run.state <> 'confirmed' then raise exception 'confirmation_required: confirm the run before executing'; end if;
  if v_run.scope_type <> 'record_ids' then raise exception 'scope_required: scoped_execution requires explicit record ids'; end if;
  if array_length(v_run.scoped_ids, 1) is null then raise exception 'empty_scope: at least one plan id is required'; end if;
  select max_batch_limit into v_max from public.financial_operations_config where id = true;
  if array_length(v_run.scoped_ids, 1) > v_max then raise exception 'batch_limit_exceeded: scope exceeds the maximum batch size'; end if;

  -- --- CONTROL + ENVIRONMENT gate (identical semantics to 0075: 'enabled' is
  -- NEVER valid outside production_live; production_live needs op + master).
  v_env := app_private.current_financial_environment();
  v_ctrl := app_private.effective_control_state('plan_renewal');
  if v_env = 'production_live' then
    if v_ctrl <> 'enabled' then raise exception 'control_disabled: plan_renewal is not enabled'; end if;
    if app_private.effective_control_state('production_live_operations') <> 'enabled' then
      raise exception 'production_live_locked: the production master control is disabled';
    end if;
  else
    if v_ctrl <> 'scoped_execution' then raise exception 'control_disabled: plan_renewal is not executable'; end if;
  end if;

  -- ONE as-of instant for the whole run ⇒ deterministic period key for every item.
  v_as_of := now();
  v_period := date_trunc('month', v_as_of)::date;

  update public.financial_operation_runs set state = 'executing', started_at = now() where id = p_run_id;
  if not exists (select 1 from public.financial_operation_run_events e where e.run_id = p_run_id and e.action = 'execution_started') then
    insert into public.financial_operation_run_events (run_id, action, actor_account_id) values (p_run_id, 'execution_started', auth.uid());
  end if;

  -- --- PER-PLAN execution over the DEDUPLICATED, explicitly-scoped ids ONLY.
  -- Each record runs in its OWN savepoint; auth/run/context failures happen ABOVE.
  for v_rec in
    select id, row_number() over (order by first_pos) as ordinal
    from (select u.id, min(u.pos) as first_pos
            from unnest(v_run.scoped_ids) with ordinality as u(id, pos)
           group by u.id) d
  loop
    v_requested := v_requested + 1;
    v_outcome := null; v_reason := null; v_before := null; v_after := null; v_details := '{}'::jsonb;
    begin
      -- Lock the plan (serialises against a concurrent run / pause / renewal).
      perform 1 from public.conversation_plans where id = v_rec.id for update;
      select p.status || coalesce('/' || bp.status, '') into v_before
        from public.conversation_plans p
        left join public.plan_billing_periods bp on bp.plan_id = p.id and bp.period_start = v_period
        where p.id = v_rec.id;

      -- SINGLE classification authority (same classifier preview uses), under our lock.
      v_cls := app_private.classify_plan_renewal(v_rec.id, v_as_of);
      v_outcome := v_cls->>'outcome';
      v_reason  := v_cls->>'reason_code';

      if (v_cls->>'eligible')::boolean then
        -- AUTHORITATIVE transition (sole authority; never reimplemented). It
        -- re-locks the plan/period, re-checks existing-period no-ops, creates the
        -- idempotent order, reserves credit ONCE, and settles ONLY a zero-card
        -- period. Card-funded periods stop in 'payment_pending' (no provider call).
        v_res := public.renew_plan_billing_period(v_rec.id, v_period);
        select * into v_bp from public.plan_billing_periods where plan_id = v_rec.id and period_start = v_period;
        if coalesce((v_res->>'ok')::boolean, false) is not true then
          v_outcome := 'failed'; v_reason := 'renewal_' || coalesce(v_res->>'reason', 'not_applied');
        elsif coalesce((v_res->>'repeat')::boolean, false) then
          -- Raced: another transaction renewed between classify and transition.
          v_outcome := case when v_bp.status in ('paid', 'closed', 'processing') then 'already_renewed'
                            when v_bp.status in ('payment_pending', 'action_required') then 'action_required_existing'
                            else 'payment_failed_existing' end;
          v_reason := 'period_' || v_bp.status;
        elsif v_bp.status = 'paid' then v_outcome := 'renewed_credit_covered'; v_reason := 'credit_covers_period';
        elsif v_bp.status = 'closed' then v_outcome := 'closed_zero_occurrences'; v_reason := 'no_billable_occurrences';
        elsif v_bp.status in ('payment_pending', 'action_required') then
          v_outcome := 'renewal_prepared';   -- provider work pending; NOT paid, NO provider call
        elsif v_bp.status = 'processing' then v_outcome := 'renewed_credit_covered'; v_reason := 'settlement_in_flight';
        else v_outcome := 'failed'; v_reason := 'unexpected_period_state_' || coalesce(v_bp.status, 'missing');
        end if;
        v_details := jsonb_build_object(
          'period_start', v_period, 'period_end', v_bp.period_end,
          'occurrences', v_bp.occurrences_count, 'gross_minor', v_bp.gross_minor,
          'net_minor', v_bp.net_minor, 'credit_applied_minor', v_bp.credit_applied_minor,
          'card_amount_minor', v_bp.card_amount_minor, 'currency', v_bp.currency,
          'period_status', v_bp.status,
          'provider_action_required', v_bp.status in ('payment_pending', 'action_required'));
      else
        v_details := jsonb_build_object('period_start', v_period,
          'existing_period_status', v_cls->>'existing_period_status',
          'provider_action_required', coalesce((v_cls->>'provider_action_required')::boolean, false));
      end if;

      select p.status || coalesce('/' || bp.status, '') into v_after
        from public.conversation_plans p
        left join public.plan_billing_periods bp on bp.plan_id = p.id and bp.period_start = v_period
        where p.id = v_rec.id;

      insert into public.financial_operation_run_items
        (run_id, operation_type, record_id, ordinal, outcome, reason_code, before_state, after_state, attempted_at, completed_at, safe_details)
      values (p_run_id, 'plan_renewal', v_rec.id, v_rec.ordinal, v_outcome, v_reason, v_before, v_after, now(), now(), v_details)
      on conflict (run_id, record_id) do nothing;

      v_event := case v_outcome
        when 'renewed_credit_covered' then 'item_renewed'
        when 'closed_zero_occurrences' then 'item_renewed'
        when 'renewal_prepared' then 'item_prepared'
        when 'failed' then 'item_failed'
        else 'item_skipped' end;
      insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id, detail)
      values (p_run_id, v_event, v_rec.id, auth.uid(), jsonb_build_object('outcome', v_outcome, 'reason_code', v_reason));
    exception when others then
      -- PER-ITEM CONTAINMENT: subtransaction rolled back; record a safe failure
      -- (SQLSTATE only — never raw error text with financial/personal data).
      v_outcome := 'failed';
      v_reason  := 'item_exception:' || substr(coalesce(nullif(sqlstate, ''), 'XXXXX'), 1, 5);
      insert into public.financial_operation_run_items
        (run_id, operation_type, record_id, ordinal, outcome, reason_code, before_state, after_state, attempted_at, completed_at, safe_details)
      values (p_run_id, 'plan_renewal', v_rec.id, v_rec.ordinal, 'failed', v_reason, v_before, null, now(), now(),
              jsonb_build_object('outcome', 'failed', 'sqlstate', sqlstate))
      on conflict (run_id, record_id) do nothing;
      insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id, detail)
      values (p_run_id, 'item_failed', v_rec.id, auth.uid(), jsonb_build_object('outcome', 'failed', 'reason_code', v_reason));
    end;

    if v_outcome in ('renewed_credit_covered', 'closed_zero_occurrences') then v_renewed := v_renewed + 1;
    elsif v_outcome = 'renewal_prepared' then v_prepared := v_prepared + 1;
    elsif v_outcome = 'already_renewed' then v_already := v_already + 1;
    elsif v_outcome = 'failed' then v_failed := v_failed + 1;
    else v_skipped := v_skipped + 1;
    end if;
  end loop;

  -- --- RUN-LEVEL result. Existing state vocab only (completed / failed).
  v_run_state := case when v_failed > 0 and v_renewed = 0 and v_prepared = 0 and v_already = 0 then 'failed' else 'completed' end;
  v_summary_action := case
    when v_failed > 0 and v_renewed = 0 and v_prepared = 0 and v_already = 0 then 'execution_failed'
    when v_failed > 0 or v_skipped > 0 then 'execution_partially_succeeded'
    else 'execution_succeeded' end;
  update public.financial_operation_runs
     set state = v_run_state, executed_at = now(), completed_at = now(),
         rows_examined = v_requested, rows_eligible = v_renewed + v_prepared,
         rows_claimed = v_renewed + v_prepared, rows_succeeded = v_renewed + v_prepared + v_already, rows_failed = v_failed,
         result_summary = jsonb_build_object('executed_at', now(), 'as_of', v_as_of, 'period_start', v_period,
           'requested_count', v_requested, 'renewed_count', v_renewed, 'prepared_count', v_prepared,
           'already_done_count', v_already, 'skipped_count', v_skipped, 'failed_count', v_failed)
   where id = p_run_id;
  insert into public.financial_operation_run_events (run_id, action, actor_account_id, detail)
    values (p_run_id, v_summary_action, auth.uid(),
            jsonb_build_object('renewed', v_renewed, 'prepared', v_prepared, 'already', v_already,
                               'skipped', v_skipped, 'failed', v_failed));

  return jsonb_build_object('ok', v_failed = 0, 'executed', true, 'run_id', p_run_id, 'operation_type', 'plan_renewal',
    'state', v_run_state, 'period_start', v_period, 'requested_count', v_requested,
    'renewed_count', v_renewed, 'prepared_count', v_prepared, 'already_done_count', v_already,
    'skipped_count', v_skipped, 'failed_count', v_failed);
end;
$$;
-- The support wrapper is the ONLY entry point. No client role and NOT
-- service_role may call the executor directly.
revoke all on function app_private.execute_scoped_plan_renewal(uuid) from public, anon, authenticated, service_role;

-- ============================================================
-- 5. SUPPORT EXECUTE WRAPPER — from the EXACT applied 0075 body; the ONLY change
--    is the added plan_renewal branch (context then delegate). All 0074/0075
--    guards + the deduplicated control_blocked structured-result contract + the
--    earning_release branch are byte-for-byte unchanged.
-- ============================================================
create or replace function public.support_execute_operation_run(p_run_id uuid, p_confirmation_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.financial_operation_runs; v_control text; v_state text;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: run'; end if;
  select * into v_run from public.financial_operation_runs where id = p_run_id for update;
  if v_run.id is null then raise exception 'not_found: run'; end if;
  if v_run.confirmation_token is distinct from p_confirmation_token then raise exception 'invalid_token: confirmation token mismatch'; end if;
  if v_run.executed_at is not null or v_run.state = 'completed' then
    return jsonb_build_object('ok', true, 'already_executed', true, 'state', v_run.state);   -- idempotent
  end if;
  if v_run.state = 'cancelled' then raise exception 'run_cancelled: this run was cancelled'; end if;
  if v_run.expires_at <= now() then
    update public.financial_operation_runs set state = 'expired' where id = p_run_id;
    insert into public.financial_operation_run_events (run_id, action, actor_account_id) values (p_run_id, 'expired', auth.uid());
    raise exception 'run_expired: this run has expired';
  end if;
  if v_run.execution_mode = 'preview' then raise exception 'not_executable: preview runs never execute'; end if;
  if v_run.state <> 'confirmed' then raise exception 'confirmation_required: confirm the run before executing'; end if;

  v_control := v_run.operation_type;
  v_state := app_private.effective_control_state(v_control);
  -- EXPECTED OPERATIONAL BLOCK: persist ONE deduplicated audit event and return a
  -- structured result (do NOT raise — a raise would roll the event back).  [0074]
  if v_state in ('disabled', 'dry_run_only') then
    if not exists (select 1 from public.financial_operation_run_events e
                   where e.run_id = p_run_id and e.action = 'control_blocked') then
      insert into public.financial_operation_run_events (run_id, action, actor_account_id, detail)
        values (p_run_id, 'control_blocked', auth.uid(),
                jsonb_build_object('control', v_control, 'control_state', v_state));
    end if;
    return jsonb_build_object('ok', false, 'executed', false,
      'code', case when v_state = 'disabled' then 'control_disabled' else 'dry_run_only' end,
      'control', v_control, 'control_state', v_state);
  end if;
  if v_state = 'scoped_execution' and v_run.scope_type <> 'record_ids' then
    raise exception 'scope_required: scoped_execution requires explicit record ids';
  end if;
  -- Stage 3C2-A: earning_release record-scoped executor (unchanged).
  if v_control = 'earning_release' then
    perform app_private.begin_scoped_operation_execution(p_run_id, 'earning_release');
    return app_private.execute_scoped_earning_release(p_run_id);
  end if;
  -- Stage 3C2-B: plan_renewal record-scoped executor. Establish the unforgeable
  -- execution context (only after every guard above), then delegate. Every other
  -- operation type remains deferred to a later stage.
  if v_control = 'plan_renewal' then
    perform app_private.begin_scoped_operation_execution(p_run_id, 'plan_renewal');
    return app_private.execute_scoped_plan_renewal(p_run_id);
  end if;
  raise exception 'stage_not_enabled: % execution is deferred to a later stage', v_control;
end;
$$;
revoke all on function public.support_execute_operation_run(uuid, text) from public, anon;
grant execute on function public.support_execute_operation_run(uuid, text) to authenticated;

-- ============================================================
-- 6. SUPPORT PREVIEW — from the EXACT applied 0075 body; the ONLY change is the
--    added plan_renewal branch built from the SHARED classifier (one row per
--    DISTINCT plan id, first-occurrence order; not_found does not abort
--    siblings). Side-effect-free on financial rows: run metadata + one
--    preview_generated event only. Execution reclassifies and never trusts
--    preview output.
-- ============================================================
create or replace function public.support_preview_operation_run(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.financial_operation_runs; v_ids uuid[]; v_rows jsonb; v_elig integer; v_examined integer;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: run'; end if;
  select * into v_run from public.financial_operation_runs where id = p_run_id;
  if v_run.id is null then raise exception 'not_found: run'; end if;
  if v_run.state in ('cancelled','expired','completed','failed') then
    raise exception 'run_closed: this run can no longer be previewed';
  end if;
  v_ids := app_private.operation_candidate_ids(v_run);
  if v_run.operation_type = 'earning_release' then
    select coalesce(jsonb_agg(app_private.classify_earning_release(d.id) order by d.ord), '[]'::jsonb)
      into v_rows
      from (select g.id, row_number() over (order by g.first_pos) as ord
              from (select u.id, min(u.pos) as first_pos
                      from unnest(coalesce(v_ids, '{}')) with ordinality as u(id, pos)
                     group by u.id) g) d;
  elsif v_run.operation_type = 'plan_renewal' then
    select coalesce(jsonb_agg(app_private.classify_plan_renewal(d.id, now()) order by d.ord), '[]'::jsonb)
      into v_rows
      from (select g.id, row_number() over (order by g.first_pos) as ord
              from (select u.id, min(u.pos) as first_pos
                      from unnest(coalesce(v_ids, '{}')) with ordinality as u(id, pos)
                     group by u.id) g) d;
  else
    v_rows := app_private.operation_preview_rows(v_run.operation_type, v_ids);
  end if;
  v_examined := jsonb_array_length(v_rows);
  select count(*) into v_elig from jsonb_array_elements(v_rows) r where (r->>'eligible')::boolean;
  -- Record ONLY run metadata (no financial-row mutation).
  update public.financial_operation_runs
     set state = case when state = 'requested' then 'previewed' else state end,
         rows_examined = v_examined, rows_eligible = v_elig,
         result_summary = jsonb_build_object('previewed_at', now(), 'eligible', v_elig, 'examined', v_examined)
   where id = p_run_id;
  insert into public.financial_operation_run_events (run_id, action, actor_account_id, detail)
    values (p_run_id, 'preview_generated', auth.uid(), jsonb_build_object('examined', v_examined, 'eligible', v_elig));
  return jsonb_build_object('ok', true, 'run_id', p_run_id, 'operation_type', v_run.operation_type,
    'examined', v_examined, 'eligible', v_elig, 'rows', v_rows);
end;
$$;
revoke all on function public.support_preview_operation_run(uuid) from public, anon;
grant execute on function public.support_preview_operation_run(uuid) to authenticated;

-- ============================================================
-- 7. PostgREST schema reload.
-- ============================================================
select pg_notify('pgrst', 'reload schema');
