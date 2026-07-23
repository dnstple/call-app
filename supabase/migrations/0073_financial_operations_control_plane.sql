-- ============================================================================
-- 0073_financial_operations_control_plane.sql  (Stage 3C1)
--
-- A PRODUCTION-READINESS CONTROL PLANE for financial processing. It makes any
-- future financial run EXPLICIT, SCOPED, AUDITABLE, RATE-LIMITED, DRY-RUN
-- capable, KILL-SWITCH protected and IDEMPOTENT — safe to operate one record
-- or a small batch at a time.
--
-- This migration is ADDITIVE and FINANCIALLY INERT. It:
--   * introduces a server-owned operational ENVIRONMENT model;
--   * adds server-owned kill-switch CONTROLS (default disabled) + a reasoned,
--     audited, optimistic-concurrency transition RPC;
--   * adds an immutable OPERATION-RUN model (request → preview → confirm →
--     execute) with a hard maximum batch size and mandatory scope;
--   * adds side-effect-free PREVIEW functions for each operation;
--   * adds a narrowly-scoped EXECUTION wrapper that stays BLOCKED by the
--     default-disabled controls and, even when permitted, only ever performs
--     the non-Stripe earning-release path on explicitly-scoped rows;
--   * adds a support-only READINESS summary + recent-runs reader;
--   * uses named, server-owned THRESHOLDS.
--
-- It does NOT (and 0073 must not): edit migrations 0001–0072; enable live
-- Stripe or store any Stripe secret; run a transfer / refund / dispute /
-- reconciliation worker; run any worker GLOBALLY; backfill or repair
-- historical rows; touch booking ba4f943c-3e8d-4d4c-900d-fa551ccc5387 or the
-- 177 diagnostic findings; enable any financial cron. Actual controlled worker
-- activation is Stage 3C2, AFTER this plane is hosted-validated.
--
-- Latest cumulative worker definitions this plane observes (never redefines):
--   app_private.make_earning_payable            ← 0072
--   public.claim_plan_transfers                 ← 0072
--   public.finalize_transfer_{succeeded,failed_retryable,failed_permanent,reversed} ← 0056
--   public.recover_stale_transfers              ← 0048
--   public.claim_payment_refunds                ← 0056
--   public.finalize_refund_{succeeded,failed_retryable,failed_permanent,cancelled} ← 0052
--   public.recover_stale_refunds                ← 0052
--   public.process_plan_renewals                ← 0043
--   public.run_financial_reconciliation(_for_entities) ← 0063
--   app_private.process_dispute_deadline_alerts ← 0062
--   app_private.evaluate_evidence_payout_hold / support_release_evidence_review ← 0072
--   public.resolve_unconfirmed_attendance / release_eligible_earnings ← 0068/0037
-- ============================================================================

-- ============================================================
-- 1. OPERATIONAL ENVIRONMENT + NAMED THRESHOLDS (single-row, server-owned).
--    Never inferred from a browser variable. Production-live is NOT the
--    default and cannot be reached by a stray boolean flip (see §2 transition).
-- ============================================================
create table if not exists public.financial_operations_config (
  id boolean primary key default true check (id),               -- single row
  environment text not null default 'hosted_test'
    check (environment in ('development', 'hosted_test', 'production_dry_run', 'production_live')),
  -- Named operational thresholds (documented; server-owned so ops can tune).
  stale_processing_minutes integer not null default 30 check (stale_processing_minutes > 0),
  stale_refund_minutes integer not null default 30 check (stale_refund_minutes > 0),
  run_expiry_minutes integer not null default 15 check (run_expiry_minutes > 0),
  max_batch_limit integer not null default 25 check (max_batch_limit between 1 and 100),
  dispute_deadline_warning_hours integer not null default 72 check (dispute_deadline_warning_hours > 0),
  updated_by_account_id uuid references public.accounts(id),
  updated_at timestamptz not null default now()
);
insert into public.financial_operations_config (id) values (true) on conflict (id) do nothing;
alter table public.financial_operations_config enable row level security;
alter table public.financial_operations_config force row level security;   -- definer-only

create or replace function app_private.financial_config()
returns public.financial_operations_config
language sql stable security definer set search_path = '' as $$
  select * from public.financial_operations_config where id = true;
$$;
revoke all on function app_private.financial_config() from public, anon, authenticated;
grant execute on function app_private.financial_config() to authenticated, service_role;

-- ============================================================
-- 2. FINANCIAL KILL SWITCHES. One row per controllable operation, default
--    'disabled'. Only the transition RPC may change them; browsers cannot read
--    or write the table (RLS forced, no policies).
-- ============================================================
create table if not exists public.financial_operation_controls (
  control_name text primary key check (control_name in (
    'earning_release', 'transfer_claim', 'transfer_finalise',
    'refund_claim', 'refund_finalise', 'plan_renewal',
    'dispute_reconciliation', 'financial_reconciliation',
    'evidence_review_release', 'production_live_operations')),
  state text not null default 'disabled'
    check (state in ('disabled', 'dry_run_only', 'scoped_execution', 'enabled')),
  reason text,
  expires_at timestamptz,
  updated_by_account_id uuid references public.accounts(id),
  updated_at timestamptz not null default now()
);
insert into public.financial_operation_controls (control_name) values
  ('earning_release'), ('transfer_claim'), ('transfer_finalise'),
  ('refund_claim'), ('refund_finalise'), ('plan_renewal'),
  ('dispute_reconciliation'), ('financial_reconciliation'),
  ('evidence_review_release'), ('production_live_operations')
on conflict (control_name) do nothing;
alter table public.financial_operation_controls enable row level security;
alter table public.financial_operation_controls force row level security;

-- Append-only audit of every control change.
create table if not exists public.financial_operation_control_events (
  id uuid primary key default gen_random_uuid(),
  control_name text not null,
  from_state text,
  to_state text not null,
  reason text not null,
  expires_at timestamptz,
  actor_account_id uuid references public.accounts(id),
  created_at timestamptz not null default now()
);
create index if not exists foce_control_idx on public.financial_operation_control_events (control_name, created_at desc);
alter table public.financial_operation_control_events enable row level security;
alter table public.financial_operation_control_events force row level security;

-- Reasoned, audited, optimistic-concurrency transition. Never runs a worker.
-- HARDENED (Stage 3C1 isolation):
--   * no individual control may enter 'enabled' unless the environment is ALREADY
--     'production_live' — enabling a control in dev/hosted_test/production_dry_run
--     is rejected outright, so no test or operator can arm a global worker there;
--   * arming the production master ('production_live_operations') requires its OWN
--     dedicated phrase (distinct from the environment phrase);
--   * enabling any control while already production_live requires the live phrase;
--   * changing the master alone never enables any worker (batch_worker_enabled also
--     requires the per-op control + the transaction-local approved-run context).
create or replace function public.support_set_financial_control(
  p_control text, p_expected_state text, p_new_state text,
  p_reason text, p_expires_at timestamptz default null, p_confirmation text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_live_phrase constant text := 'ENABLE-PRODUCTION-LIVE';
  c_master_phrase constant text := 'ARM-PRODUCTION-MASTER';
  v_row public.financial_operation_controls;
  v_env text;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: control'; end if;
  if p_new_state not in ('disabled', 'dry_run_only', 'scoped_execution', 'enabled') then
    raise exception 'invalid_state: unknown control state';
  end if;
  if p_reason is null or trim(p_reason) = '' then raise exception 'reason_required: a reason is required'; end if;
  select environment into v_env from public.financial_operations_config where id = true;
  -- No control may be armed to 'enabled' outside production_live.
  if p_new_state = 'enabled' and v_env <> 'production_live' then
    raise exception 'enabled_requires_production_live: cannot enable % in the % environment', p_control, v_env;
  end if;
  -- Arming the production master needs its own dedicated confirmation phrase.
  if p_control = 'production_live_operations' and p_new_state <> 'disabled'
     and coalesce(p_confirmation, '') <> c_master_phrase then
    raise exception 'master_confirmation_required: arming the production master requires its confirmation phrase';
  end if;
  -- Enabling any (non-master) control while production_live needs the live phrase.
  if p_control <> 'production_live_operations' and p_new_state = 'enabled'
     and coalesce(p_confirmation, '') <> c_live_phrase then
    raise exception 'confirmation_required: enabling a production-live control requires the confirmation phrase';
  end if;
  -- Single-winner: lock the row, then enforce the caller's expected current state.
  select * into v_row from public.financial_operation_controls where control_name = p_control for update;
  if v_row.control_name is null then raise exception 'not_found: control'; end if;
  if v_row.state <> p_expected_state then
    raise exception 'state_mismatch: control is % (expected %)', v_row.state, p_expected_state;
  end if;
  update public.financial_operation_controls
     set state = p_new_state, reason = trim(p_reason), expires_at = p_expires_at,
         updated_by_account_id = auth.uid(), updated_at = now()
   where control_name = p_control;
  insert into public.financial_operation_control_events
    (control_name, from_state, to_state, reason, expires_at, actor_account_id)
  values (p_control, v_row.state, p_new_state, trim(p_reason), p_expires_at, auth.uid());
  return jsonb_build_object('ok', true, 'control', p_control, 'from', v_row.state, 'to', p_new_state);
end;
$$;
revoke all on function public.support_set_financial_control(text, text, text, text, timestamptz, text) from public, anon;
grant execute on function public.support_set_financial_control(text, text, text, text, timestamptz, text) to authenticated;

-- Effective control state, honouring an expiry (an expired control reads as
-- 'disabled'). Used by execution wrappers and the readiness summary.
create or replace function app_private.effective_control_state(p_control text)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when c.control_name is null then 'disabled'
    when c.expires_at is not null and c.expires_at <= now() then 'disabled'
    else c.state end
  from (select p_control as n) q
  left join public.financial_operation_controls c on c.control_name = q.n;
$$;
revoke all on function app_private.effective_control_state(text) from public, anon, authenticated;
grant execute on function app_private.effective_control_state(text) to authenticated, service_role;

-- Server-owned environment reader (never inferred from a browser variable).
create or replace function app_private.current_financial_environment()
returns text language sql stable security definer set search_path = '' as $$
  select environment from public.financial_operations_config where id = true;
$$;
revoke all on function app_private.current_financial_environment() from public, anon, authenticated;
grant execute on function app_private.current_financial_environment() to authenticated, service_role;

-- ------------------------------------------------------------
-- 2b. THE AUTHORITATIVE KILL-SWITCH GUARD + UNFORGEABLE EXECUTION CONTEXT.
--
--     A control being 'enabled' is NOT sufficient to run a raw worker. Every RAW
--     batch/global worker gates on batch_worker_enabled() which is true ONLY when
--     ALL of the following hold simultaneously:
--       (1) a TRANSACTION-LOCAL approved-run context for this exact operation is
--           active — set only by app_private.begin_scoped_execution() AFTER it
--           locks + validates an approved, confirmed, unexpired operation run;
--       (2) the environment is production_live;
--       (3) the operation's own control is 'enabled';
--       (4) the production-live master control is 'enabled'.
--     Expired controls read as 'disabled' (see effective_control_state).
--
--     Because the context is a transaction-local GUC (is_local=true), it vanishes
--     at transaction end and CANNOT be invented or reused by a browser, an
--     ordinary service-role RPC, a pg_cron job (running as a superuser) or an Edge
--     Function — none of them run inside begin_scoped_execution's transaction. In
--     development / hosted_test / production_dry_run condition (2) is never met, so
--     EVERY raw worker is inert no matter what a control is set to. Setting a
--     control to 'enabled' therefore never makes a global worker operative outside
--     production_live, and even there a direct raw call (without the context) is
--     inert. This removes the reliance on cleanup hooks for financial safety.
--
--     Stage 3C1 wires NO scoped implementation that calls a raw worker, so raw
--     workers are inert in every 3C1 environment. Scoped execution of the raw
--     workers is Stage 3C2.
-- ------------------------------------------------------------
-- The transaction-local approved operation for the current transaction (or null).
create or replace function app_private.scoped_execution_op()
returns text language sql stable security definer set search_path = '' as $$
  select nullif(current_setting('app.financial_scope_op', true), '');
$$;
revoke all on function app_private.scoped_execution_op() from public, anon, authenticated;
grant execute on function app_private.scoped_execution_op() to authenticated, service_role;

create or replace function app_private.batch_worker_enabled(p_op text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(app_private.scoped_execution_op() = p_op, false)            -- (1) unforgeable context
     and app_private.current_financial_environment() = 'production_live'      -- (2) prod-live only
     and app_private.effective_control_state(p_op) = 'enabled'               -- (3) op control on
     and app_private.effective_control_state('production_live_operations') = 'enabled';  -- (4) master on
$$;
revoke all on function app_private.batch_worker_enabled(text) from public, anon, authenticated;
grant execute on function app_private.batch_worker_enabled(text) to authenticated, service_role;

-- Establish the transaction-local approved-run context. Callable only by a scoped
-- wrapper (service_role / definer). It re-validates EVERYTHING before granting the
-- context: an approved + confirmed + unexpired run, matching operation + scope,
-- production_live, the op control and the master control. In any non-production
-- environment it refuses, so the context can never be established under 3C1.
create or replace function app_private.begin_scoped_execution(p_run_id uuid, p_op text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_run public.financial_operation_runs; v_max int;
begin
  select max_batch_limit into v_max from public.financial_operations_config where id = true;
  if app_private.current_financial_environment() <> 'production_live' then
    raise exception 'not_production_live: scoped worker execution is only available in production_live';
  end if;
  if app_private.effective_control_state(p_op) not in ('scoped_execution', 'enabled') then
    raise exception 'control_disabled: % is not executable', p_op;
  end if;
  if app_private.effective_control_state('production_live_operations') <> 'enabled' then
    raise exception 'production_live_locked: the master control is disabled';
  end if;
  select * into v_run from public.financial_operation_runs where id = p_run_id for update;
  if v_run.id is null then raise exception 'run_not_found'; end if;
  if v_run.operation_type <> p_op then raise exception 'run_operation_mismatch'; end if;
  if v_run.state not in ('confirmed', 'executing') then raise exception 'run_not_confirmed'; end if;
  if v_run.expires_at <= now() then raise exception 'run_expired'; end if;
  if v_run.scope_type <> 'record_ids' or array_length(v_run.scoped_ids, 1) is null then raise exception 'scope_required'; end if;
  if array_length(v_run.scoped_ids, 1) > v_max then raise exception 'batch_limit_exceeded'; end if;
  perform set_config('app.financial_scope_op', p_op, true);          -- transaction-local (is_local)
  perform set_config('app.financial_scope_run', p_run_id::text, true);
end;
$$;
revoke all on function app_private.begin_scoped_execution(uuid, text) from public, anon, authenticated;
grant execute on function app_private.begin_scoped_execution(uuid, text) to service_role;

-- The central asserting guard for SCOPED, run-approved execution (used by the
-- operation-run execution wrapper and available to any future scoped worker).
-- Verifies environment, control state, production-live master, an approved +
-- unexpired + confirmed run, explicit scope and the maximum batch size.
create or replace function app_private.assert_financial_operation_allowed(
  p_operation_type text, p_execution_mode text, p_scope_ids uuid[], p_run_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
declare v_state text; v_env text; v_max int; v_run public.financial_operation_runs;
begin
  v_state := app_private.effective_control_state(p_operation_type);
  v_env := app_private.current_financial_environment();
  select max_batch_limit into v_max from public.financial_operations_config where id = true;
  if v_state = 'disabled' then raise exception 'control_disabled: % is disabled', p_operation_type; end if;
  if v_state = 'dry_run_only' then raise exception 'execution_not_permitted: % is dry_run_only', p_operation_type; end if;
  if v_env = 'production_live' and app_private.effective_control_state('production_live_operations') <> 'enabled' then
    raise exception 'production_live_locked: the production-live master switch is disabled';
  end if;
  -- scoped_execution demands an explicit, bounded, approved run.
  if v_state = 'scoped_execution' then
    if p_execution_mode <> 'execute_scoped' then raise exception 'scope_required: scoped_execution needs explicit record ids'; end if;
    if p_run_id is null then raise exception 'run_required: an approved operation run is required'; end if;
    if p_scope_ids is null or array_length(p_scope_ids, 1) is null then raise exception 'scope_required: explicit record ids are required'; end if;
    if array_length(p_scope_ids, 1) > v_max then raise exception 'batch_limit_exceeded: scope exceeds the maximum batch size'; end if;
    select * into v_run from public.financial_operation_runs where id = p_run_id;
    if v_run.id is null then raise exception 'run_not_found: unknown operation run'; end if;
    if v_run.state not in ('confirmed', 'executing') then raise exception 'run_not_confirmed: confirm the run before executing'; end if;
    if v_run.expires_at <= now() then raise exception 'run_expired: this run has expired'; end if;
  end if;
end;
$$;
revoke all on function app_private.assert_financial_operation_allowed(text, text, uuid[], uuid) from public, anon, authenticated;
grant execute on function app_private.assert_financial_operation_allowed(text, text, uuid[], uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 2c. ENVIRONMENT TRANSITION RPC. Reasoned, audited, optimistic-concurrency,
--     phrase-gated for production_live. A direct table update is impossible
--     (RLS forced, no policies); production_live needs more than one ordinary
--     state update (the confirmation phrase is a second safety parameter).
-- ------------------------------------------------------------
create or replace function public.support_set_financial_environment(
  p_expected_environment text, p_new_environment text, p_reason text, p_confirmation text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c_live_phrase constant text := 'ENABLE-PRODUCTION-LIVE'; v public.financial_operations_config;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: environment'; end if;
  if p_new_environment not in ('development', 'hosted_test', 'production_dry_run', 'production_live') then
    raise exception 'invalid_environment: unknown environment';
  end if;
  if p_reason is null or trim(p_reason) = '' then raise exception 'reason_required: a reason is required'; end if;
  if p_new_environment = 'production_live' and coalesce(p_confirmation, '') <> c_live_phrase then
    raise exception 'confirmation_required: production_live requires the confirmation phrase';
  end if;
  select * into v from public.financial_operations_config where id = true for update;
  if v.environment <> p_expected_environment then
    raise exception 'state_mismatch: environment is % (expected %)', v.environment, p_expected_environment;
  end if;
  update public.financial_operations_config
     set environment = p_new_environment, updated_by_account_id = auth.uid(), updated_at = now() where id = true;
  insert into public.financial_operation_control_events (control_name, from_state, to_state, reason, actor_account_id)
    values ('environment', v.environment, p_new_environment, trim(p_reason), auth.uid());
  return jsonb_build_object('ok', true, 'from', v.environment, 'to', p_new_environment);
end;
$$;
revoke all on function public.support_set_financial_environment(text, text, text, text) from public, anon;
grant execute on function public.support_set_financial_environment(text, text, text, text) to authenticated;

-- ============================================================
-- 3. OPERATION RUNS (immutable request → preview → confirm → execute) and
-- 4. append-only RUN EVENTS. Global unbounded execution is impossible: a run
--    MUST carry either explicit record ids or a server-filter bounded by a
--    batch limit that can never exceed the configured maximum.
-- ============================================================
create table if not exists public.financial_operation_runs (
  id uuid primary key default gen_random_uuid(),
  operation_type text not null check (operation_type in (
    'earning_release', 'transfer_claim', 'transfer_finalise',
    'refund_claim', 'refund_finalise', 'plan_renewal',
    'dispute_reconciliation', 'financial_reconciliation', 'evidence_review_release')),
  environment text not null,
  execution_mode text not null check (execution_mode in ('preview', 'execute_scoped', 'execute_batch')),
  scope_type text not null check (scope_type in ('record_ids', 'server_filter')),
  scoped_ids uuid[] not null default '{}',
  batch_limit integer not null check (batch_limit between 1 and 25),
  dry_run boolean not null default true,
  reason text not null,
  idempotency_key text unique,
  state text not null default 'requested'
    check (state in ('requested', 'previewed', 'confirmed', 'executing', 'completed', 'failed', 'cancelled', 'expired')),
  confirmation_token text not null,
  requested_by_account_id uuid references public.accounts(id),
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  executed_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null,
  cancelled_at timestamptz,
  cancelled_by_account_id uuid references public.accounts(id),
  rows_examined integer not null default 0,
  rows_eligible integer not null default 0,
  rows_claimed integer not null default 0,
  rows_succeeded integer not null default 0,
  rows_failed integer not null default 0,
  error_summary text,
  result_summary jsonb,
  -- INVARIANT: a run is always scoped. record_ids ⇒ 1..25 explicit ids;
  -- server_filter ⇒ a bounded batch. Never global, never empty.
  constraint fin_run_scoped check (
    (scope_type = 'record_ids' and array_length(scoped_ids, 1) between 1 and 25)
    or (scope_type = 'server_filter' and array_length(scoped_ids, 1) is null)
  )
);
create index if not exists fin_runs_recent_idx on public.financial_operation_runs (requested_at desc);
create index if not exists fin_runs_state_idx on public.financial_operation_runs (state, operation_type);
alter table public.financial_operation_runs enable row level security;
alter table public.financial_operation_runs force row level security;

create table if not exists public.financial_operation_run_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.financial_operation_runs(id) on delete cascade,
  action text not null check (action in (
    'requested', 'preview_generated', 'confirmation_requested', 'execution_started',
    'record_claimed', 'record_skipped', 'record_succeeded', 'record_failed',
    'cancelled', 'expired', 'control_blocked')),
  record_id uuid,
  detail jsonb,
  actor_account_id uuid references public.accounts(id),
  created_at timestamptz not null default now()
);
create index if not exists fin_run_events_idx on public.financial_operation_run_events (run_id, created_at);
alter table public.financial_operation_run_events enable row level security;
alter table public.financial_operation_run_events force row level security;

-- ============================================================
-- 5. REQUEST a run. Validates scope + batch, snapshots the environment, mints
--    an opaque confirmation token and an expiry. Idempotent on idempotency_key.
-- ============================================================
create or replace function public.support_request_operation_run(
  p_operation_type text, p_execution_mode text, p_scope_type text,
  p_scoped_ids uuid[], p_batch_limit integer, p_reason text, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_cfg public.financial_operations_config;
  v_existing public.financial_operation_runs;
  v_id uuid; v_token text; v_expires timestamptz; v_dry boolean;
  v_ids uuid[]; v_limit integer;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: operations'; end if;
  if p_operation_type not in ('earning_release','transfer_claim','transfer_finalise','refund_claim',
      'refund_finalise','plan_renewal','dispute_reconciliation','financial_reconciliation','evidence_review_release') then
    raise exception 'invalid_operation: unknown operation type';
  end if;
  if p_execution_mode not in ('preview','execute_scoped','execute_batch') then
    raise exception 'invalid_mode: unknown execution mode';
  end if;
  if p_scope_type not in ('record_ids','server_filter') then raise exception 'invalid_scope: unknown scope type'; end if;
  if p_reason is null or trim(p_reason) = '' then raise exception 'reason_required: a reason is required'; end if;
  select * into v_cfg from public.financial_operations_config where id = true;

  -- Idempotency: a repeat request with the same key returns the same run.
  if p_idempotency_key is not null then
    select * into v_existing from public.financial_operation_runs where idempotency_key = p_idempotency_key;
    if v_existing.id is not null then
      return jsonb_build_object('ok', true, 'run_id', v_existing.id, 'confirmation_token', v_existing.confirmation_token,
        'state', v_existing.state, 'expires_at', v_existing.expires_at, 'idempotent', true);
    end if;
  end if;

  -- Scope + batch validation. Global/empty/oversized scope is rejected here.
  if p_scope_type = 'record_ids' then
    v_ids := coalesce(p_scoped_ids, '{}');
    if array_length(v_ids, 1) is null then raise exception 'empty_scope: at least one record id is required'; end if;
    if array_length(v_ids, 1) > v_cfg.max_batch_limit then raise exception 'batch_limit_exceeded: too many record ids'; end if;
    v_limit := array_length(v_ids, 1);
  else
    v_ids := '{}';
    v_limit := coalesce(p_batch_limit, v_cfg.max_batch_limit);
    if v_limit < 1 then raise exception 'empty_scope: a positive batch limit is required'; end if;
    if v_limit > v_cfg.max_batch_limit then raise exception 'batch_limit_exceeded: batch limit above maximum'; end if;
  end if;

  v_dry := (p_execution_mode = 'preview');
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_expires := now() + make_interval(mins => v_cfg.run_expiry_minutes);
  insert into public.financial_operation_runs
    (operation_type, environment, execution_mode, scope_type, scoped_ids, batch_limit, dry_run, reason,
     idempotency_key, confirmation_token, requested_by_account_id, expires_at)
  values
    (p_operation_type, v_cfg.environment, p_execution_mode, p_scope_type, v_ids, v_limit, v_dry, trim(p_reason),
     p_idempotency_key, v_token, auth.uid(), v_expires)
  returning id into v_id;
  insert into public.financial_operation_run_events (run_id, action, actor_account_id, detail)
    values (v_id, 'requested', auth.uid(), jsonb_build_object('operation_type', p_operation_type, 'mode', p_execution_mode));
  return jsonb_build_object('ok', true, 'run_id', v_id, 'confirmation_token', v_token,
    'state', 'requested', 'expires_at', v_expires, 'dry_run', v_dry);
end;
$$;
revoke all on function public.support_request_operation_run(text, text, text, uuid[], integer, text, text) from public, anon;
grant execute on function public.support_request_operation_run(text, text, text, uuid[], integer, text, text) to authenticated;

-- ============================================================
-- 6. PREVIEW — strictly side-effect-free over the financial rows. It reads
--    candidate rows, explains eligibility, and records only RUN metadata
--    (counts + a 'preview_generated' event). It never locks financial rows,
--    claims work, changes attempts/timestamps, notifies, moves money or calls
--    Stripe.
-- ============================================================
-- Resolve the candidate id list for a run without locking (record_ids as given,
-- or a bounded server-owned filter per operation type).
create or replace function app_private.operation_candidate_ids(p_run public.financial_operation_runs)
returns uuid[] language plpgsql stable security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  if p_run.scope_type = 'record_ids' then return p_run.scoped_ids; end if;
  case p_run.operation_type
    when 'earning_release' then
      select array_agg(id) into v_ids from (select id from public.companion_earnings
        where state = 'pending_completion' order by created_at limit p_run.batch_limit) s;
    when 'transfer_claim' then
      select array_agg(id) into v_ids from (select id from public.companion_earnings
        where state = 'payable' and transfer_state in ('not_ready','ready','failed') order by payable_at nulls last limit p_run.batch_limit) s;
    when 'transfer_finalise' then
      select array_agg(id) into v_ids from (select id from public.companion_transfer_attempts
        where state = 'processing' order by claimed_at limit p_run.batch_limit) s;
    when 'refund_claim' then
      select array_agg(id) into v_ids from (select id from public.payment_refunds
        where state in ('requested','failed_retryable') order by requested_at limit p_run.batch_limit) s;
    when 'refund_finalise' then
      select array_agg(id) into v_ids from (select id from public.payment_refunds
        where state = 'processing' order by claimed_at limit p_run.batch_limit) s;
    when 'plan_renewal' then
      select array_agg(id) into v_ids from (select id from public.plan_billing_periods
        where status = 'paid' order by period_start limit p_run.batch_limit) s;
    when 'dispute_reconciliation' then
      select array_agg(id) into v_ids from (select id from public.payment_disputes
        where internal_state in ('unresolved','open','under_review') order by created_at limit p_run.batch_limit) s;
    when 'financial_reconciliation' then
      select array_agg(id) into v_ids from (select id from public.financial_reconciliation_findings
        where status in ('open','acknowledged','investigating') order by created_at limit p_run.batch_limit) s;
    when 'evidence_review_release' then
      select array_agg(id) into v_ids from (select id from public.companion_evidence_payout_reviews
        where state in ('active','claimed','post_transfer_review') order by first_detected_at limit p_run.batch_limit) s;
    else v_ids := '{}';
  end case;
  return coalesce(v_ids, '{}');
end;
$$;
revoke all on function app_private.operation_candidate_ids(public.financial_operation_runs) from public, anon, authenticated;
grant execute on function app_private.operation_candidate_ids(public.financial_operation_runs) to authenticated, service_role;

-- Read-only per-record eligibility for one operation type. Returns a jsonb
-- array: {id, found, current_state, eligible, expected_next_state,
-- blocking_reasons[], blocked_by_open_issue, blocked_by_dispute, blocked_by_evidence_hold}.
create or replace function app_private.operation_preview_rows(p_operation_type text, p_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_out jsonb := '[]'::jsonb; v_id uuid;
  v_reasons text[]; v_eligible boolean; v_state text; v_next text; v_found boolean;
  v_issue boolean; v_dispute boolean; v_hold boolean;
  e public.companion_earnings; ta public.companion_transfer_attempts;
  rf public.payment_refunds; dp public.payment_disputes; rv public.companion_evidence_payout_reviews;
  bp public.plan_billing_periods; fnd public.financial_reconciliation_findings;
begin
  foreach v_id in array coalesce(p_ids, '{}') loop
    v_reasons := '{}'; v_eligible := false; v_state := null; v_next := null; v_found := false;
    v_issue := false; v_dispute := false; v_hold := false;
    case p_operation_type
      when 'earning_release' then
        select * into e from public.companion_earnings where id = v_id;
        if e.id is not null then
          v_found := true; v_state := e.state;
          v_hold := app_private.evidence_hold_blocks_payout(e.booking_id);
          v_issue := exists (select 1 from public.conversation_issues i where i.booking_id = e.booking_id and i.state <> 'resolved');
          if e.state <> 'pending_completion' then v_reasons := array_append(v_reasons, 'not_pending_completion'); end if;
          if v_hold then v_reasons := array_append(v_reasons, 'evidence_hold_blocks_payout'); end if;
          v_eligible := (e.state = 'pending_completion' and not v_hold);
          v_next := case when v_eligible then 'payable' else e.state end;
        end if;
      when 'transfer_claim' then
        select * into e from public.companion_earnings where id = v_id;
        if e.id is not null then
          v_found := true; v_state := e.state || '/' || e.transfer_state;
          v_hold := app_private.evidence_hold_blocks_payout(e.booking_id);
          v_issue := exists (select 1 from public.conversation_issues i where i.booking_id = e.booking_id and i.state <> 'resolved');
          if e.state <> 'payable' then v_reasons := array_append(v_reasons, 'earning_not_payable'); end if;
          if e.transfer_state not in ('not_ready','ready','failed') then v_reasons := array_append(v_reasons, 'transfer_already_in_flight'); end if;
          if v_hold then v_reasons := array_append(v_reasons, 'evidence_hold_blocks_payout'); end if;
          if v_issue then v_reasons := array_append(v_reasons, 'open_conversation_issue'); end if;
          if not app_private.companion_payments_ready(e.companion_profile_id) then v_reasons := array_append(v_reasons, 'companion_not_connect_ready'); end if;
          v_eligible := (e.state = 'payable' and e.transfer_state in ('not_ready','ready','failed')
                         and not v_hold and not v_issue and app_private.companion_payments_ready(e.companion_profile_id));
          v_next := case when v_eligible then 'processing' else e.transfer_state end;
        end if;
      when 'transfer_finalise' then
        select * into ta from public.companion_transfer_attempts where id = v_id;
        if ta.id is not null then
          v_found := true; v_state := ta.state;
          if ta.state <> 'processing' then v_reasons := array_append(v_reasons, 'attempt_not_processing'); end if;
          v_eligible := (ta.state = 'processing');
          v_next := case when v_eligible then 'succeeded|failed (provider-driven)' else ta.state end;
        end if;
      when 'refund_claim' then
        select * into rf from public.payment_refunds where id = v_id;
        if rf.id is not null then
          v_found := true; v_state := rf.state;
          if rf.state not in ('requested','failed_retryable') then v_reasons := array_append(v_reasons, 'refund_not_claimable'); end if;
          v_eligible := (rf.state in ('requested','failed_retryable'));
          v_next := case when v_eligible then 'processing' else rf.state end;
        end if;
      when 'refund_finalise' then
        select * into rf from public.payment_refunds where id = v_id;
        if rf.id is not null then
          v_found := true; v_state := rf.state;
          if rf.state <> 'processing' then v_reasons := array_append(v_reasons, 'refund_not_processing'); end if;
          v_eligible := (rf.state = 'processing');
          v_next := case when v_eligible then 'succeeded|failed (provider-driven)' else rf.state end;
        end if;
      when 'plan_renewal' then
        select * into bp from public.plan_billing_periods where id = v_id;
        if bp.id is not null then
          v_found := true; v_state := bp.status;
          if bp.status <> 'paid' then v_reasons := array_append(v_reasons, 'period_not_paid'); end if;
          v_eligible := (bp.status = 'paid');
          v_next := case when v_eligible then 'renewal_candidate' else bp.status end;
        end if;
      when 'dispute_reconciliation' then
        select * into dp from public.payment_disputes where id = v_id;
        if dp.id is not null then
          v_found := true; v_state := dp.internal_state; v_dispute := true;
          if dp.internal_state not in ('unresolved','open','under_review') then v_reasons := array_append(v_reasons, 'dispute_already_resolved'); end if;
          v_eligible := (dp.internal_state in ('unresolved','open','under_review'));
          v_next := case when v_eligible then 'reconcile_candidate' else dp.internal_state end;
        end if;
      when 'financial_reconciliation' then
        select * into fnd from public.financial_reconciliation_findings where id = v_id;
        if fnd.id is not null then
          v_found := true; v_state := fnd.status;
          if fnd.status not in ('open','acknowledged','investigating') then v_reasons := array_append(v_reasons, 'finding_not_actionable'); end if;
          v_eligible := (fnd.status in ('open','acknowledged','investigating'));
          v_next := case when v_eligible then 'refresh_candidate' else fnd.status end;
        end if;
      when 'evidence_review_release' then
        select * into rv from public.companion_evidence_payout_reviews where id = v_id;
        if rv.id is not null then
          v_found := true; v_state := rv.state; v_hold := (rv.state in ('active','claimed'));
          if rv.state not in ('active','claimed','post_transfer_review') then v_reasons := array_append(v_reasons, 'review_already_closed'); end if;
          v_eligible := (rv.state in ('active','claimed','post_transfer_review'));
          v_next := case when v_eligible then 'released|superseded (support decision)' else rv.state end;
        end if;
      else null;
    end case;
    if not v_found then v_reasons := array_append(v_reasons, 'not_found'); end if;
    v_out := v_out || jsonb_build_object(
      'id', v_id, 'found', v_found, 'current_state', v_state, 'eligible', v_eligible,
      'expected_next_state', v_next, 'blocking_reasons', to_jsonb(v_reasons),
      'blocked_by_open_issue', v_issue, 'blocked_by_dispute', v_dispute, 'blocked_by_evidence_hold', v_hold);
  end loop;
  return v_out;
end;
$$;
revoke all on function app_private.operation_preview_rows(text, uuid[]) from public, anon, authenticated;
grant execute on function app_private.operation_preview_rows(text, uuid[]) to authenticated, service_role;

-- Support-only preview of a run. Side-effect-free on financial rows.
create or replace function public.support_preview_operation_run(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.financial_operation_runs; v_ids uuid[]; v_rows jsonb; v_elig integer;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: run'; end if;
  select * into v_run from public.financial_operation_runs where id = p_run_id;
  if v_run.id is null then raise exception 'not_found: run'; end if;
  if v_run.state in ('cancelled','expired','completed','failed') then
    raise exception 'run_closed: this run can no longer be previewed';
  end if;
  v_ids := app_private.operation_candidate_ids(v_run);
  v_rows := app_private.operation_preview_rows(v_run.operation_type, v_ids);
  select count(*) into v_elig from jsonb_array_elements(v_rows) r where (r->>'eligible')::boolean;
  -- Record ONLY run metadata (no financial-row mutation).
  update public.financial_operation_runs
     set state = case when state = 'requested' then 'previewed' else state end,
         rows_examined = coalesce(array_length(v_ids, 1), 0), rows_eligible = v_elig,
         result_summary = jsonb_build_object('previewed_at', now(), 'eligible', v_elig, 'examined', coalesce(array_length(v_ids, 1), 0))
   where id = p_run_id;
  insert into public.financial_operation_run_events (run_id, action, actor_account_id, detail)
    values (p_run_id, 'preview_generated', auth.uid(), jsonb_build_object('examined', coalesce(array_length(v_ids, 1), 0), 'eligible', v_elig));
  return jsonb_build_object('ok', true, 'run_id', p_run_id, 'operation_type', v_run.operation_type,
    'examined', coalesce(array_length(v_ids, 1), 0), 'eligible', v_elig, 'rows', v_rows);
end;
$$;
revoke all on function public.support_preview_operation_run(uuid) from public, anon;
grant execute on function public.support_preview_operation_run(uuid) to authenticated;

-- ============================================================
-- 7. CONFIRM / CANCEL. Confirmation requires the opaque token, a previewed +
--    unexpired run, and is single-winner (row lock). Repeat is idempotent.
-- ============================================================
create or replace function public.support_confirm_operation_run(p_run_id uuid, p_confirmation_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.financial_operation_runs;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: run'; end if;
  select * into v_run from public.financial_operation_runs where id = p_run_id for update;
  if v_run.id is null then raise exception 'not_found: run'; end if;
  if v_run.confirmation_token is distinct from p_confirmation_token then raise exception 'invalid_token: confirmation token mismatch'; end if;
  if v_run.state in ('confirmed','executing','completed') then
    return jsonb_build_object('ok', true, 'already_confirmed', true, 'state', v_run.state);   -- idempotent
  end if;
  if v_run.state = 'cancelled' then raise exception 'run_cancelled: this run was cancelled'; end if;
  if v_run.expires_at <= now() then
    update public.financial_operation_runs set state = 'expired' where id = p_run_id and state not in ('completed','cancelled');
    insert into public.financial_operation_run_events (run_id, action, actor_account_id) values (p_run_id, 'expired', auth.uid());
    raise exception 'run_expired: this run has expired';
  end if;
  if v_run.state <> 'previewed' then raise exception 'preview_required: preview the run before confirming'; end if;
  update public.financial_operation_runs set state = 'confirmed' where id = p_run_id;
  insert into public.financial_operation_run_events (run_id, action, actor_account_id) values (p_run_id, 'confirmation_requested', auth.uid());
  return jsonb_build_object('ok', true, 'state', 'confirmed');
end;
$$;
revoke all on function public.support_confirm_operation_run(uuid, text) from public, anon;
grant execute on function public.support_confirm_operation_run(uuid, text) to authenticated;

create or replace function public.support_cancel_operation_run(p_run_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.financial_operation_runs;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: run'; end if;
  if p_reason is null or trim(p_reason) = '' then raise exception 'reason_required: a reason is required'; end if;
  select * into v_run from public.financial_operation_runs where id = p_run_id for update;
  if v_run.id is null then raise exception 'not_found: run'; end if;
  if v_run.state in ('completed','cancelled','expired') then
    return jsonb_build_object('ok', true, 'already_closed', true, 'state', v_run.state);   -- idempotent
  end if;
  update public.financial_operation_runs
     set state = 'cancelled', cancelled_at = now(), cancelled_by_account_id = auth.uid(), error_summary = trim(p_reason)
   where id = p_run_id;
  insert into public.financial_operation_run_events (run_id, action, actor_account_id, detail)
    values (p_run_id, 'cancelled', auth.uid(), jsonb_build_object('reason', trim(p_reason)));
  return jsonb_build_object('ok', true, 'state', 'cancelled');
end;
$$;
revoke all on function public.support_cancel_operation_run(uuid, text) from public, anon;
grant execute on function public.support_cancel_operation_run(uuid, text) to authenticated;

-- ============================================================
-- 8/9. EXECUTION WRAPPER. Narrowly scoped, idempotent, control-gated. During
--   Stage 3C1 EVERY control defaults to 'disabled', so execution is blocked and
--   records a 'control_blocked' event. Even once a control permits it, the ONLY
--   wired executor is the non-Stripe earning-release path (make_earning_payable)
--   over explicitly-scoped ids; all Stripe-touching workers raise
--   'stage_not_enabled' and are deferred to Stage 3C2. No worker is ever run
--   globally, and no run touches a row outside its scope.
-- ============================================================
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
  if v_state = 'disabled' then
    insert into public.financial_operation_run_events (run_id, action, actor_account_id, detail)
      values (p_run_id, 'control_blocked', auth.uid(), jsonb_build_object('control', v_control, 'control_state', 'disabled'));
    raise exception 'control_disabled: % is disabled', v_control;
  end if;
  if v_state = 'dry_run_only' then
    insert into public.financial_operation_run_events (run_id, action, actor_account_id, detail)
      values (p_run_id, 'control_blocked', auth.uid(), jsonb_build_object('control', v_control, 'control_state', 'dry_run_only'));
    raise exception 'execution_not_permitted: % is dry_run_only', v_control;
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

-- ============================================================
-- 12/13. READINESS SUMMARY + recent runs (support-only, no secrets). Safe
--   aggregate counts and named thresholds; never Stripe secrets, payloads,
--   bank/card data, private messages or review feedback.
-- ============================================================
create or replace function public.support_financial_readiness()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_cfg public.financial_operations_config; v_stale timestamptz; v_rstale timestamptz; v_disp timestamptz;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: readiness'; end if;
  select * into v_cfg from public.financial_operations_config where id = true;
  v_stale := now() - make_interval(mins => v_cfg.stale_processing_minutes);
  v_rstale := now() - make_interval(mins => v_cfg.stale_refund_minutes);
  v_disp := now() + make_interval(hours => v_cfg.dispute_deadline_warning_hours);
  return jsonb_build_object(
    'environment', v_cfg.environment,
    'thresholds', jsonb_build_object(
      'stale_processing_minutes', v_cfg.stale_processing_minutes,
      'stale_refund_minutes', v_cfg.stale_refund_minutes,
      'run_expiry_minutes', v_cfg.run_expiry_minutes,
      'max_batch_limit', v_cfg.max_batch_limit,
      'dispute_deadline_warning_hours', v_cfg.dispute_deadline_warning_hours),
    'counts', jsonb_build_object(
      'pending_earnings', (select count(*) from public.companion_earnings where state = 'pending_completion'),
      'payable_awaiting_transfer', (select count(*) from public.companion_earnings where state = 'payable' and transfer_state in ('not_ready','ready','failed')),
      'processing_transfers_stale', (select count(*) from public.companion_transfer_attempts where state = 'processing' and claimed_at < v_stale),
      'retryable_transfer_failures', (select count(*) from public.companion_transfer_attempts where state = 'failed_retryable'),
      'permanent_transfer_failures', (select count(*) from public.companion_transfer_attempts where state = 'failed_permanent'),
      'refunds_active', (select count(*) from public.payment_refunds where state in ('requested','processing')),
      'refunds_stale', (select count(*) from public.payment_refunds where state in ('requested','processing') and coalesce(claimed_at, requested_at) < v_rstale),
      'unresolved_disputes', (select count(*) from public.payment_disputes where internal_state in ('unresolved','open','under_review')),
      'disputes_nearing_deadline', (select count(*) from public.payment_disputes where internal_state in ('unresolved','open','under_review') and evidence_due_at is not null and evidence_due_at <= v_disp),
      'active_evidence_reviews', (select count(*) from public.companion_evidence_payout_reviews where state in ('active','claimed','post_transfer_review')),
      'unresolved_reconciliation_findings', (select count(*) from public.financial_reconciliation_findings where status in ('open','acknowledged','investigating')),
      'webhooks_missing_result', (select count(*) from public.stripe_webhook_events where processed_at is null),
      'plan_billing_drift', (select count(*) from public.plan_billing_periods where status = 'failed')),
    'controls', coalesce((select jsonb_agg(jsonb_build_object(
        'control_name', c.control_name, 'state', app_private.effective_control_state(c.control_name),
        'reason', c.reason, 'expires_at', c.expires_at, 'updated_at', c.updated_at) order by c.control_name)
      from public.financial_operation_controls c), '[]'::jsonb),
    'recent_runs', coalesce((select jsonb_agg(r) from (
        select jsonb_build_object('id', id, 'operation_type', operation_type, 'execution_mode', execution_mode,
          'state', state, 'dry_run', dry_run, 'rows_examined', rows_examined, 'rows_eligible', rows_eligible,
          'rows_succeeded', rows_succeeded, 'requested_at', requested_at) r
        from public.financial_operation_runs order by requested_at desc limit 10) q), '[]'::jsonb));
end;
$$;
revoke all on function public.support_financial_readiness() from public, anon;
grant execute on function public.support_financial_readiness() to authenticated;

create or replace function public.support_recent_operation_runs(p_limit integer default 25)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not app_private.is_support_admin() then raise exception 'not_found: runs'; end if;
  return coalesce((select jsonb_agg(r) from (
    select jsonb_build_object('id', id, 'operation_type', operation_type, 'execution_mode', execution_mode,
      'scope_type', scope_type, 'state', state, 'dry_run', dry_run, 'reason', reason,
      'rows_examined', rows_examined, 'rows_eligible', rows_eligible, 'rows_succeeded', rows_succeeded,
      'rows_failed', rows_failed, 'requested_at', requested_at, 'expires_at', expires_at,
      'requested_by_account_id', requested_by_account_id) r
    from public.financial_operation_runs order by requested_at desc limit least(greatest(p_limit, 1), 100)) q), '[]'::jsonb);
end;
$$;
revoke all on function public.support_recent_operation_runs(integer) from public, anon;
grant execute on function public.support_recent_operation_runs(integer) to authenticated;

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
    'events', coalesce((select jsonb_agg(jsonb_build_object('action', action, 'record_id', record_id,
        'detail', detail, 'actor_account_id', actor_account_id, 'created_at', created_at) order by created_at)
      from public.financial_operation_run_events where run_id = p_run_id), '[]'::jsonb));
end;
$$;
revoke all on function public.support_operation_run_detail(uuid) from public, anon;
grant execute on function public.support_operation_run_detail(uuid) to authenticated;

-- ============================================================
-- 13. AUTHORITATIVE KILL-SWITCH ENFORCEMENT ON THE RAW WORKERS.
--     Each authoritative batch/global worker is redefined VERBATIM from its
--     LATEST cumulative body (after 0072) with ONE added guard as its first
--     statement: `if not app_private.batch_worker_enabled('<op>') then return …`.
--     This is the narrowest safe choke point — it precedes every claim/mutation
--     — and it fires identically for a direct service-role RPC, a pg_cron job
--     running as a superuser (e.g. the 15-minute process_post_conversation_tasks
--     which calls resolve_unconfirmed_attendance + release_eligible_earnings, and
--     the daily process-plan-renewals job), an Edge Function (stripe-transfers /
--     stripe-refunds settlement), or an internal orchestrator. With every control
--     defaulting to 'disabled', these workers refuse to claim or mutate anything.
--
--     Provider-state RECORDING functions (finalize_transfer_*, finalize_refund_*,
--     record_dispute_*, finalize_paid_order, claim_webhook_event) are DELIBERATELY
--     NOT guarded: they record already-occurred Stripe outcomes for the webhook,
--     and blocking them would break idempotency and provider-state recording (see
--     the Stage 3C1 safety policy). Money MOVEMENT is initiated only by the guarded
--     claim/release workers, so guarding those is the complete money-movement choke.
--
--     Bodies are byte-identical to their latest cumulative source except the guard
--     line; grants persist across CREATE OR REPLACE and are intentionally unchanged.
-- ============================================================

-- transfer_claim ← claim_plan_transfers (latest: 0072)
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
  if not app_private.batch_worker_enabled('transfer_claim') then return; end if;   -- Stage 3C1 kill switch
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
      and not app_private.evidence_hold_blocks_payout(e.booking_id)   -- Stage 3B2 hold
      and not exists (select 1 from public.companion_transfer_attempts ta
                      where ta.earning_id = e.id
                        and ta.state in ('processing', 'succeeded', 'failed_permanent'))
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
    stripe_idempotency_key := 'transfer-' || r.earning_id::text; -- stable ⇒ exactly-once
    return next;
  end loop;
end;
$$;

-- refund_claim ← claim_payment_refunds (latest: 0056)
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
  if not app_private.batch_worker_enabled('refund_claim') then return; end if;   -- Stage 3C1 kill switch
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

-- transfer_claim ← recover_stale_transfers (latest: 0048)
create or replace function public.recover_stale_transfers(p_minutes integer default 30)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare v_count integer;
begin
  if not app_private.batch_worker_enabled('transfer_claim') then return 0; end if;   -- Stage 3C1 kill switch
  with stale as (
    update public.companion_transfer_attempts ta
       set state = 'failed_retryable',
           failure_code = 'stale_claim',
           failure_message = 'Worker did not finalise in time; safe to retry.',
           updated_at = now()
     where ta.state = 'processing'
       and ta.stripe_transfer_id is null
       and ta.claimed_at < now() - make_interval(mins => greatest(p_minutes, 1))
    returning ta.earning_id
  )
  update public.companion_earnings e set transfer_state = 'failed', updated_at = now()
    from stale where e.id = stale.earning_id and e.transfer_state = 'processing';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- refund_claim ← recover_stale_refunds (latest: 0052)
create or replace function public.recover_stale_refunds(p_minutes integer default 30)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare v_count integer;
begin
  if not app_private.batch_worker_enabled('refund_claim') then return 0; end if;   -- Stage 3C1 kill switch
  update public.payment_refunds
     set state = 'failed_retryable', failure_code = 'stale_claim',
         failure_message = 'Worker did not finalise in time; safe to retry.', updated_at = now()
   where state = 'processing' and stripe_refund_id is null
     and claimed_at < now() - make_interval(mins => greatest(p_minutes, 1));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- earning_release ← release_eligible_earnings (latest: 0034)
create or replace function public.release_eligible_earnings()
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count integer := 0;
begin
  if not app_private.batch_worker_enabled('earning_release') then return 0; end if;   -- Stage 3C1 kill switch
  for v_row in
    select e.id
    from public.companion_earnings e
    join public.bookings b on b.id = e.booking_id
    join public.conversation_attendance a
      on a.booking_id = e.booking_id and a.outcome = 'took_place'
    where e.state = 'pending_completion'
      and b.ends_at + interval '12 hours' <= now()
      and not exists (select 1 from public.conversation_issues i
                      where i.booking_id = e.booking_id and i.state <> 'resolved')
    limit 100
    for update of e skip locked
  loop
    perform app_private.make_earning_payable(v_row.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- earning_release ← resolve_unconfirmed_attendance (latest: 0068)
create or replace function public.resolve_unconfirmed_attendance()
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_comp integer;
  v_mem integer;
  v_earning uuid;
  v_companion_account uuid;
  v_member_name text;
  v_companion_name text;
  v_count integer := 0;
begin
  if not app_private.batch_worker_enabled('earning_release') then return 0; end if;   -- Stage 3C1 kill switch
  for v_row in
    select b.id as booking_id, b.ends_at, b.booked_by_account_id,
           b.member_profile_id, b.companion_profile_id
    from public.bookings b
    where b.ends_at + interval '24 hours' <= now()
      and b.status = 'confirmed'                     -- INVARIANT: accepted bookings only
      and not exists (select 1 from public.conversation_attendance a where a.booking_id = b.id)
      and not exists (select 1 from public.conversation_issues i
                      where i.booking_id = b.id and i.state <> 'resolved')
      and (
        exists (select 1 from public.payment_orders po
                where po.booking_id = b.id and po.provider = 'stripe_test' and po.status = 'succeeded')
        or exists (
          select 1
          from public.conversation_plans p
          join public.plan_billing_periods bp on bp.plan_id = p.id
          where p.id = b.plan_id and p.funding_mode = 'recurring'
            and bp.status = 'paid'
            and bp.period_start = date_trunc('month', (b.starts_at at time zone b.timezone))::date)
      )
    limit 100
    for update of b skip locked
  loop
    v_earning := app_private.ensure_companion_earning(v_row.booking_id);
    if v_earning is null then continue; end if;

    select companion_account_id into v_companion_account
      from public.companion_earnings where id = v_earning;
    select first_name into v_member_name from public.profiles where id = v_row.member_profile_id;
    select first_name into v_companion_name from public.profiles where id = v_row.companion_profile_id;

    select coalesce(sum(duration_seconds), 0) into v_comp
      from public.call_attendance_segments
      where booking_id = v_row.booking_id and side = 'companion';
    select coalesce(sum(duration_seconds), 0) into v_mem
      from public.call_attendance_segments
      where booking_id = v_row.booking_id and side = 'member';

    if v_comp >= 120 and v_mem >= 120 then
      insert into public.conversation_attendance
        (booking_id, outcome, source, explanation)
      values (v_row.booking_id, 'took_place', 'system',
              'Apparent completion from trusted attendance')
      on conflict (booking_id) do nothing;
      perform app_private.make_earning_payable(v_earning);
      perform app_private.notify_account(
        v_companion_account, 'conversation_completed', 'Conversation completed',
        'We confirmed the conversation attendance from the call record.',
        v_row.booking_id, 'fallback-completed:' || v_row.booking_id::text);
      perform app_private.notify_account(
        v_row.booked_by_account_id, 'conversation_completed', 'Conversation completed',
        'The conversation between ' || coalesce(v_member_name, 'the member') || ' and '
          || coalesce(v_companion_name, 'the companion') || ' has been marked as completed.',
        v_row.booking_id, 'fallback-completed:' || v_row.booking_id::text);

    elsif v_comp >= 600 and v_mem < 120 then
      insert into public.conversation_attendance
        (booking_id, outcome, source, explanation)
      values (v_row.booking_id, 'member_no_show', 'system',
              'Likely Member no-show from trusted attendance')
      on conflict (booking_id) do nothing;
      perform app_private.make_earning_payable(v_earning);
      perform app_private.notify_account(
        v_companion_account, 'attendance_confirmed', 'Attendance confirmed',
        'Your attendance was confirmed and your earnings are ready for payout.',
        v_row.booking_id, 'fallback-attendance:' || v_row.booking_id::text);
      perform app_private.notify_account(
        v_row.booked_by_account_id, 'attendance_updated', 'Conversation attendance updated',
        'The conversation attendance was reviewed using the call record.',
        v_row.booking_id, 'fallback-attendance:' || v_row.booking_id::text);

    else
      update public.companion_earnings set state = 'held_for_issue', updated_at = now()
       where id = v_earning and state = 'pending_completion';
      insert into public.conversation_issues
        (booking_id, earning_id, reporter_account_id, reporter_role, category,
         description, idempotency_key)
      select v_row.booking_id, v_earning, e.companion_account_id, 'system', 'unclear_attendance',
             'Attendance evidence unclear — manual review required',
             'unclear-' || v_row.booking_id::text
      from public.companion_earnings e where e.id = v_earning
      on conflict (idempotency_key) do nothing;
      perform app_private.notify_account(
        v_companion_account, 'attendance_under_review', 'Conversation under review',
        'We could not confirm the conversation outcome automatically. It is being reviewed.',
        v_row.booking_id, 'attendance-review:' || v_row.booking_id::text);
      perform app_private.notify_account(
        v_row.booked_by_account_id, 'attendance_under_review', 'Conversation under review',
        'The conversation outcome could not be confirmed automatically and is being reviewed.',
        v_row.booking_id, 'attendance-review:' || v_row.booking_id::text);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- plan_renewal ← process_plan_renewals (latest: 0043). Also neutralises the
-- DAILY process-plan-renewals pg_cron job (which runs as a superuser): the guard
-- makes it a clean no-op until the control is explicitly enabled.
create or replace function public.process_plan_renewals()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_period date := date_trunc('month', now())::date;
  v_count integer := 0;
  v_errors text := '';
begin
  if not app_private.batch_worker_enabled('plan_renewal') then
    return jsonb_build_object('skipped', true, 'reason', 'plan_renewal control not enabled');   -- Stage 3C1 kill switch
  end if;
  for v_row in
    select p.id
    from public.conversation_plans p
    where p.status = 'active' and p.billing_enabled and p.funding_mode = 'recurring'
      and not exists (
        select 1 from public.plan_billing_periods bp
        where bp.plan_id = p.id and bp.period_start = v_period
          and bp.status in ('paid', 'processing', 'payment_pending', 'action_required',
                            'payment_failed', 'closed'))
    limit 100
    for update of p skip locked
  loop
    begin
      perform public.renew_plan_billing_period(v_row.id, v_period);
      v_count := v_count + 1;
    exception when others then
      v_errors := v_errors || v_row.id::text || ': ' || sqlerrm || '; ';
    end;
  end loop;
  return jsonb_build_object('period', v_period, 'processed', v_count, 'errors', nullif(v_errors, ''));
end;
$$;

-- financial_reconciliation ← app_private.process_financial_reconciliation (latest:
-- 0063). This is the single funnel behind BOTH public run_financial_reconciliation
-- and run_financial_reconciliation_for_entities, so guarding it here governs both.
create or replace function app_private.process_financial_reconciliation(
  p_scope_ids uuid[] default null, p_limit integer default 500,
  p_trigger text default 'scheduled', p_actor uuid default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run uuid; r record; v_action text;
  v_scanned int := 0; v_created int := 0; v_refreshed int := 0; v_cleared int := 0;
  v_cap int := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_complete boolean;
begin
  if not app_private.batch_worker_enabled('financial_reconciliation') then
    return jsonb_build_object('skipped', true, 'reason', 'financial_reconciliation control not enabled');   -- Stage 3C1 kill switch
  end if;
  if p_trigger not in ('scheduled', 'manual', 'entity', 'test') then p_trigger := 'scheduled'; end if;
  insert into public.financial_reconciliation_runs (scope, trigger_type, status, actor_account_id)
  values (case when p_scope_ids is null then 'full' else 'entity' end, p_trigger, 'running', p_actor)
  returning id into v_run;

  for r in select * from app_private.detect_financial_findings(p_scope_ids, v_cap) loop
    v_scanned := v_scanned + 1;
    v_action := app_private.upsert_frec_finding(
      v_run, r.finding_key, r.finding_type, r.severity, r.entity_type, r.entity_id,
      r.order_id, r.earning_id, r.transfer_id, r.refund_id, r.dispute_id,
      r.provider_ref, r.expected, r.observed);
    if v_action = 'created' then v_created := v_created + 1;
    elsif v_action in ('refreshed', 'reopened') then v_refreshed := v_refreshed + 1; end if;
  end loop;

  -- Only clear when we KNOW the relevant entities were fully evaluated.
  v_complete := v_scanned < v_cap; -- a full result below the cap is a complete scan
  if p_scope_ids is not null or v_complete then
    for r in
      select id from public.financial_reconciliation_findings
      where status in ('open', 'acknowledged', 'investigating')
        and (latest_run_id is distinct from v_run)
        and (p_scope_ids is null or primary_entity_id = any(p_scope_ids))
      for update
    loop
      update public.financial_reconciliation_findings
         set status = 'cleared', cleared_at = now(), updated_at = now() where id = r.id;
      perform app_private.write_frec_audit(r.id, 'cleared', null, '{}'::jsonb);
      v_cleared := v_cleared + 1;
    end loop;
  end if;

  update public.financial_reconciliation_runs
     set status = 'completed', completed_at = now(), scanned_count = v_scanned,
         findings_created = v_created, findings_refreshed = v_refreshed, findings_cleared = v_cleared
   where id = v_run;

  return jsonb_build_object('run_id', v_run, 'scope', case when p_scope_ids is null then 'full' else 'entity' end,
    'scanned', v_scanned, 'created', v_created, 'refreshed', v_refreshed, 'cleared', v_cleared,
    'complete_scan', (p_scope_ids is not null or v_complete));
end;
$$;

-- dispute_reconciliation ← app_private.process_dispute_deadline_alerts (latest: 0062)
create or replace function app_private.process_dispute_deadline_alerts(p_limit integer default 200)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r record; v jsonb;
  v_processed int := 0; v_alerts int := 0; v_notifs int := 0; v_escalations int := 0;
begin
  if not app_private.batch_worker_enabled('dispute_reconciliation') then
    return jsonb_build_object('skipped', true, 'reason', 'dispute_reconciliation control not enabled');   -- Stage 3C1 kill switch
  end if;
  for r in
    select d.id from public.payment_disputes d
    where d.internal_state not in ('won', 'lost', 'closed_warning')
      and d.evidence_due_at is not null
    order by d.evidence_due_at asc
    -- Bounded: null → 200; zero/negative → 1; excessive → capped at 1000.
    limit least(greatest(coalesce(p_limit, 200), 1), 1000)
  loop
    v := app_private.process_one_dispute_alert(r.id);
    v_processed := v_processed + 1;
    v_alerts := v_alerts + coalesce((v->>'alerts')::int, 0);
    v_notifs := v_notifs + coalesce((v->>'notifications')::int, 0);
    v_escalations := v_escalations + coalesce((v->>'escalations')::int, 0);
  end loop;
  return jsonb_build_object('processed', v_processed, 'alerts', v_alerts,
    'notifications', v_notifs, 'escalations', v_escalations, 'ran_at', now());
end;
$$;

-- ============================================================
-- 14. PostgREST schema reload so the new RPCs are exposed immediately.
-- ============================================================
select pg_notify('pgrst', 'reload schema');
