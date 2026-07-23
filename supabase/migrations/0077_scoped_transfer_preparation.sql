-- ============================================================================
-- 0077_scoped_transfer_preparation.sql  (Stage 3C2-C1)
--
-- Scoped TRANSFER PREPARATION — a safe operations workflow for explicit transfer
-- records WITHOUT moving money. This stage NEVER creates, retries, cancels or
-- reverses a provider transfer; it contains no Stripe/pg_net/HTTP/Edge/cron code.
-- Provider transfer creation is Stage 3C2-C2.
--
-- ADDITIVE ONLY (0001–0076 immutable). This migration:
--   * additively extends the item-outcome and event-action vocabularies;
--   * adds ONE read-only classifier app_private.classify_scoped_transfer
--     (earning-scoped; used by BOTH preview and execution). It never infers
--     provider absence from a NULL local stripe_transfer_id: a processing
--     attempt without a provider id classifies as provider_lookup_required —
--     never retryable, never eligible for a new transfer;
--   * adds app_private.execute_scoped_transfer_preparation(p_run_id) — the
--     record-scoped executor (hardened 3C2-A/B architecture: transaction-local
--     run+operation context, independent revalidation, one p_as_of per run,
--     per-earning locks, per-item savepoints, durable items, idempotent repeat).
--     Its ONLY mutation is the narrowest safe local preparation: for a fully
--     eligible earning with NO existing attempt it inserts a
--     companion_transfer_attempts row in state 'queued' (attempt_count 0,
--     claimed_at NULL, deterministic idempotency key 'transfer-<earning>').
--     AUDITED SAFE: no worker consumes 'queued' — the provider path starts only
--     at claim_plan_transfers (kill-switch-gated, selects EARNINGS not queued
--     attempts) and the only reader of 'queued' is the read-only 0063
--     reconciliation detector. The earning row itself is NEVER touched. It never
--     resets a processing attempt, never creates a second attempt (unique
--     earning_id is the DB boundary), never overrides a permanent failure and
--     never calls a finalisation RPC;
--   * redefines public.support_execute_operation_run from the EXACT applied 0076
--     body, adding ONLY the transfer_claim branch (context then delegate);
--   * redefines public.support_preview_operation_run from the EXACT applied 0076
--     body, adding ONLY a transfer_claim branch built from the shared classifier.
--
-- CANONICAL SCOPE (audited): the earning UUID. companion_transfer_attempts is
-- 1:1 with earnings (unique earning_id) with unique idempotency_key and unique
-- stripe_transfer_id; attempt states queued/processing/succeeded/failed_retryable/
-- failed_permanent/reversed; earning transfer_state not_ready/ready/
-- transfer_pending/processing/transferred/failed/reversed. The provider path:
-- 0049 cron → stripe-transfers Edge Fn → recover_stale_transfers +
-- claim_plan_transfers (batch_worker_enabled-gated) → POST /v1/transfers with the
-- stable idempotency key → finalize_transfer_* ; webhook transfer.* events attach
-- missing provider ids via metadata. None of that is invoked here.
--
-- PROTECTED HISTORICAL STATE: this migration references no historical row; the
-- protected booking/earning/attempt (processing with NULL provider id) is exactly
-- why processing-without-provider-id maps to provider_lookup_required and is left
-- byte-for-byte unchanged by every path in this stage.
-- ============================================================================

-- ============================================================
-- 1. ADDITIVE item-outcome vocabulary extension (superset).
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
    -- Stage 3C2-B plan_renewal (unchanged)
    'renewed_credit_covered', 'renewal_prepared', 'closed_zero_occurrences',
    'already_renewed', 'action_required_existing', 'payment_failed_existing',
    'plan_not_active', 'plan_paused', 'plan_ended', 'billing_not_enabled', 'not_recurring',
    -- Stage 3C2-C1 transfer preparation
    'prepared_for_provider', 'provider_lookup_required', 'already_processing',
    'already_transferred', 'not_payable', 'held_for_issue', 'connect_not_ready',
    'zero_amount', 'retryable_failure', 'permanent_failure'));

-- ============================================================
-- 2. ADDITIVE event-action vocabulary extension (superset).
-- ============================================================
alter table public.financial_operation_run_events
  drop constraint if exists financial_operation_run_events_action_check;
alter table public.financial_operation_run_events
  add constraint financial_operation_run_events_action_check check (action in (
    'requested', 'preview_generated', 'confirmation_requested', 'execution_started',
    'record_claimed', 'record_skipped', 'record_succeeded', 'record_failed',
    'cancelled', 'expired', 'control_blocked',
    'item_released', 'item_skipped', 'item_failed',
    'item_renewed', 'item_prepared', 'item_provider_lookup_required',
    'execution_succeeded', 'execution_partially_succeeded', 'execution_failed'));

-- ============================================================
-- 3. SINGLE TRANSFER-PREPARATION AUTHORITY (read-only classifier). Earning-
--    scoped; shared by preview and execution. It mirrors the claim_plan_transfers
--    eligibility predicate for the LOCAL side, and treats provider state with
--    maximum caution: a NULL local provider id NEVER means the provider transfer
--    is absent. Exposes only support-safe facts — no destination account id, no
--    idempotency key value, no provider payloads, no bank/card/token data.
-- ============================================================
create or replace function app_private.classify_scoped_transfer(p_earning_id uuid, p_as_of timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  e public.companion_earnings;
  ta public.companion_transfer_attempts;
  v_order_ok boolean; v_period_ok boolean; v_connect_ok boolean; v_currency_ok boolean;
  v_issue boolean; v_hold boolean;
  v_outcome text; v_reason text; v_eligible boolean := false; v_lookup boolean := false;
  v_reasons text[] := '{}';
begin
  select * into e from public.companion_earnings where id = p_earning_id;
  if e.id is null then
    return jsonb_build_object('id', p_earning_id, 'found', false, 'outcome', 'not_found', 'eligible', false,
      'current_state', null, 'reason_code', 'earning_not_found',
      'provider_lookup_required', false, 'expected_next_state', null,
      'blocking_reasons', to_jsonb(array['not_found']),
      'blocked_by_open_issue', false, 'blocked_by_dispute', false, 'blocked_by_evidence_hold', false);
  end if;

  select * into ta from public.companion_transfer_attempts where earning_id = p_earning_id;

  -- Provider-state caution FIRST (these dominate every local consideration).
  if (ta.id is not null and ta.state = 'succeeded') or e.transfer_state = 'transferred' then
    v_outcome := 'already_transferred'; v_reason := 'transfer_settled';
  elsif (ta.id is not null and ta.state = 'reversed') or e.state = 'reversed' or e.transfer_state = 'reversed' then
    v_outcome := 'reversed'; v_reason := 'transfer_or_earning_reversed';
  elsif ta.id is not null and ta.state = 'failed_permanent' then
    v_outcome := 'permanent_failure'; v_reason := 'provider_rejected_permanently';
  elsif (ta.id is not null and ta.state = 'processing') or e.transfer_state in ('transfer_pending', 'processing') then
    if ta.id is not null and ta.stripe_transfer_id is not null then
      v_outcome := 'already_processing'; v_reason := 'provider_transfer_in_flight';
    else
      -- A NULL local provider id NEVER proves provider absence: the provider may
      -- have succeeded before the local write (the audited crash window). NEVER
      -- retryable; NEVER eligible for a new transfer; C2 must look the provider
      -- up (by attempt metadata) immediately before ANY creation.
      v_outcome := 'provider_lookup_required'; v_reason := 'processing_without_provider_id';
      v_lookup := true;
    end if;
  elsif ta.id is not null and ta.state = 'failed_retryable' then
    -- C1 boundary: no retry-state change, no re-claim. The provider retry (with
    -- a fresh pre-creation lookup) is Stage 3C2-C2.
    v_outcome := 'retryable_failure'; v_reason := 'retry_deferred_to_provider_stage';
  elsif e.state = 'held_for_issue' then
    v_outcome := 'held_for_issue'; v_reason := 'earning_held_for_issue';
  elsif exists (select 1 from public.conversation_issues i
                where i.booking_id = e.booking_id and i.state <> 'resolved') then
    v_outcome := 'held_for_issue'; v_reason := 'open_conversation_issue';
  elsif app_private.evidence_hold_blocks_payout(e.booking_id) then
    v_outcome := 'evidence_held'; v_reason := 'active_evidence_review';
  elsif e.state <> 'payable' then
    v_outcome := 'not_payable'; v_reason := 'earning_state_' || e.state;
  elsif coalesce(e.net_minor, 0) <= 0 then
    v_outcome := 'zero_amount'; v_reason := 'nothing_to_transfer';
  elsif e.transfer_state not in ('not_ready', 'ready', 'failed') then
    v_outcome := 'invalid_state'; v_reason := 'transfer_state_' || e.transfer_state;
  else
    -- Local funding/destination readiness (mirrors claim_plan_transfers).
    select exists (select 1 from public.payment_orders po
                   where po.id = e.payment_order_id and po.status = 'succeeded') into v_order_ok;
    select (e.plan_billing_period_id is null) or exists (
             select 1 from public.plan_billing_periods bp
             where bp.id = e.plan_billing_period_id and bp.status = 'paid') into v_period_ok;
    select exists (select 1 from public.connected_accounts ca
                   where ca.account_id = e.companion_account_id and ca.default_currency = 'gbp') into v_currency_ok;
    v_connect_ok := app_private.companion_payments_ready(e.companion_profile_id) and v_currency_ok;
    if not v_order_ok then
      v_outcome := 'connect_not_ready'; v_reason := 'order_not_settled';
    elsif not v_period_ok then
      v_outcome := 'connect_not_ready'; v_reason := 'billing_period_unpaid';
    elsif not v_connect_ok or e.currency <> 'GBP' then
      v_outcome := 'connect_not_ready'; v_reason := 'destination_not_ready';
    elsif ta.id is not null and ta.state = 'queued' then
      v_outcome := 'prepared_for_provider'; v_reason := 'already_prepared';   -- idempotent repeat
    else
      v_outcome := 'eligible_for_preparation'; v_eligible := true; v_reason := 'ready_for_local_preparation';
    end if;
  end if;

  if not v_eligible and v_outcome <> 'prepared_for_provider' then
    v_reasons := array_append(v_reasons, v_outcome);
  end if;

  return jsonb_build_object(
    'id', p_earning_id, 'found', true, 'outcome', v_outcome, 'eligible', v_eligible,
    'current_state', e.state || '/' || e.transfer_state,
    'earning_state', e.state, 'transfer_state', e.transfer_state,
    'attempt_id', ta.id, 'attempt_state', ta.state,
    'amount_minor', e.net_minor, 'currency', e.currency,
    'destination_ready', app_private.companion_payments_ready(e.companion_profile_id),
    'provider_id_present', (ta.id is not null and ta.stripe_transfer_id is not null),
    'idempotency_key_present', (ta.id is not null),
    'provider_lookup_required', v_lookup,
    'reason_code', v_reason,
    'expected_next_state', case when v_eligible then 'queued_attempt'
                                when v_outcome = 'prepared_for_provider' then 'queued_attempt'
                                else e.transfer_state end,
    'blocking_reasons', to_jsonb(v_reasons),
    'blocked_by_open_issue', (v_reason = 'open_conversation_issue'),
    'blocked_by_dispute', false,
    'blocked_by_evidence_hold', (v_outcome = 'evidence_held'));
end;
$$;
revoke all on function app_private.classify_scoped_transfer(uuid, timestamptz) from public, anon, authenticated;
grant execute on function app_private.classify_scoped_transfer(uuid, timestamptz) to service_role;

-- ============================================================
-- 4. THE RECORD-SCOPED TRANSFER-PREPARATION EXECUTOR. Database-only; NEVER calls
--    a provider, worker or finalisation RPC. Inert without the wrapper's
--    transaction-local context. Revoked from every client role AND service_role.
-- ============================================================
create or replace function app_private.execute_scoped_transfer_preparation(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.financial_operation_runs;
  v_env text; v_ctrl text; v_max int;
  v_as_of timestamptz;
  v_rec record; v_cls jsonb; e public.companion_earnings; v_dest text; v_ins uuid;
  v_outcome text; v_reason text; v_before text; v_after text; v_details jsonb; v_event text;
  v_requested int := 0; v_prepared int := 0; v_lookup int := 0; v_already int := 0;
  v_skipped int := 0; v_failed int := 0;
  v_run_state text; v_summary_action text;
begin
  -- --- (0) UNFORGEABLE CONTEXT GATE (before any earning/attempt read or lock).
  if nullif(current_setting('app.scoped_op_exec_op', true), '') is distinct from 'transfer_claim'
     or nullif(current_setting('app.scoped_op_exec_run', true), '') is distinct from p_run_id::text then
    raise exception 'execution_context_required: the scoped executor runs only inside an authorised operation wrapper';
  end if;

  -- --- INDEPENDENT REVALIDATION ---
  select * into v_run from public.financial_operation_runs where id = p_run_id for update;
  if v_run.id is null then raise exception 'not_found: run'; end if;
  if v_run.operation_type <> 'transfer_claim' then raise exception 'operation_mismatch: % is not transfer_claim', v_run.operation_type; end if;
  if v_run.executed_at is not null or v_run.state = 'completed' or v_run.state = 'failed' then
    return coalesce(v_run.result_summary, '{}'::jsonb)
      || jsonb_build_object('ok', v_run.rows_failed = 0, 'executed', false, 'already_executed', true,
                            'run_id', p_run_id, 'operation_type', 'transfer_claim');
  end if;
  if v_run.state = 'cancelled' then raise exception 'run_cancelled: this run was cancelled'; end if;
  if v_run.expires_at <= now() then
    update public.financial_operation_runs set state = 'expired' where id = p_run_id;
    raise exception 'run_expired: this run has expired';
  end if;
  if v_run.state <> 'confirmed' then raise exception 'confirmation_required: confirm the run before executing'; end if;
  if v_run.scope_type <> 'record_ids' then raise exception 'scope_required: scoped_execution requires explicit record ids'; end if;
  if array_length(v_run.scoped_ids, 1) is null then raise exception 'empty_scope: at least one earning id is required'; end if;
  select max_batch_limit into v_max from public.financial_operations_config where id = true;
  if array_length(v_run.scoped_ids, 1) > v_max then raise exception 'batch_limit_exceeded: scope exceeds the maximum batch size'; end if;

  -- --- CONTROL + ENVIRONMENT gate (identical semantics to 0075/0076).
  v_env := app_private.current_financial_environment();
  v_ctrl := app_private.effective_control_state('transfer_claim');
  if v_env = 'production_live' then
    if v_ctrl <> 'enabled' then raise exception 'control_disabled: transfer_claim is not enabled'; end if;
    if app_private.effective_control_state('production_live_operations') <> 'enabled' then
      raise exception 'production_live_locked: the production master control is disabled';
    end if;
  else
    if v_ctrl <> 'scoped_execution' then raise exception 'control_disabled: transfer_claim is not executable'; end if;
  end if;

  v_as_of := now();   -- one deterministic instant per run

  update public.financial_operation_runs set state = 'executing', started_at = now() where id = p_run_id;
  if not exists (select 1 from public.financial_operation_run_events ev where ev.run_id = p_run_id and ev.action = 'execution_started') then
    insert into public.financial_operation_run_events (run_id, action, actor_account_id) values (p_run_id, 'execution_started', auth.uid());
  end if;

  -- --- PER-EARNING execution over the DEDUPLICATED, explicitly-scoped ids ONLY.
  for v_rec in
    select id, row_number() over (order by first_pos) as ordinal
    from (select u.id, min(u.pos) as first_pos
            from unnest(v_run.scoped_ids) with ordinality as u(id, pos)
           group by u.id) d
  loop
    v_requested := v_requested + 1;
    v_outcome := null; v_reason := null; v_before := null; v_after := null; v_details := '{}'::jsonb;
    begin
      -- Lock the earning (serialises racing runs); classify UNDER the lock.
      select * into e from public.companion_earnings where id = v_rec.id for update;
      v_before := case when e.id is null then null else e.state || '/' || e.transfer_state end;
      v_cls := app_private.classify_scoped_transfer(v_rec.id, v_as_of);
      v_outcome := v_cls->>'outcome';
      v_reason  := v_cls->>'reason_code';

      if v_outcome = 'eligible_for_preparation' then
        -- THE narrow safe C1 mutation: one 'queued' attempt with the deterministic
        -- idempotency key. unique(earning_id) is the final concurrency boundary:
        -- a race loser inserts nothing and reclassifies. NO earning mutation, NO
        -- processing reset, NO second attempt, NO provider/finalisation call.
        select ca.stripe_account_id into v_dest
          from public.connected_accounts ca where ca.account_id = e.companion_account_id;
        insert into public.companion_transfer_attempts
          (earning_id, companion_account_id, companion_profile_id, connected_account_id,
           amount_minor, currency, state, attempt_count, idempotency_key)
        values (v_rec.id, e.companion_account_id, e.companion_profile_id, v_dest,
                e.net_minor, 'GBP', 'queued', 0, 'transfer-' || v_rec.id::text)
        on conflict (earning_id) do nothing
        returning id into v_ins;
        if v_ins is null then
          -- Raced: an attempt appeared between classify and insert — reclassify.
          v_cls := app_private.classify_scoped_transfer(v_rec.id, v_as_of);
          v_outcome := v_cls->>'outcome'; v_reason := v_cls->>'reason_code';
        else
          v_outcome := 'prepared_for_provider'; v_reason := 'queued_attempt_created';
        end if;
      end if;

      select case when e2.id is null then null else e2.state || '/' || e2.transfer_state end
        into v_after from public.companion_earnings e2 where e2.id = v_rec.id;
      v_details := jsonb_build_object(
        'attempt_id', coalesce(v_ins, (v_cls->>'attempt_id')::uuid),
        'attempt_state', coalesce((select ta.state from public.companion_transfer_attempts ta where ta.earning_id = v_rec.id), null),
        'amount_minor', v_cls->'amount_minor', 'currency', v_cls->>'currency',
        'transfer_state', v_cls->>'transfer_state',
        'provider_id_present', v_cls->'provider_id_present',
        'provider_lookup_required', v_cls->'provider_lookup_required',
        'idempotency_key_present', v_cls->'idempotency_key_present',
        'destination_ready', v_cls->'destination_ready');

      insert into public.financial_operation_run_items
        (run_id, operation_type, record_id, ordinal, outcome, reason_code, before_state, after_state, attempted_at, completed_at, safe_details)
      values (p_run_id, 'transfer_claim', v_rec.id, v_rec.ordinal, v_outcome, v_reason, v_before, v_after, now(), now(), v_details)
      on conflict (run_id, record_id) do nothing;

      v_event := case v_outcome
        when 'prepared_for_provider' then 'item_prepared'
        when 'provider_lookup_required' then 'item_provider_lookup_required'
        when 'failed' then 'item_failed'
        else 'item_skipped' end;
      insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id, detail)
      values (p_run_id, v_event, v_rec.id, auth.uid(), jsonb_build_object('outcome', v_outcome, 'reason_code', v_reason));
    exception when others then
      v_outcome := 'failed';
      v_reason  := 'item_exception:' || substr(coalesce(nullif(sqlstate, ''), 'XXXXX'), 1, 5);
      insert into public.financial_operation_run_items
        (run_id, operation_type, record_id, ordinal, outcome, reason_code, before_state, after_state, attempted_at, completed_at, safe_details)
      values (p_run_id, 'transfer_claim', v_rec.id, v_rec.ordinal, 'failed', v_reason, v_before, null, now(), now(),
              jsonb_build_object('outcome', 'failed', 'sqlstate', sqlstate))
      on conflict (run_id, record_id) do nothing;
      insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id, detail)
      values (p_run_id, 'item_failed', v_rec.id, auth.uid(), jsonb_build_object('outcome', 'failed', 'reason_code', v_reason));
    end;
    v_ins := null;

    if v_outcome = 'prepared_for_provider' and v_reason = 'queued_attempt_created' then v_prepared := v_prepared + 1;
    elsif v_outcome = 'provider_lookup_required' then v_lookup := v_lookup + 1;
    elsif v_outcome in ('already_transferred', 'already_processing', 'prepared_for_provider') then v_already := v_already + 1;
    elsif v_outcome = 'failed' then v_failed := v_failed + 1;
    else v_skipped := v_skipped + 1;
    end if;
  end loop;

  v_run_state := case when v_failed > 0 and v_prepared = 0 and v_already = 0 and v_lookup = 0 then 'failed' else 'completed' end;
  v_summary_action := case
    when v_failed > 0 and v_prepared = 0 and v_already = 0 and v_lookup = 0 then 'execution_failed'
    when v_failed > 0 or v_skipped > 0 or v_lookup > 0 then 'execution_partially_succeeded'
    else 'execution_succeeded' end;
  update public.financial_operation_runs
     set state = v_run_state, executed_at = now(), completed_at = now(),
         rows_examined = v_requested, rows_eligible = v_prepared,
         rows_claimed = v_prepared, rows_succeeded = v_prepared + v_already, rows_failed = v_failed,
         result_summary = jsonb_build_object('executed_at', now(), 'as_of', v_as_of,
           'requested_count', v_requested, 'prepared_count', v_prepared, 'lookup_required_count', v_lookup,
           'already_done_count', v_already, 'skipped_count', v_skipped, 'failed_count', v_failed)
   where id = p_run_id;
  insert into public.financial_operation_run_events (run_id, action, actor_account_id, detail)
    values (p_run_id, v_summary_action, auth.uid(),
            jsonb_build_object('prepared', v_prepared, 'lookup_required', v_lookup, 'already', v_already,
                               'skipped', v_skipped, 'failed', v_failed));

  return jsonb_build_object('ok', v_failed = 0, 'executed', true, 'run_id', p_run_id, 'operation_type', 'transfer_claim',
    'state', v_run_state, 'requested_count', v_requested, 'prepared_count', v_prepared,
    'lookup_required_count', v_lookup, 'already_done_count', v_already,
    'skipped_count', v_skipped, 'failed_count', v_failed);
end;
$$;
revoke all on function app_private.execute_scoped_transfer_preparation(uuid) from public, anon, authenticated, service_role;

-- ============================================================
-- 5. SUPPORT EXECUTE WRAPPER — from the EXACT applied 0076 body; the ONLY change
--    is the added transfer_claim branch (context then delegate). Every guard, the
--    control_blocked structured contract, and the earning_release + plan_renewal
--    branches are byte-for-byte unchanged.
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
  -- Stage 3C2-B: plan_renewal record-scoped executor (unchanged).
  if v_control = 'plan_renewal' then
    perform app_private.begin_scoped_operation_execution(p_run_id, 'plan_renewal');
    return app_private.execute_scoped_plan_renewal(p_run_id);
  end if;
  -- Stage 3C2-C1: transfer PREPARATION (database-only; no provider call). Every
  -- other operation type remains deferred to a later stage.
  if v_control = 'transfer_claim' then
    perform app_private.begin_scoped_operation_execution(p_run_id, 'transfer_claim');
    return app_private.execute_scoped_transfer_preparation(p_run_id);
  end if;
  raise exception 'stage_not_enabled: % execution is deferred to a later stage', v_control;
end;
$$;
revoke all on function public.support_execute_operation_run(uuid, text) from public, anon;
grant execute on function public.support_execute_operation_run(uuid, text) to authenticated;

-- ============================================================
-- 6. SUPPORT PREVIEW — from the EXACT applied 0076 body; the ONLY change is the
--    added transfer_claim branch built from the SHARED classifier. Side-effect-
--    free: no claim, no attempt, no processing change, no stale repair.
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
  elsif v_run.operation_type = 'transfer_claim' then
    select coalesce(jsonb_agg(app_private.classify_scoped_transfer(d.id, now()) order by d.ord), '[]'::jsonb)
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
