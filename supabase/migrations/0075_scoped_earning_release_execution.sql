-- ============================================================================
-- 0075_scoped_earning_release_execution.sql  (Stage 3C2-A, hardened)
--
-- The FIRST real scoped financial operation: production-grade, record-scoped
-- earning_release execution. An authorised support operator previews, confirms
-- and executes an approved operation run carrying ≤25 EXPLICIT earning UUIDs;
-- execution affects ONLY those UUIDs. An empty scope never means "all earnings".
--
-- ADDITIVE ONLY (0001–0074 immutable). This migration:
--   * adds a durable per-record ledger public.financial_operation_run_items
--     (RLS forced, unique(run_id,record_id) + unique(run_id,ordinal), a trigger
--     enforcing operation_type = parent run, no secrets);
--   * additively extends the financial_operation_run_events action vocabulary
--     (superset — no existing row can violate it) with item/execution actions;
--   * adds a SINGLE eligibility authority app_private.classify_earning_release(id)
--     used by BOTH preview and execution — there is exactly one classification
--     model, so preview and execution can never disagree;
--   * adds an UNFORGEABLE transaction-local execution context
--     app_private.begin_scoped_operation_execution(run_id, operation_type). The
--     public wrapper establishes it (is_local set_config) only AFTER it has
--     validated: authenticated support operator, confirmation token, run status +
--     expiry, explicit scope, maximum batch, environment, operation control and
--     the production master where applicable. The executor REFUSES to select, lock
--     or mutate any earning unless that context matches this exact run +
--     earning_release. A direct executor call without the wrapper context raises
--     before any mutation;
--   * adds app_private.execute_scoped_earning_release(p_run_id) — the record-
--     scoped executor. It re-checks the context, INDEPENDENTLY revalidates
--     run/type/confirmed/expiry/scope/control/environment, deduplicates scope
--     deterministically, locks each earning FOR UPDATE, CLASSIFIES it via the
--     single evaluator, and — only for an eligible earning — performs the state
--     change through the AUTHORITATIVE app_private.make_earning_payable (the sole
--     transition authority; never reimplemented). Each record runs inside its own
--     savepoint so a record-specific SQL exception is contained (outcome=failed)
--     and cannot roll back other successful items. It is REVOKED from PUBLIC,
--     anon, authenticated AND service_role — the support wrapper (a definer owned
--     by the migration role) is the only supported execution entry point;
--   * redefines public.support_execute_operation_run from the EXACT applied 0074
--     body, changing ONLY the earning_release branch to (a) establish the
--     execution context then (b) delegate to the executor (the 0074 control-block
--     structured-result contract is byte-for-byte unchanged);
--   * redefines public.support_preview_operation_run from the EXACT applied 0073
--     body, changing ONLY the earning_release rows to be built from the shared
--     evaluator (side-effect-free; one result per distinct requested id; unknown
--     ids => not_found without aborting others);
--   * redefines public.support_operation_run_detail to surface the item ledger.
--
-- It does NOT: call release_eligible_earnings or any global/transfer/refund/
-- dispute/reconciliation/renewal worker; touch Stripe; add or alter a cron;
-- weaken app_private.batch_worker_enabled or app_private.begin_scoped_execution
-- (which stay production_live-only); enable any control; move to production_live;
-- backfill; or touch ba4f943c / the 177 findings. It only moves an eligible
-- pending_completion earning into its existing 'payable' state via the cumulative
-- make_earning_payable primitive.
--
-- Control/environment semantics enforced (context fn + executor, in agreement):
--   hosted_test / development / production_dry_run: execution only when the
--     earning_release control is 'scoped_execution' AND only through the wrapper.
--     'enabled' is NEVER treated as valid outside production_live, even if a
--     privileged table write forced that state.
--   production_live: requires environment production_live, earning_release
--     'enabled' AND the production master 'enabled'.
--   'disabled'/'dry_run_only' always block; an expired control reads as disabled.
--
-- Authoritative eligibility (release_eligible_earnings ← 0034 + make_earning_payable
-- ← 0072), now centralised in classify_earning_release: state='pending_completion';
-- booking ended ≥12h; a took_place declaration exists; no open conversation_issue;
-- no active Stage 3B2 evidence hold. Earning state vocab: pending_completion /
-- held_for_issue / payable / reversed. transfer_state: not_ready / ready /
-- transfer_pending / processing / transferred / failed / reversed.
-- ============================================================================

-- ============================================================
-- 1. PER-RECORD LEDGER. Durable, immutable-to-clients, one row per (run, record).
-- ============================================================
create table if not exists public.financial_operation_run_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.financial_operation_runs(id) on delete cascade,
  operation_type text not null,
  record_id uuid not null,
  ordinal integer not null check (ordinal >= 1),
  outcome text not null check (outcome in (
    'released', 'already_payable', 'not_found', 'not_yet_eligible', 'issue_held',
    'evidence_held', 'reversed', 'transfer_already_started', 'invalid_state', 'failed')),
  reason_code text,
  before_state text,
  after_state text,
  attempted_at timestamptz,
  completed_at timestamptz,
  safe_details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, record_id),
  unique (run_id, ordinal)
);
create index if not exists fori_run_idx on public.financial_operation_run_items (run_id, ordinal);
alter table public.financial_operation_run_items enable row level security;
alter table public.financial_operation_run_items force row level security;   -- definer-only; no policies

-- Enforce: a ledger row's operation_type matches its parent run (no cross-type rows).
create or replace function app_private.fori_match_operation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_op text;
begin
  select operation_type into v_op from public.financial_operation_runs where id = new.run_id;
  if v_op is null then raise exception 'run_not_found'; end if;
  if new.operation_type <> v_op then
    raise exception 'operation_type_mismatch: item % <> run %', new.operation_type, v_op;
  end if;
  return new;
end;
$$;
drop trigger if exists fori_match_operation_trg on public.financial_operation_run_items;
create trigger fori_match_operation_trg before insert or update on public.financial_operation_run_items
  for each row execute function app_private.fori_match_operation();

-- ============================================================
-- 2. ADDITIVE extension of the run-event action vocabulary (superset; no data
--    change, no existing row invalidated). Enables per-item + run-level events.
-- ============================================================
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.financial_operation_run_events'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%action%';
  if c is not null then execute format('alter table public.financial_operation_run_events drop constraint %I', c); end if;
end $$;
alter table public.financial_operation_run_events
  add constraint financial_operation_run_events_action_check check (action in (
    'requested', 'preview_generated', 'confirmation_requested', 'execution_started',
    'record_claimed', 'record_skipped', 'record_succeeded', 'record_failed',
    'cancelled', 'expired', 'control_blocked',
    'item_released', 'item_skipped', 'item_failed',
    'execution_succeeded', 'execution_partially_succeeded', 'execution_failed'));

-- ============================================================
-- 3. SINGLE ELIGIBILITY AUTHORITY. One read-only classifier for earning_release,
--    used by BOTH the preview and the executor so they can never disagree. It
--    encodes the exact cumulative decision (state + 12h wait + took_place + open
--    issue + Stage 3B2 evidence hold) and the ineligible-state vocabulary. It does
--    NOT transition anything — the transition stays with make_earning_payable.
-- ============================================================
create or replace function app_private.classify_earning_release(p_earning uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  e public.companion_earnings;
  v_hold boolean; v_issue boolean; v_wait_ok boolean;
  v_outcome text; v_reason text; v_eligible boolean := false; v_reasons text[] := '{}';
begin
  select * into e from public.companion_earnings where id = p_earning;
  if e.id is null then
    return jsonb_build_object('id', p_earning, 'found', false, 'current_state', null,
      'earning_state', null, 'transfer_state', null, 'outcome', 'not_found', 'eligible', false,
      'expected_next_state', null, 'reason_code', 'earning_not_found',
      'blocking_reasons', to_jsonb(array['not_found']), 'blocked_by_open_issue', false,
      'blocked_by_dispute', false, 'blocked_by_evidence_hold', false);
  end if;

  v_hold  := app_private.evidence_hold_blocks_payout(e.booking_id);                 -- Stage 3B2 hold
  v_issue := exists (select 1 from public.conversation_issues i
                     where i.booking_id = e.booking_id and i.state <> 'resolved');  -- open issue
  v_wait_ok := exists (select 1 from public.bookings b                              -- 12h + took_place
                       join public.conversation_attendance a on a.booking_id = b.id and a.outcome = 'took_place'
                       where b.id = e.booking_id and b.ends_at + interval '12 hours' <= now());

  if e.state = 'pending_completion' then
    if v_hold then
      v_outcome := 'evidence_held'; v_reason := 'active_evidence_review'; v_reasons := array_append(v_reasons, 'evidence_hold_blocks_payout');
    elsif v_issue then
      v_outcome := 'issue_held'; v_reason := 'open_conversation_issue'; v_reasons := array_append(v_reasons, 'open_conversation_issue');
    elsif not v_wait_ok then
      v_outcome := 'not_yet_eligible'; v_reason := 'before_payable_wait_or_no_declaration'; v_reasons := array_append(v_reasons, 'before_payable_wait_or_no_declaration');
    else
      v_outcome := 'released'; v_eligible := true;                                  -- transition will be attempted by make_earning_payable
    end if;
  elsif e.state = 'reversed' or e.transfer_state = 'reversed' then
    v_outcome := 'reversed'; v_reason := 'earning_reversed'; v_reasons := array_append(v_reasons, 'earning_reversed');
  elsif e.transfer_state in ('transfer_pending', 'processing', 'transferred') then
    v_outcome := 'transfer_already_started'; v_reason := 'transfer_in_flight_or_done'; v_reasons := array_append(v_reasons, 'transfer_already_started');
  elsif e.state = 'payable' then
    v_outcome := 'already_payable'; v_reasons := array_append(v_reasons, 'already_payable');
  elsif e.state = 'held_for_issue' then
    v_outcome := 'issue_held'; v_reason := 'earning_held_for_issue'; v_reasons := array_append(v_reasons, 'earning_held_for_issue');
  else
    v_outcome := 'invalid_state'; v_reason := 'unexpected_earning_state'; v_reasons := array_append(v_reasons, 'unexpected_earning_state');
  end if;

  return jsonb_build_object(
    'id', p_earning, 'found', true, 'current_state', e.state,
    'earning_state', e.state, 'transfer_state', e.transfer_state,
    'outcome', v_outcome, 'eligible', v_eligible,
    'expected_next_state', case when v_eligible then 'payable' else e.state end,
    'reason_code', v_reason, 'blocking_reasons', to_jsonb(v_reasons),
    'blocked_by_open_issue', v_issue, 'blocked_by_dispute', false, 'blocked_by_evidence_hold', v_hold);
end;
$$;
revoke all on function app_private.classify_earning_release(uuid) from public, anon, authenticated;
grant execute on function app_private.classify_earning_release(uuid) to service_role;

-- ============================================================
-- 4. UNFORGEABLE, RUN- AND OPERATION-SPECIFIC EXECUTION CONTEXT.
--    The wrapper calls this (as a definer) ONLY after it has validated auth,
--    token, run status/expiry, scope, batch, environment and control. It re-checks
--    the environment/control/master combination (final authority), re-locks and
--    revalidates the run, then binds a TRANSACTION-LOCAL context (is_local=true)
--    that vanishes at transaction end and cannot be invented by a browser, cron,
--    Edge Function or ordinary service-role RPC. The executor refuses to act
--    unless this context matches the exact run + earning_release.
-- ============================================================
create or replace function app_private.begin_scoped_operation_execution(p_run_id uuid, p_operation_type text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_run public.financial_operation_runs; v_env text; v_ctrl text; v_max int;
begin
  v_env  := app_private.current_financial_environment();
  v_ctrl := app_private.effective_control_state(p_operation_type);
  -- Environment/control gate (authoritative). 'enabled' is valid ONLY in
  -- production_live; every non-production environment demands scoped_execution.
  if v_env = 'production_live' then
    if v_ctrl <> 'enabled' then raise exception 'control_disabled: % is not enabled', p_operation_type; end if;
    if app_private.effective_control_state('production_live_operations') <> 'enabled' then
      raise exception 'production_live_locked: the production master control is disabled';
    end if;
  else
    if v_ctrl <> 'scoped_execution' then raise exception 'control_disabled: % is not executable', p_operation_type; end if;
  end if;

  select max_batch_limit into v_max from public.financial_operations_config where id = true;
  select * into v_run from public.financial_operation_runs where id = p_run_id for update;
  if v_run.id is null then raise exception 'run_not_found'; end if;
  if v_run.operation_type <> p_operation_type then raise exception 'run_operation_mismatch'; end if;
  if v_run.state not in ('confirmed', 'executing') then raise exception 'run_not_confirmed'; end if;
  if v_run.expires_at <= now() then raise exception 'run_expired'; end if;
  if v_run.scope_type <> 'record_ids' or array_length(v_run.scoped_ids, 1) is null then raise exception 'scope_required'; end if;
  if array_length(v_run.scoped_ids, 1) > v_max then raise exception 'batch_limit_exceeded'; end if;

  perform set_config('app.scoped_op_exec_run', p_run_id::text, true);   -- transaction-local (is_local)
  perform set_config('app.scoped_op_exec_op', p_operation_type, true);
end;
$$;
revoke all on function app_private.begin_scoped_operation_execution(uuid, text) from public, anon, authenticated, service_role;

-- ============================================================
-- 5. THE RECORD-SCOPED EARNING-RELEASE EXECUTOR. Inert unless invoked inside the
--    authorised wrapper's transaction-local context. Never calls a global worker.
--    Revoked from every client role AND service_role.
-- ============================================================
create or replace function app_private.execute_scoped_earning_release(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.financial_operation_runs;
  v_env text; v_ctrl text; v_max int;
  v_rec record; v_e public.companion_earnings; v_cls jsonb;
  v_outcome text; v_reason text; v_before text; v_after text;
  v_requested int := 0; v_released int := 0; v_already int := 0; v_skipped int := 0; v_failed int := 0;
  v_run_state text; v_summary_action text;
begin
  -- --- (0) UNFORGEABLE CONTEXT GATE. Before any run/earning read, lock or mutation:
  -- refuse unless this exact run + earning_release context was established by the
  -- authorised wrapper in THIS transaction. A direct call has no such context.
  if nullif(current_setting('app.scoped_op_exec_op', true), '') is distinct from 'earning_release'
     or nullif(current_setting('app.scoped_op_exec_run', true), '') is distinct from p_run_id::text then
    raise exception 'execution_context_required: the scoped executor runs only inside an authorised operation wrapper';
  end if;

  -- --- INDEPENDENT REVALIDATION (defence in depth; the wrapper + context fn also check) ---
  select * into v_run from public.financial_operation_runs where id = p_run_id for update;   -- serialise concurrent runs
  if v_run.id is null then raise exception 'not_found: run'; end if;
  if v_run.operation_type <> 'earning_release' then raise exception 'operation_mismatch: % is not earning_release', v_run.operation_type; end if;
  -- Idempotent second execution: return the durable result, do NOT re-run.
  if v_run.executed_at is not null or v_run.state = 'completed' or v_run.state = 'failed' then
    return coalesce(v_run.result_summary, '{}'::jsonb)
      || jsonb_build_object('ok', v_run.rows_failed = 0, 'executed', false, 'already_executed', true,
                            'run_id', p_run_id, 'operation_type', 'earning_release');
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

  -- --- CONTROL + ENVIRONMENT gate (independently re-checked; identical semantics
  -- to begin_scoped_operation_execution). 'enabled' is NEVER valid outside
  -- production_live; production_live additionally needs the master 'enabled'.
  v_env := app_private.current_financial_environment();
  v_ctrl := app_private.effective_control_state('earning_release');
  if v_env = 'production_live' then
    if v_ctrl <> 'enabled' then raise exception 'control_disabled: earning_release is not enabled'; end if;
    if app_private.effective_control_state('production_live_operations') <> 'enabled' then
      raise exception 'production_live_locked: the production master control is disabled';
    end if;
  else
    if v_ctrl <> 'scoped_execution' then raise exception 'control_disabled: earning_release is not executable'; end if;
  end if;

  update public.financial_operation_runs set state = 'executing', started_at = now() where id = p_run_id;
  if not exists (select 1 from public.financial_operation_run_events e where e.run_id = p_run_id and e.action = 'execution_started') then
    insert into public.financial_operation_run_events (run_id, action, actor_account_id) values (p_run_id, 'execution_started', auth.uid());
  end if;

  -- --- PER-RECORD execution over the DEDUPLICATED, explicitly-scoped ids ONLY.
  -- Deterministic dedup: keep first occurrence order; ordinal is 1-based. Each
  -- record runs in its OWN savepoint (BEGIN/EXCEPTION) so a record-specific SQL
  -- failure is contained: it records outcome='failed' and unrelated eligible
  -- items still complete. Auth/authorisation/invalid-run failures happen ABOVE
  -- this loop and abort the whole request (they are never caught here).
  for v_rec in
    select id, row_number() over (order by first_pos) as ordinal
    from (select u.id, min(u.pos) as first_pos
            from unnest(v_run.scoped_ids) with ordinality as u(id, pos)
           group by u.id) d
  loop
    v_requested := v_requested + 1;
    v_reason := null; v_after := null; v_before := null; v_outcome := null;
    begin
      -- Lock the earning against concurrent mutation; snapshot before-state.
      select * into v_e from public.companion_earnings where id = v_rec.id for update;
      v_before := case when v_e.id is null then null else v_e.state || '/' || v_e.transfer_state end;

      -- SINGLE classification authority (same evaluator preview uses), under our lock.
      v_cls := app_private.classify_earning_release(v_rec.id);
      v_outcome := v_cls->>'outcome';
      v_reason  := v_cls->>'reason_code';

      if v_outcome = 'released' then
        -- The AUTHORITATIVE transition (sole authority; never reimplemented). It is
        -- the final gate under the lock and re-checks pending_completion + evidence.
        perform app_private.make_earning_payable(v_rec.id);
        select state into v_after from public.companion_earnings where id = v_rec.id;
        if v_after is distinct from 'payable' then
          v_outcome := 'failed'; v_reason := 'transition_did_not_apply';
        end if;
      else
        v_after := case when v_e.id is null then null else v_e.state end;
      end if;

      insert into public.financial_operation_run_items
        (run_id, operation_type, record_id, ordinal, outcome, reason_code, before_state, after_state, attempted_at, completed_at, safe_details)
      values (p_run_id, 'earning_release', v_rec.id, v_rec.ordinal, v_outcome, v_reason, v_before, v_after, now(), now(),
              jsonb_build_object('outcome', v_outcome))
      on conflict (run_id, record_id) do nothing;

      insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id, detail)
      values (p_run_id,
              case v_outcome when 'released' then 'item_released' when 'failed' then 'item_failed' else 'item_skipped' end,
              v_rec.id, auth.uid(), jsonb_build_object('outcome', v_outcome, 'reason_code', v_reason));
    exception when others then
      -- PER-ITEM CONTAINMENT: this record's subtransaction rolled back. Record a
      -- 'failed' item (safe reason: SQLSTATE only, never a payload/secret) so the
      -- remaining eligible items still complete.
      v_outcome := 'failed';
      v_reason  := 'item_exception:' || substr(coalesce(nullif(sqlstate, ''), 'XXXXX'), 1, 5);
      insert into public.financial_operation_run_items
        (run_id, operation_type, record_id, ordinal, outcome, reason_code, before_state, after_state, attempted_at, completed_at, safe_details)
      values (p_run_id, 'earning_release', v_rec.id, v_rec.ordinal, 'failed', v_reason, v_before, null, now(), now(),
              jsonb_build_object('outcome', 'failed', 'sqlstate', sqlstate))
      on conflict (run_id, record_id) do nothing;
      insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id, detail)
      values (p_run_id, 'item_failed', v_rec.id, auth.uid(), jsonb_build_object('outcome', 'failed', 'reason_code', v_reason));
    end;

    if v_outcome = 'released' then v_released := v_released + 1;
    elsif v_outcome = 'already_payable' then v_already := v_already + 1;
    elsif v_outcome = 'failed' then v_failed := v_failed + 1;
    else v_skipped := v_skipped + 1;
    end if;
  end loop;

  -- --- RUN-LEVEL result. Existing state vocab only (completed / failed).
  v_run_state := case when v_failed > 0 and v_released = 0 and v_already = 0 then 'failed' else 'completed' end;
  v_summary_action := case
    when v_failed > 0 and v_released = 0 and v_already = 0 then 'execution_failed'
    when v_failed > 0 or v_skipped > 0 then 'execution_partially_succeeded'
    else 'execution_succeeded' end;
  update public.financial_operation_runs
     set state = v_run_state, executed_at = now(), completed_at = now(),
         rows_examined = v_requested, rows_eligible = v_released,
         rows_claimed = v_released, rows_succeeded = v_released + v_already, rows_failed = v_failed,
         result_summary = jsonb_build_object('executed_at', now(), 'requested_count', v_requested,
           'released_count', v_released, 'already_done_count', v_already, 'skipped_count', v_skipped, 'failed_count', v_failed)
   where id = p_run_id;
  insert into public.financial_operation_run_events (run_id, action, actor_account_id, detail)
    values (p_run_id, v_summary_action, auth.uid(),
            jsonb_build_object('released', v_released, 'already', v_already, 'skipped', v_skipped, 'failed', v_failed));

  return jsonb_build_object('ok', v_failed = 0, 'executed', true, 'run_id', p_run_id, 'operation_type', 'earning_release',
    'state', v_run_state, 'requested_count', v_requested, 'released_count', v_released,
    'already_done_count', v_already, 'skipped_count', v_skipped, 'failed_count', v_failed);
end;
$$;
-- The support wrapper (a definer owned by the migration role) is the ONLY entry
-- point. No client role and NOT service_role may call the executor directly.
revoke all on function app_private.execute_scoped_earning_release(uuid) from public, anon, authenticated, service_role;

-- ============================================================
-- 6. SUPPORT EXECUTE WRAPPER — from the EXACT applied 0074 body, changing ONLY the
--    earning_release branch to (a) establish the transaction-local execution
--    context, then (b) delegate to the scoped executor. All 0074 guards + the
--    deduplicated control_blocked structured-result contract are byte-for-byte
--    unchanged.
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
  -- Stage 3C2-A: earning_release now has a production-grade record-scoped executor.
  -- Establish the unforgeable execution context (only after every guard above),
  -- then delegate. Every other operation type remains deferred to a later stage.
  if v_control = 'earning_release' then
    perform app_private.begin_scoped_operation_execution(p_run_id, 'earning_release');
    return app_private.execute_scoped_earning_release(p_run_id);
  end if;
  raise exception 'stage_not_enabled: % execution is deferred to a later stage', v_control;
end;
$$;
revoke all on function public.support_execute_operation_run(uuid, text) from public, anon;
grant execute on function public.support_execute_operation_run(uuid, text) to authenticated;

-- ============================================================
-- 7. SUPPORT PREVIEW — from the EXACT applied 0073 body, changing ONLY the
--    earning_release rows to be built from the SHARED evaluator (so preview and
--    execution use one classification model). Side-effect-free on financial rows:
--    it records run metadata + a preview_generated event only, creates NO
--    financial_operation_run_items, and mutates no earning/transfer/refund/dispute/
--    credit/review/notification/completion row. Execution never trusts preview.
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
    -- One result per DISTINCT requested id (first-occurrence order), each from the
    -- shared classifier; unknown ids classify as not_found without aborting others.
    select coalesce(jsonb_agg(app_private.classify_earning_release(d.id) order by d.ord), '[]'::jsonb)
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
-- 8. SUPPORT RUN DETAIL — from the 0073 body + the per-record item ledger (safe).
-- ============================================================
create or replace function public.support_operation_run_detail(p_run_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_run public.financial_operation_runs;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: run'; end if;
  select * into v_run from public.financial_operation_runs where id = p_run_id;
  if v_run.id is null then raise exception 'not_found: run'; end if;
  return jsonb_build_object(
    'run', jsonb_build_object('id', v_run.id, 'operation_type', v_run.operation_type, 'environment', v_run.environment,
      'execution_mode', v_run.execution_mode, 'scope_type', v_run.scope_type, 'batch_limit', v_run.batch_limit,
      'dry_run', v_run.dry_run, 'state', v_run.state, 'reason', v_run.reason, 'requested_at', v_run.requested_at,
      'expires_at', v_run.expires_at, 'rows_examined', v_run.rows_examined, 'rows_eligible', v_run.rows_eligible,
      'rows_succeeded', v_run.rows_succeeded, 'rows_failed', v_run.rows_failed, 'result_summary', v_run.result_summary),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'record_id', it.record_id, 'ordinal', it.ordinal, 'outcome', it.outcome, 'reason_code', it.reason_code,
        'before_state', it.before_state, 'after_state', it.after_state,
        'attempted_at', it.attempted_at, 'completed_at', it.completed_at) order by it.ordinal)
      from public.financial_operation_run_items it where it.run_id = p_run_id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('action', action, 'record_id', record_id,
        'detail', detail, 'actor_account_id', actor_account_id, 'created_at', created_at) order by created_at)
      from public.financial_operation_run_events where run_id = p_run_id), '[]'::jsonb));
end;
$$;
revoke all on function public.support_operation_run_detail(uuid) from public, anon;
grant execute on function public.support_operation_run_detail(uuid) to authenticated;

-- Safe support read of just the per-record item results for a run.
create or replace function public.support_operation_run_items(p_run_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not app_private.is_support_admin() then raise exception 'not_found: run'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'record_id', it.record_id, 'ordinal', it.ordinal, 'outcome', it.outcome, 'reason_code', it.reason_code,
      'before_state', it.before_state, 'after_state', it.after_state) order by it.ordinal)
    from public.financial_operation_run_items it where it.run_id = p_run_id), '[]'::jsonb);
end;
$$;
revoke all on function public.support_operation_run_items(uuid) from public, anon;
grant execute on function public.support_operation_run_items(uuid) to authenticated;

-- ============================================================
-- 9. PostgREST schema reload.
-- ============================================================
select pg_notify('pgrst', 'reload schema');
