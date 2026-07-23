-- ============================================================================
-- 0075_scoped_earning_release_execution.sql  (Stage 3C2-A)
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
--   * adds app_private.execute_scoped_earning_release(p_run_id) — the record-
--     scoped executor. It INDEPENDENTLY revalidates run/type/confirmed/expiry/
--     scope/control/environment, deduplicates scope deterministically, locks each
--     earning FOR UPDATE, re-evaluates eligibility, uses the AUTHORITATIVE
--     app_private.make_earning_payable transition (never reimplements the state
--     rules), writes one durable item row + one deduplicated event per record,
--     and returns a structured run result;
--   * redefines public.support_execute_operation_run from the EXACT applied 0074
--     body, changing ONLY the earning_release execution branch to delegate to the
--     executor (the 0074 control-block structured-result contract is unchanged);
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
-- Authoritative eligibility observed (release_eligible_earnings ← 0034 +
-- make_earning_payable ← 0072): state='pending_completion'; booking ended ≥12h;
-- a took_place declaration exists; no open conversation_issue; and no active
-- Stage 3B2 evidence hold. Earning state vocab: pending_completion / held_for_issue
-- / payable / reversed. transfer_state: not_ready / ready / transfer_pending /
-- processing / transferred / failed / reversed.
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
-- 3. THE RECORD-SCOPED EARNING-RELEASE EXECUTOR. Callable only from the support
--    execution wrapper (revoked from browser roles). Never calls a global worker.
-- ============================================================
create or replace function app_private.execute_scoped_earning_release(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.financial_operation_runs;
  v_env text; v_ctrl text; v_max int;
  v_rec record; v_e public.companion_earnings;
  v_outcome text; v_reason text; v_before text; v_after text;
  v_requested int := 0; v_released int := 0; v_already int := 0; v_skipped int := 0; v_failed int := 0;
  v_run_state text; v_summary_action text;
begin
  -- --- INDEPENDENT REVALIDATION (defence in depth; the wrapper also checks) ---
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

  -- --- CONTROL + ENVIRONMENT gate (mirrors Stage 3C1). scoped_execution is the
  -- sanctioned hosted_test path; production_live additionally needs enabled + master.
  v_env := app_private.current_financial_environment();
  v_ctrl := app_private.effective_control_state('earning_release');
  if v_env = 'production_live' then
    if v_ctrl <> 'enabled' then raise exception 'control_disabled: earning_release is not enabled'; end if;
    if app_private.effective_control_state('production_live_operations') <> 'enabled' then
      raise exception 'production_live_locked: the production master control is disabled';
    end if;
  else
    if v_ctrl not in ('scoped_execution', 'enabled') then raise exception 'control_disabled: earning_release is not executable'; end if;
  end if;

  update public.financial_operation_runs set state = 'executing', started_at = now() where id = p_run_id;
  if not exists (select 1 from public.financial_operation_run_events e where e.run_id = p_run_id and e.action = 'execution_started') then
    insert into public.financial_operation_run_events (run_id, action, actor_account_id) values (p_run_id, 'execution_started', auth.uid());
  end if;

  -- --- PER-RECORD execution over the DEDUPLICATED, explicitly-scoped ids ONLY.
  -- Deterministic dedup: keep first occurrence order; ordinal is 1-based.
  for v_rec in
    select id, row_number() over (order by first_pos) as ordinal
    from (select u.id, min(u.pos) as first_pos
            from unnest(v_run.scoped_ids) with ordinality as u(id, pos)
           group by u.id) d
  loop
    v_requested := v_requested + 1;
    v_reason := null; v_after := null;
    -- Lock the earning against concurrent mutation; snapshot before-state.
    select * into v_e from public.companion_earnings where id = v_rec.id for update;
    v_before := case when v_e.id is null then null else v_e.state || '/' || v_e.transfer_state end;

    if v_e.id is null then
      v_outcome := 'not_found';
    elsif v_e.state = 'pending_completion' then
      -- Eligibility PREDICATE (read-only; mirrors release_eligible_earnings +
      -- the Stage 3B2 evidence hold). The STATE TRANSITION itself is delegated to
      -- the authoritative make_earning_payable — never reimplemented here.
      if app_private.evidence_hold_blocks_payout(v_e.booking_id) then
        v_outcome := 'evidence_held'; v_reason := 'active_evidence_review';
      elsif exists (select 1 from public.conversation_issues i where i.booking_id = v_e.booking_id and i.state <> 'resolved') then
        v_outcome := 'issue_held'; v_reason := 'open_conversation_issue';
      elsif not exists (
              select 1 from public.bookings b
              join public.conversation_attendance a on a.booking_id = b.id and a.outcome = 'took_place'
              where b.id = v_e.booking_id and b.ends_at + interval '12 hours' <= now())
      then
        v_outcome := 'not_yet_eligible'; v_reason := 'before_payable_wait_or_no_declaration';
      else
        perform app_private.make_earning_payable(v_rec.id);                  -- authoritative transition
        select state into v_after from public.companion_earnings where id = v_rec.id;
        if v_after = 'payable' then v_outcome := 'released';
        else v_outcome := 'failed'; v_reason := 'transition_did_not_apply'; end if;
      end if;
    elsif v_e.state = 'reversed' or v_e.transfer_state = 'reversed' then
      v_outcome := 'reversed'; v_reason := 'earning_reversed';
    elsif v_e.transfer_state in ('transfer_pending', 'processing', 'transferred') then
      v_outcome := 'transfer_already_started'; v_reason := 'transfer_in_flight_or_done';
    elsif v_e.state = 'payable' then
      v_outcome := 'already_payable';                                        -- idempotent, no mutation
    elsif v_e.state = 'held_for_issue' then
      v_outcome := 'issue_held'; v_reason := 'earning_held_for_issue';
    else
      v_outcome := 'invalid_state'; v_reason := 'unexpected_earning_state';
    end if;

    v_after := coalesce(v_after,
      (select case when e2.id is null then null else e2.state end from public.companion_earnings e2 where e2.id = v_rec.id));

    insert into public.financial_operation_run_items
      (run_id, operation_type, record_id, ordinal, outcome, reason_code, before_state, after_state, attempted_at, completed_at, safe_details)
    values (p_run_id, 'earning_release', v_rec.id, v_rec.ordinal, v_outcome, v_reason, v_before, v_after, now(), now(),
            jsonb_build_object('outcome', v_outcome))
    on conflict (run_id, record_id) do nothing;

    insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id, detail)
    values (p_run_id,
            case v_outcome when 'released' then 'item_released' when 'failed' then 'item_failed' else 'item_skipped' end,
            v_rec.id, auth.uid(), jsonb_build_object('outcome', v_outcome, 'reason_code', v_reason));

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
revoke all on function app_private.execute_scoped_earning_release(uuid) from public, anon, authenticated;
grant execute on function app_private.execute_scoped_earning_release(uuid) to service_role;

-- ============================================================
-- 4. SUPPORT EXECUTE WRAPPER — from the EXACT applied 0074 body, changing ONLY
--    the earning_release execution branch to delegate to the scoped executor.
--    All 0074 guards + the deduplicated control_blocked structured-result contract
--    are byte-for-byte unchanged.
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
  -- Stage 3C2-A: earning_release now has a production-grade record-scoped executor;
  -- every other operation type remains deferred to a later stage.
  if v_control = 'earning_release' then
    return app_private.execute_scoped_earning_release(p_run_id);
  end if;
  raise exception 'stage_not_enabled: % execution is deferred to a later stage', v_control;
end;
$$;
revoke all on function public.support_execute_operation_run(uuid, text) from public, anon;
grant execute on function public.support_execute_operation_run(uuid, text) to authenticated;

-- ============================================================
-- 5. SUPPORT RUN DETAIL — from the 0073 body + the per-record item ledger (safe).
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
-- 6. PostgREST schema reload.
-- ============================================================
select pg_notify('pgrst', 'reload schema');
