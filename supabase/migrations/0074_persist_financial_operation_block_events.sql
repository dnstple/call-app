-- ============================================================================
-- 0074_persist_financial_operation_block_events.sql  (Stage 3C1 correction)
--
-- TRANSACTION-SEMANTICS FIX (additive; 0073 is applied and immutable).
--
-- In 0073, public.support_execute_operation_run wrote a 'control_blocked' audit
-- event and THEN raised an exception in the SAME transaction when an authorised
-- execution request hit a `disabled` / `dry_run_only` control. The RAISE aborts
-- the transaction, so the just-inserted audit event is rolled back and never
-- persists — the operational block leaves no trace.
--
-- This migration redefines ONLY public.support_execute_operation_run, starting
-- from the EXACT applied 0073 body, with the smallest correction:
--   * an expected operational BLOCK (control disabled / dry_run_only) now writes
--     ONE immutable, DEDUPLICATED 'control_blocked' run event and RETURNS a
--     structured non-success result instead of raising, so the event commits:
--        { ok:false, executed:false, code:'control_disabled'|'dry_run_only', ... }
--   * repeated blocked requests do NOT create duplicate events (guarded by a
--     `not exists` check per run);
--   * no financial row, earning, transfer, refund or run state is changed by a
--     block (the run stays 'confirmed' so it can be retried once the control is
--     armed through the approved scoped path);
--   * NO worker is invoked; the Stage-3C1 earning-release executor, the scoped
--     record-ids requirement, the batch cap and every OTHER guard are byte-for
--     -byte unchanged from 0073.
--
-- Authentication / authorisation / not-found / invalid-token / run-expired /
-- run-cancelled / stage_not_enabled remain hard exceptions — only the expected
-- operational control block becomes a structured result. No Stripe call, no
-- cron change, no historical repair, no backfill.
-- ============================================================================

create or replace function public.support_execute_operation_run(p_run_id uuid, p_confirmation_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.financial_operation_runs; v_control text; v_state text;
  v_id uuid; v_e public.companion_earnings; v_ok integer := 0; v_skip integer := 0; v_examined integer := 0;
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
  -- structured result (do NOT raise — a raise would roll the event back).
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
  -- Stage 3C1 only wires the non-Stripe earning-release executor.
  if v_control <> 'earning_release' then
    raise exception 'stage_not_enabled: % execution is deferred to Stage 3C2', v_control;
  end if;

  update public.financial_operation_runs set state = 'executing', started_at = now() where id = p_run_id;
  insert into public.financial_operation_run_events (run_id, action, actor_account_id) values (p_run_id, 'execution_started', auth.uid());

  -- Enforce the maximum batch size once more at execution time.
  if array_length(v_run.scoped_ids, 1) > (select max_batch_limit from public.financial_operations_config where id = true) then
    raise exception 'batch_limit_exceeded: scope exceeds the maximum batch size';
  end if;

  foreach v_id in array v_run.scoped_ids loop
    v_examined := v_examined + 1;
    select * into v_e from public.companion_earnings where id = v_id for update;
    if v_e.id is null or v_e.state <> 'pending_completion' or app_private.evidence_hold_blocks_payout(v_e.booking_id) then
      v_skip := v_skip + 1;
      insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id, detail)
        values (p_run_id, 'record_skipped', v_id, auth.uid(), jsonb_build_object('state', v_e.state));
    else
      -- Existing worker; respects the hold internally. No Stripe, no transfer.
      perform app_private.make_earning_payable(v_id);
      v_ok := v_ok + 1;
      insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id)
        values (p_run_id, 'record_succeeded', v_id, auth.uid());
    end if;
  end loop;

  update public.financial_operation_runs
     set state = 'completed', executed_at = now(), completed_at = now(),
         rows_examined = v_examined, rows_claimed = v_ok, rows_succeeded = v_ok, rows_failed = 0,
         result_summary = jsonb_build_object('executed_at', now(), 'succeeded', v_ok, 'skipped', v_skip, 'examined', v_examined)
   where id = p_run_id;
  return jsonb_build_object('ok', true, 'state', 'completed', 'succeeded', v_ok, 'skipped', v_skip, 'examined', v_examined);
end;
$$;
revoke all on function public.support_execute_operation_run(uuid, text) from public, anon;
grant execute on function public.support_execute_operation_run(uuid, text) to authenticated;

select pg_notify('pgrst', 'reload schema');
