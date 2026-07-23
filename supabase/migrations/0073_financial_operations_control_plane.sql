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
-- production-live states require a second safety parameter (confirmation
-- phrase) so a single boolean update can never reach production_live.
create or replace function public.support_set_financial_control(
  p_control text, p_expected_state text, p_new_state text,
  p_reason text, p_expires_at timestamptz default null, p_confirmation text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_live_phrase constant text := 'ENABLE-PRODUCTION-LIVE';
  v_row public.financial_operation_controls;
  v_env text;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: control'; end if;
  if p_new_state not in ('disabled', 'dry_run_only', 'scoped_execution', 'enabled') then
    raise exception 'invalid_state: unknown control state';
  end if;
  if p_reason is null or trim(p_reason) = '' then raise exception 'reason_required: a reason is required'; end if;
  select environment into v_env from public.financial_operations_config where id = true;
  -- Second safety gate: turning the production-live master switch ON, or enabling
  -- ANY control while the environment is production_live, needs the phrase.
  if ((p_control = 'production_live_operations' and p_new_state <> 'disabled')
      or (v_env = 'production_live' and p_new_state = 'enabled'))
     and coalesce(p_confirmation, '') <> c_live_phrase then
    raise exception 'confirmation_required: production-live changes require the confirmation phrase';
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
-- 14. PostgREST schema reload so the new RPCs are exposed immediately.
-- ============================================================
select pg_notify('pgrst', 'reload schema');
