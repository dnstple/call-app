-- ============================================================================
-- 0078_scoped_provider_transfer_execution.sql  (Stage 3C2-C2)
--
-- Scoped PROVIDER transfer execution — the durable saga that lets an authorised
-- operations administrator move ≤5 explicit earnings through a lookup-first,
-- exactly-once Stripe TEST-mode transfer flow. THIS MIGRATION CONTAINS NO
-- PROVIDER CODE: a database transaction can never span a Stripe request, so the
-- network work lives in the (undeployed) scoped-stripe-transfers Edge Function,
-- which may only speak to the database through the narrow lease-bound RPCs below.
--
-- ADDITIVE ONLY (0001–0077 immutable). Operation type: the audited existing
-- 'transfer_finalise' (control row exists since 0073). Canonical scope: earning
-- UUIDs (attempts are 1:1 via unique(earning_id)).
--
-- SAGA (per earning): support requests/previews/confirms a transfer_finalise
-- run → the Edge endpoint presents the run id + confirmation token (single-use
-- support credential) → begin_run revalidates everything and returns the deduped
-- scope → begin_item locks + reclassifies the earning, leases exactly one local
-- attempt where safe, and issues a single-use time-limited lease with an
-- IMMUTABLE expected snapshot (amount/currency/destination/metadata/stable key
-- 'transfer-<earning>' + a conservative lookup window) → the Edge performs an
-- immediate bounded provider LOOKUP (Stripe has no idempotency-key lookup; keys
-- are not retained forever; metadata matching is client-side) → record_lookup
-- persists the outcome: an exact match finalises WITHOUT create; mismatch/
-- ambiguity/failure become reconciliation_required; ONLY not_found may proceed →
-- authorize_create re-verifies the lease, freshness (≤2 min), run, control and
-- attempt state IMMEDIATELY before the POST and returns the exact snapshot → the
-- Edge creates ONE transfer with the stable key and exact parameters →
-- finalize_success verifies the returned transfer against the snapshot
-- (livemode included) and settles through the EXISTING idempotent
-- finalize_transfer_succeeded; uncertain outcomes become
-- provider_outcome_unknown/reconciliation_required (NEVER retryable, NEVER an
-- immediate second create); definitive rejections use the audited retryable/
-- permanent finalisers. Every retry begins with a fresh lookup.
--
-- SAFETY: jobs live in a dedicated table no legacy worker reads;
-- recover_stale_transfers is redefined ADDITIVELY to skip attempts with an
-- active scoped job (legacy behaviour for all other attempts is byte-identical);
-- claim_plan_transfers is never invoked; batch is capped at 5 (below the generic
-- 25) and a configurable aggregate amount ceiling (default 0 = BLOCKED until
-- explicitly configured) gates every run; leases are hashed, single-use and
-- time-limited; an expired lease NEVER authorises creation — re-entry resets to
-- the lookup stage. Protected historical ids appear nowhere here.
-- ============================================================================

-- ============================================================
-- 1. CONFIG: aggregate per-run provider-transfer ceiling. Default 0 blocks all
--    provider execution until an operator explicitly configures it.
-- ============================================================
alter table public.financial_operations_config
  add column if not exists provider_transfer_amount_ceiling_minor integer not null default 0
    check (provider_transfer_amount_ceiling_minor >= 0);

-- ============================================================
-- 2. DURABLE SAGA STATE — a dedicated jobs table the legacy global worker can
--    neither select nor overwrite. Definer-only (RLS forced, no policies).
-- ============================================================
create table if not exists public.scoped_transfer_execution_jobs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.financial_operation_runs(id) on delete cascade,
  earning_id uuid not null,
  transfer_attempt_id uuid,
  state text not null default 'provider_lookup_pending' check (state in (
    'provider_lookup_pending',      -- leased; lookup not yet recorded
    'lookup_recorded',              -- lookup=not_found; may be authorised to create
    'provider_create_pending',      -- authorised; POST may be in flight
    'finalized_success',            -- settled locally (found or created)
    'provider_outcome_unknown',     -- timeout after possible provider execution
    'reconciliation_required',      -- mismatch/ambiguity/lookup failure
    'closed_rejected')),            -- definitive provider rejection recorded
  lease_token_hash text,
  lease_expires_at timestamptz,
  expected_amount_minor integer not null check (expected_amount_minor > 0),
  expected_currency text not null check (expected_currency = 'GBP'),
  expected_destination_account_id text not null,
  expected_idempotency_key text not null,
  expected_metadata jsonb not null,
  lookup_window_gte timestamptz not null,
  lookup_window_lte timestamptz not null,
  lookup_started_at timestamptz,
  lookup_completed_at timestamptz,
  lookup_outcome text check (lookup_outcome in
    ('found_matching', 'not_found', 'found_mismatch', 'ambiguous', 'lookup_failed')),
  provider_transfer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, earning_id)
);
-- Only ONE active provider execution per earning — across ALL runs.
create unique index if not exists stej_one_active_per_earning
  on public.scoped_transfer_execution_jobs (earning_id)
  where state in ('provider_lookup_pending', 'lookup_recorded', 'provider_create_pending', 'provider_outcome_unknown');
create index if not exists stej_run_idx on public.scoped_transfer_execution_jobs (run_id);
alter table public.scoped_transfer_execution_jobs enable row level security;
alter table public.scoped_transfer_execution_jobs force row level security;   -- definer-only; no policies

-- ============================================================
-- 3. ADDITIVE vocabularies (supersets).
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
    'released', 'already_payable', 'not_found', 'not_yet_eligible', 'issue_held',
    'evidence_held', 'reversed', 'transfer_already_started', 'invalid_state', 'failed',
    'renewed_credit_covered', 'renewal_prepared', 'closed_zero_occurrences',
    'already_renewed', 'action_required_existing', 'payment_failed_existing',
    'plan_not_active', 'plan_paused', 'plan_ended', 'billing_not_enabled', 'not_recurring',
    'eligible_provider_action_required', 'provider_lookup_required', 'already_processing',
    'already_transferred', 'not_payable', 'held_for_issue', 'connect_not_ready',
    'zero_amount', 'retryable_failure', 'permanent_failure',
    -- Stage 3C2-C2 provider execution
    'provider_transfer_found_and_finalized', 'provider_transfer_created_and_finalized',
    'provider_lookup_failed', 'provider_lookup_ambiguous', 'provider_transfer_mismatch',
    'provider_outcome_uncertain', 'reconciliation_required', 'failed_permanent'));

alter table public.financial_operation_run_events
  drop constraint if exists financial_operation_run_events_action_check;
alter table public.financial_operation_run_events
  add constraint financial_operation_run_events_action_check check (action in (
    'requested', 'preview_generated', 'confirmation_requested', 'execution_started',
    'record_claimed', 'record_skipped', 'record_succeeded', 'record_failed',
    'cancelled', 'expired', 'control_blocked',
    'item_released', 'item_skipped', 'item_failed',
    'item_renewed', 'item_prepared', 'item_provider_lookup_required', 'item_review_required',
    'item_finalized', 'item_uncertain', 'item_reconciliation_required',
    'provider_execution_authorized', 'provider_lookup_recorded', 'provider_create_authorized',
    'execution_succeeded', 'execution_partially_succeeded', 'execution_failed'));

-- ============================================================
-- 4. INTERNAL HELPERS (no grants at all — callable only from these definers).
-- ============================================================
create or replace function app_private.stej_lease_hash(p_token text)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_token, 'utf8')), 'hex');
$$;
revoke all on function app_private.stej_lease_hash(text) from public, anon, authenticated, service_role;

-- Verify the provider-transfer json against a job's immutable snapshot. Typed
-- field checks only; livemode must match the environment (hosted/test => false).
create or replace function app_private.stej_provider_matches(j public.scoped_transfer_execution_jobs, p jsonb)
returns boolean language plpgsql stable set search_path = '' as $$
declare v_env text;
begin
  v_env := app_private.current_financial_environment();
  return coalesce((p->>'amount')::integer, -1) = j.expected_amount_minor
     and lower(coalesce(p->>'currency', '')) = lower(j.expected_currency)
     and coalesce(p->>'destination', '') = j.expected_destination_account_id
     and coalesce(p->'metadata'->>'earning_id', '') = coalesce(j.expected_metadata->>'earning_id', '')
     and coalesce(p->'metadata'->>'transfer_attempt_id', '') = coalesce(j.expected_metadata->>'transfer_attempt_id', '')
     and coalesce((p->>'livemode')::boolean, true) = (v_env = 'production_live')
     and coalesce(p->>'id', '') <> '';
end;
$$;
revoke all on function app_private.stej_provider_matches(public.scoped_transfer_execution_jobs, jsonb) from public, anon, authenticated, service_role;

-- Upsert the durable per-earning item across saga stages (definer-managed).
create or replace function app_private.stej_write_item(
  p_run_id uuid, p_earning_id uuid, p_outcome text, p_reason text, p_details jsonb)
returns void language plpgsql set search_path = '' as $$
declare v_before text; v_ord int;
begin
  select e.state || '/' || e.transfer_state into v_before from public.companion_earnings e where e.id = p_earning_id;
  select coalesce(max(ordinal), 0) + 1 into v_ord from public.financial_operation_run_items where run_id = p_run_id;
  insert into public.financial_operation_run_items
    (run_id, operation_type, record_id, ordinal, outcome, reason_code, before_state, after_state, attempted_at, completed_at, safe_details)
  values (p_run_id, 'transfer_finalise', p_earning_id, v_ord, p_outcome, p_reason, v_before, v_before, now(), now(), coalesce(p_details, '{}'::jsonb))
  on conflict (run_id, record_id) do update set
    outcome = excluded.outcome, reason_code = excluded.reason_code,
    after_state = excluded.after_state, completed_at = now(),
    safe_details = excluded.safe_details, updated_at = now();
end;
$$;
revoke all on function app_private.stej_write_item(uuid, uuid, text, text, jsonb) from public, anon, authenticated, service_role;

-- ============================================================
-- 5. BEGIN RUN — validates the single-use support credential (confirmation
--    token), run, control, environment, batch ≤5 and the aggregate ceiling.
--    Returns the deduplicated explicit scope. Idempotent re-entry while executing.
-- ============================================================
create or replace function app_private.begin_scoped_provider_transfer_run(p_run_id uuid, p_confirmation_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.financial_operation_runs; v_env text; v_ctrl text;
  v_ids uuid[]; v_total bigint; v_ceiling integer;
begin
  select * into v_run from public.financial_operation_runs where id = p_run_id for update;
  if v_run.id is null then raise exception 'not_found: run'; end if;
  if v_run.operation_type <> 'transfer_finalise' then raise exception 'operation_mismatch: % is not transfer_finalise', v_run.operation_type; end if;
  if v_run.confirmation_token is distinct from p_confirmation_token then raise exception 'invalid_token: confirmation token mismatch'; end if;
  if v_run.state = 'cancelled' then raise exception 'run_cancelled'; end if;
  if v_run.state in ('completed', 'failed') or v_run.executed_at is not null then
    return coalesce(v_run.result_summary, '{}'::jsonb) || jsonb_build_object('ok', true, 'already_executed', true, 'run_id', p_run_id);
  end if;
  if v_run.expires_at <= now() then
    update public.financial_operation_runs set state = 'expired' where id = p_run_id;
    raise exception 'run_expired';
  end if;
  if v_run.state not in ('confirmed', 'executing') then raise exception 'confirmation_required: confirm the run before executing'; end if;
  if v_run.scope_type <> 'record_ids' then raise exception 'scope_required: explicit record ids required'; end if;
  if array_length(v_run.scoped_ids, 1) is null then raise exception 'empty_scope'; end if;

  select array_agg(id order by first_pos) into v_ids
    from (select u.id, min(u.pos) as first_pos
            from unnest(v_run.scoped_ids) with ordinality as u(id, pos)
           group by u.id) d;
  -- PROVIDER batch cap: 5 (stricter than the generic 25).
  if array_length(v_ids, 1) > 5 then raise exception 'batch_limit_exceeded: provider execution allows at most 5 records'; end if;

  v_env := app_private.current_financial_environment();
  v_ctrl := app_private.effective_control_state('transfer_finalise');
  if v_env = 'production_live' then
    if v_ctrl <> 'enabled' then raise exception 'control_disabled: transfer_finalise is not enabled'; end if;
    if app_private.effective_control_state('production_live_operations') <> 'enabled' then
      raise exception 'production_live_locked';
    end if;
  else
    if v_ctrl <> 'scoped_execution' then raise exception 'control_disabled: transfer_finalise is not executable'; end if;
  end if;

  -- Aggregate amount ceiling: 0 (the default) BLOCKS all provider execution.
  select provider_transfer_amount_ceiling_minor into v_ceiling from public.financial_operations_config where id = true;
  select coalesce(sum(e.net_minor), 0) into v_total from public.companion_earnings e where e.id = any(v_ids);
  if v_ceiling <= 0 then raise exception 'amount_ceiling_unconfigured: provider execution is blocked until a ceiling is configured'; end if;
  if v_total > v_ceiling then raise exception 'amount_ceiling_exceeded: run total % exceeds the configured ceiling %', v_total, v_ceiling; end if;

  update public.financial_operation_runs set state = 'executing', started_at = coalesce(started_at, now()) where id = p_run_id;
  if not exists (select 1 from public.financial_operation_run_events ev where ev.run_id = p_run_id and ev.action = 'execution_started') then
    insert into public.financial_operation_run_events (run_id, action, actor_account_id) values (p_run_id, 'execution_started', auth.uid());
  end if;
  return jsonb_build_object('ok', true, 'run_id', p_run_id, 'earning_ids', to_jsonb(v_ids),
    'total_amount_minor', v_total, 'environment', v_env);
end;
$$;
revoke all on function app_private.begin_scoped_provider_transfer_run(uuid, text) from public, anon, authenticated;
grant execute on function app_private.begin_scoped_provider_transfer_run(uuid, text) to service_role;

-- ============================================================
-- 6. BEGIN ITEM — locks + reclassifies ONE explicit in-scope earning, leases
--    exactly one local attempt where safe, and issues a hashed single-use lease
--    with the immutable expected snapshot. Never calls a provider.
-- ============================================================
create or replace function app_private.begin_scoped_provider_transfer_item(p_run_id uuid, p_confirmation_token text, p_earning_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.financial_operation_runs; v_env text; v_ctrl text;
  e public.companion_earnings; ta public.companion_transfer_attempts;
  v_cls jsonb; v_outcome text; v_job public.scoped_transfer_execution_jobs;
  v_token text; v_dest text; v_mode text;
begin
  select * into v_run from public.financial_operation_runs where id = p_run_id for update;
  if v_run.id is null or v_run.operation_type <> 'transfer_finalise' then raise exception 'not_found: run'; end if;
  if v_run.confirmation_token is distinct from p_confirmation_token then raise exception 'invalid_token'; end if;
  if v_run.state <> 'executing' then raise exception 'run_not_executing: begin the run first'; end if;
  if v_run.expires_at <= now() then raise exception 'run_expired'; end if;
  -- SCOPE BINDING: the earning MUST be a member of this run's explicit scope.
  if not (p_earning_id = any(v_run.scoped_ids)) then raise exception 'out_of_scope: earning is not in the approved run scope'; end if;
  v_env := app_private.current_financial_environment();
  v_ctrl := app_private.effective_control_state('transfer_finalise');
  if v_env = 'production_live' then
    if v_ctrl <> 'enabled' or app_private.effective_control_state('production_live_operations') <> 'enabled' then
      raise exception 'control_disabled';
    end if;
  elsif v_ctrl <> 'scoped_execution' then raise exception 'control_disabled';
  end if;

  -- Existing job for (run, earning): durable re-entry semantics.
  select * into v_job from public.scoped_transfer_execution_jobs
   where run_id = p_run_id and earning_id = p_earning_id for update;
  if v_job.id is not null then
    if v_job.state in ('finalized_success', 'reconciliation_required', 'closed_rejected', 'provider_outcome_unknown') then
      return jsonb_build_object('proceed', false, 'outcome', 'job_' || v_job.state, 'job_id', v_job.id);
    end if;
    if v_job.lease_expires_at > now() then
      raise exception 'lease_active: another execution holds this job lease';
    end if;
    -- Expired lease NEVER authorises creation: reset to the lookup stage with a
    -- fresh single-use lease (forcing a fresh provider lookup).
    v_token := gen_random_uuid()::text || gen_random_uuid()::text;
    update public.scoped_transfer_execution_jobs
       set state = 'provider_lookup_pending', lease_token_hash = app_private.stej_lease_hash(v_token),
           lease_expires_at = now() + interval '10 minutes', lookup_outcome = null,
           lookup_started_at = now(), lookup_completed_at = null, updated_at = now()
     where id = v_job.id
    returning * into v_job;
    return jsonb_build_object('proceed', true, 'mode', 'lookup_path', 'job_id', v_job.id, 'lease_token', v_token,
      'snapshot', app_private.stej_snapshot(v_job));
  end if;

  -- Lock + reclassify the earning under the lock (shared classifier).
  select * into e from public.companion_earnings where id = p_earning_id for update;
  v_cls := app_private.classify_scoped_transfer(p_earning_id, now());
  v_outcome := v_cls->>'outcome';

  if v_outcome in ('not_found', 'already_transferred', 'reversed', 'permanent_failure', 'held_for_issue',
                   'evidence_held', 'not_payable', 'zero_amount', 'connect_not_ready', 'invalid_state') then
    perform app_private.stej_write_item(p_run_id, p_earning_id,
      case v_outcome when 'permanent_failure' then 'failed_permanent' else v_outcome end,
      v_cls->>'reason_code', jsonb_build_object('provider_lookup_required', false));
    insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id, detail)
    values (p_run_id, 'item_skipped', p_earning_id, auth.uid(), jsonb_build_object('outcome', v_outcome));
    return jsonb_build_object('proceed', false, 'outcome', v_outcome);
  end if;

  select * into ta from public.companion_transfer_attempts where earning_id = p_earning_id;

  if v_outcome in ('eligible_provider_action_required', 'retryable_failure') then
    v_mode := 'lookup_path';
    -- LEASE exactly one local attempt (claim-equivalent for this ONE earning):
    -- 'processing' excludes it from the global claim; the scoped-job guard below
    -- excludes it from stale recovery while the saga is active.
    select ca.stripe_account_id into v_dest from public.connected_accounts ca where ca.account_id = e.companion_account_id;
    insert into public.companion_transfer_attempts
      (earning_id, companion_account_id, companion_profile_id, connected_account_id,
       amount_minor, currency, state, attempt_count, idempotency_key, claimed_at)
    values (p_earning_id, e.companion_account_id, e.companion_profile_id, v_dest,
            e.net_minor, 'GBP', 'processing', 1, 'transfer-' || p_earning_id::text, now())
    on conflict (earning_id) do update set
      state = 'processing', attempt_count = public.companion_transfer_attempts.attempt_count + 1,
      connected_account_id = excluded.connected_account_id, amount_minor = excluded.amount_minor,
      failure_code = null, failure_message = null, claimed_at = now(), updated_at = now()
    returning * into ta;
    update public.companion_earnings set transfer_state = 'processing', updated_at = now() where id = p_earning_id;
  elsif v_outcome = 'provider_lookup_required' then
    v_mode := 'lookup_path';        -- processing without provider id: lookup only
  elsif v_outcome = 'already_processing' then
    v_mode := 'verify_path';        -- provider id known: retrieve + verify, never create
  else
    raise exception 'invalid_state: unexpected classification %', v_outcome;
  end if;

  v_token := gen_random_uuid()::text || gen_random_uuid()::text;
  insert into public.scoped_transfer_execution_jobs
    (run_id, earning_id, transfer_attempt_id, state, lease_token_hash, lease_expires_at,
     expected_amount_minor, expected_currency, expected_destination_account_id,
     expected_idempotency_key, expected_metadata, lookup_window_gte, lookup_window_lte, lookup_started_at)
  values (p_run_id, p_earning_id, ta.id, 'provider_lookup_pending',
          app_private.stej_lease_hash(v_token), now() + interval '10 minutes',
          ta.amount_minor, 'GBP', ta.connected_account_id, ta.idempotency_key,
          jsonb_build_object('earning_id', p_earning_id::text, 'booking_id', e.booking_id::text,
                             'companion_account_id', e.companion_account_id::text,
                             'companion_profile_id', e.companion_profile_id::text,
                             'transfer_attempt_id', ta.id::text),
          coalesce(ta.created_at, now()) - interval '1 hour', now() + interval '5 minutes', now())
  returning * into v_job;

  insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id, detail)
  values (p_run_id, 'record_claimed', p_earning_id, auth.uid(),
          jsonb_build_object('mode', v_mode, 'job_id', v_job.id));
  return jsonb_build_object('proceed', true, 'mode', v_mode, 'job_id', v_job.id, 'lease_token', v_token,
    'snapshot', app_private.stej_snapshot(v_job)
      || case when v_mode = 'verify_path' then jsonb_build_object('provider_transfer_id', ta.stripe_transfer_id) else '{}'::jsonb end);
end;
$$;
revoke all on function app_private.begin_scoped_provider_transfer_item(uuid, text, uuid) from public, anon, authenticated;
grant execute on function app_private.begin_scoped_provider_transfer_item(uuid, text, uuid) to service_role;

-- Immutable snapshot view of a job (support-only surfaces never see key/destination).
create or replace function app_private.stej_snapshot(j public.scoped_transfer_execution_jobs)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'amount_minor', j.expected_amount_minor, 'currency', j.expected_currency,
    'destination_account_id', j.expected_destination_account_id,
    'idempotency_key', j.expected_idempotency_key, 'metadata', j.expected_metadata,
    'lookup_window_gte', extract(epoch from j.lookup_window_gte)::bigint,
    'lookup_window_lte', extract(epoch from j.lookup_window_lte)::bigint);
$$;
revoke all on function app_private.stej_snapshot(public.scoped_transfer_execution_jobs) from public, anon, authenticated, service_role;

-- ============================================================
-- 7. RECORD LOOKUP — persists the immediate provider-lookup result. An exact
--    match finalises the EXISTING transfer (no create); mismatch/ambiguity/
--    failure become reconciliation_required; ONLY not_found may later authorise.
-- ============================================================
create or replace function app_private.record_scoped_transfer_lookup(
  p_job_id uuid, p_lease_token text, p_outcome text, p_provider jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job public.scoped_transfer_execution_jobs; v_verified boolean;
begin
  if p_outcome not in ('found_matching', 'not_found', 'found_mismatch', 'ambiguous', 'lookup_failed') then
    raise exception 'invalid_outcome';
  end if;
  select * into v_job from public.scoped_transfer_execution_jobs where id = p_job_id for update;
  if v_job.id is null then raise exception 'not_found: job'; end if;
  if v_job.lease_token_hash is distinct from app_private.stej_lease_hash(p_lease_token) then raise exception 'invalid_lease'; end if;
  if v_job.lease_expires_at <= now() then raise exception 'lease_expired'; end if;
  if v_job.state <> 'provider_lookup_pending' then raise exception 'invalid_job_state: %', v_job.state; end if;

  if p_outcome = 'found_matching' then
    v_verified := app_private.stej_provider_matches(v_job, p_provider);
    if not v_verified then
      update public.scoped_transfer_execution_jobs
         set state = 'reconciliation_required', lookup_outcome = 'found_mismatch', lookup_completed_at = now(), updated_at = now()
       where id = p_job_id;
      perform app_private.stej_write_item(v_job.run_id, v_job.earning_id, 'provider_transfer_mismatch',
        'lookup_result_failed_verification', jsonb_build_object('reconciliation_required', true));
      insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id, detail)
      values (v_job.run_id, 'item_reconciliation_required', v_job.earning_id, auth.uid(), jsonb_build_object('why', 'mismatch'));
      return jsonb_build_object('final', true, 'outcome', 'provider_transfer_mismatch');
    end if;
    -- Exact existing match: settle through the EXISTING idempotent authority.
    perform public.finalize_transfer_succeeded(v_job.transfer_attempt_id, p_provider->>'id', (p_provider->>'created')::bigint);
    update public.scoped_transfer_execution_jobs
       set state = 'finalized_success', lookup_outcome = 'found_matching', provider_transfer_id = p_provider->>'id',
           lookup_completed_at = now(), updated_at = now()
     where id = p_job_id;
    perform app_private.stej_write_item(v_job.run_id, v_job.earning_id, 'provider_transfer_found_and_finalized',
      'existing_provider_transfer_verified', jsonb_build_object('provider_id_present', true,
        'livemode', coalesce((p_provider->>'livemode')::boolean, false)));
    insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id, detail)
    values (v_job.run_id, 'item_finalized', v_job.earning_id, auth.uid(), jsonb_build_object('via', 'lookup_match'));
    return jsonb_build_object('final', true, 'outcome', 'provider_transfer_found_and_finalized');
  end if;

  if p_outcome = 'not_found' then
    update public.scoped_transfer_execution_jobs
       set state = 'lookup_recorded', lookup_outcome = 'not_found', lookup_completed_at = now(), updated_at = now()
     where id = p_job_id;
    insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id, detail)
    values (v_job.run_id, 'provider_lookup_recorded', v_job.earning_id, auth.uid(), jsonb_build_object('outcome', 'not_found'));
    -- NOT durable permission: only authorize_scoped_transfer_create (freshness-
    -- checked) inside THIS saga invocation may proceed toward creation.
    return jsonb_build_object('final', false, 'may_authorize', true);
  end if;

  update public.scoped_transfer_execution_jobs
     set state = 'reconciliation_required', lookup_outcome = p_outcome, lookup_completed_at = now(), updated_at = now()
   where id = p_job_id;
  perform app_private.stej_write_item(v_job.run_id, v_job.earning_id,
    case p_outcome when 'ambiguous' then 'provider_lookup_ambiguous'
                   when 'found_mismatch' then 'provider_transfer_mismatch'
                   else 'provider_lookup_failed' end,
    'lookup_' || p_outcome, jsonb_build_object('reconciliation_required', true));
  insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id, detail)
  values (v_job.run_id, 'item_reconciliation_required', v_job.earning_id, auth.uid(), jsonb_build_object('why', p_outcome));
  return jsonb_build_object('final', true, 'outcome', 'reconciliation_required');
end;
$$;
revoke all on function app_private.record_scoped_transfer_lookup(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function app_private.record_scoped_transfer_lookup(uuid, text, text, jsonb) to service_role;

-- ============================================================
-- 8. AUTHORIZE CREATE — the LAST database gate immediately before the POST.
--    Requires a live lease, a FRESH not_found lookup (≤2 minutes old), a still-
--    executing run, a still-permissive control and a still-leased local attempt
--    with no provider id. Returns the exact immutable snapshot.
-- ============================================================
create or replace function app_private.authorize_scoped_transfer_create(p_job_id uuid, p_lease_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job public.scoped_transfer_execution_jobs; v_run public.financial_operation_runs;
        ta public.companion_transfer_attempts; v_env text; v_ctrl text;
begin
  select * into v_job from public.scoped_transfer_execution_jobs where id = p_job_id for update;
  if v_job.id is null then raise exception 'not_found: job'; end if;
  if v_job.lease_token_hash is distinct from app_private.stej_lease_hash(p_lease_token) then raise exception 'invalid_lease'; end if;
  if v_job.lease_expires_at <= now() then raise exception 'lease_expired'; end if;
  if v_job.state <> 'lookup_recorded' or v_job.lookup_outcome <> 'not_found' then
    raise exception 'lookup_required: a fresh not-found lookup must precede creation';
  end if;
  if v_job.lookup_completed_at is null or v_job.lookup_completed_at <= now() - interval '2 minutes' then
    raise exception 'lookup_stale: repeat the provider lookup immediately before creation';
  end if;
  select * into v_run from public.financial_operation_runs where id = v_job.run_id;
  if v_run.state <> 'executing' or v_run.expires_at <= now() then raise exception 'run_not_executing'; end if;
  v_env := app_private.current_financial_environment();
  v_ctrl := app_private.effective_control_state('transfer_finalise');
  if v_env = 'production_live' then
    if v_ctrl <> 'enabled' or app_private.effective_control_state('production_live_operations') <> 'enabled' then
      raise exception 'control_disabled';
    end if;
  elsif v_ctrl <> 'scoped_execution' then raise exception 'control_disabled';
  end if;
  select * into ta from public.companion_transfer_attempts where id = v_job.transfer_attempt_id for update;
  if ta.id is null or ta.state <> 'processing' or ta.stripe_transfer_id is not null then
    raise exception 'attempt_state_changed: creation is no longer safe';
  end if;
  update public.scoped_transfer_execution_jobs set state = 'provider_create_pending', updated_at = now() where id = p_job_id;
  if not exists (select 1 from public.financial_operation_run_events ev
                 where ev.run_id = v_job.run_id and ev.action = 'provider_create_authorized' and ev.record_id = v_job.earning_id) then
    insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id)
    values (v_job.run_id, 'provider_create_authorized', v_job.earning_id, auth.uid());
  end if;
  return jsonb_build_object('ok', true, 'job_id', p_job_id) || app_private.stej_snapshot(v_job);
end;
$$;
revoke all on function app_private.authorize_scoped_transfer_create(uuid, text) from public, anon, authenticated;
grant execute on function app_private.authorize_scoped_transfer_create(uuid, text) to service_role;

-- ============================================================
-- 9. FINALISERS — success (verified against the snapshot; idempotent with the
--    webhook), uncertain (never retryable, never an immediate second create) and
--    definitive rejection (audited retryable/permanent classification).
-- ============================================================
create or replace function app_private.finalize_scoped_transfer_success(p_job_id uuid, p_lease_token text, p_provider jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job public.scoped_transfer_execution_jobs; v_outcome text;
begin
  select * into v_job from public.scoped_transfer_execution_jobs where id = p_job_id for update;
  if v_job.id is null then raise exception 'not_found: job'; end if;
  if v_job.lease_token_hash is distinct from app_private.stej_lease_hash(p_lease_token) then raise exception 'invalid_lease'; end if;
  if v_job.state = 'finalized_success' then
    return jsonb_build_object('ok', true, 'already_finalized', true, 'outcome', 'finalized_success');   -- idempotent (webhook race)
  end if;
  if v_job.state not in ('provider_create_pending', 'provider_outcome_unknown', 'reconciliation_required') then
    raise exception 'invalid_job_state: %', v_job.state;
  end if;
  if not app_private.stej_provider_matches(v_job, p_provider) then
    update public.scoped_transfer_execution_jobs set state = 'reconciliation_required', updated_at = now() where id = p_job_id;
    perform app_private.stej_write_item(v_job.run_id, v_job.earning_id, 'provider_transfer_mismatch',
      'created_transfer_failed_verification', jsonb_build_object('reconciliation_required', true));
    return jsonb_build_object('ok', false, 'outcome', 'provider_transfer_mismatch');
  end if;
  perform public.finalize_transfer_succeeded(v_job.transfer_attempt_id, p_provider->>'id', (p_provider->>'created')::bigint);
  v_outcome := case when v_job.state = 'provider_create_pending'
                    then 'provider_transfer_created_and_finalized'
                    else 'provider_transfer_found_and_finalized' end;
  update public.scoped_transfer_execution_jobs
     set state = 'finalized_success', provider_transfer_id = p_provider->>'id', updated_at = now()
   where id = p_job_id;
  perform app_private.stej_write_item(v_job.run_id, v_job.earning_id, v_outcome, 'provider_transfer_settled',
    jsonb_build_object('provider_id_present', true, 'livemode', coalesce((p_provider->>'livemode')::boolean, false)));
  if not exists (select 1 from public.financial_operation_run_events ev
                 where ev.run_id = v_job.run_id and ev.action = 'item_finalized' and ev.record_id = v_job.earning_id) then
    insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id, detail)
    values (v_job.run_id, 'item_finalized', v_job.earning_id, auth.uid(), jsonb_build_object('outcome', v_outcome));
  end if;
  return jsonb_build_object('ok', true, 'outcome', v_outcome);
end;
$$;
revoke all on function app_private.finalize_scoped_transfer_success(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function app_private.finalize_scoped_transfer_success(uuid, text, jsonb) to service_role;

create or replace function app_private.finalize_scoped_transfer_uncertain(p_job_id uuid, p_lease_token text, p_reason_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job public.scoped_transfer_execution_jobs; v_state text;
begin
  select * into v_job from public.scoped_transfer_execution_jobs where id = p_job_id for update;
  if v_job.id is null then raise exception 'not_found: job'; end if;
  if v_job.lease_token_hash is distinct from app_private.stej_lease_hash(p_lease_token) then raise exception 'invalid_lease'; end if;
  if v_job.state in ('finalized_success', 'closed_rejected') then
    return jsonb_build_object('ok', true, 'already_terminal', true, 'state', v_job.state);
  end if;
  -- Timeout AFTER the POST may have executed => outcome unknown; everything else
  -- (pre-POST interruptions with the create window open) => reconciliation.
  v_state := case when p_reason_code like 'timeout_after%' then 'provider_outcome_unknown' else 'reconciliation_required' end;
  update public.scoped_transfer_execution_jobs set state = v_state, updated_at = now() where id = p_job_id;
  -- The attempt stays 'processing' — NEVER rearmed to retryable by uncertainty.
  perform app_private.stej_write_item(v_job.run_id, v_job.earning_id,
    case v_state when 'provider_outcome_unknown' then 'provider_outcome_uncertain' else 'reconciliation_required' end,
    p_reason_code, jsonb_build_object('reconciliation_required', true));
  insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id, detail)
  values (v_job.run_id, 'item_uncertain', v_job.earning_id, auth.uid(), jsonb_build_object('reason', p_reason_code));
  return jsonb_build_object('ok', true, 'state', v_state);
end;
$$;
revoke all on function app_private.finalize_scoped_transfer_uncertain(uuid, text, text) from public, anon, authenticated;
grant execute on function app_private.finalize_scoped_transfer_uncertain(uuid, text, text) to service_role;

create or replace function app_private.finalize_scoped_transfer_rejected(p_job_id uuid, p_lease_token text, p_code text, p_permanent boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job public.scoped_transfer_execution_jobs;
begin
  select * into v_job from public.scoped_transfer_execution_jobs where id = p_job_id for update;
  if v_job.id is null then raise exception 'not_found: job'; end if;
  if v_job.lease_token_hash is distinct from app_private.stej_lease_hash(p_lease_token) then raise exception 'invalid_lease'; end if;
  if v_job.state <> 'provider_create_pending' then raise exception 'invalid_job_state: %', v_job.state; end if;
  if p_permanent then
    perform public.finalize_transfer_failed_permanent(v_job.transfer_attempt_id, p_code, 'Transfer rejected by the payment provider.');
  else
    perform public.finalize_transfer_failed_retryable(v_job.transfer_attempt_id, p_code, 'Temporary transfer error; retry via a new scoped run.');
  end if;
  update public.scoped_transfer_execution_jobs set state = 'closed_rejected', updated_at = now() where id = p_job_id;
  perform app_private.stej_write_item(v_job.run_id, v_job.earning_id,
    case when p_permanent then 'failed_permanent' else 'failed' end,
    'provider_' || p_code, jsonb_build_object('provider_id_present', false));
  insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id, detail)
  values (v_job.run_id, 'item_failed', v_job.earning_id, auth.uid(), jsonb_build_object('code', p_code, 'permanent', p_permanent));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function app_private.finalize_scoped_transfer_rejected(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function app_private.finalize_scoped_transfer_rejected(uuid, text, text, boolean) to service_role;

-- ============================================================
-- 10. COMPLETE RUN — aggregates the durable items into the run result. Idempotent.
-- ============================================================
create or replace function app_private.complete_scoped_provider_transfer_run(p_run_id uuid, p_confirmation_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.financial_operation_runs;
  v_final int; v_recon int; v_fail int; v_skip int; v_total int; v_state text; v_action text;
begin
  select * into v_run from public.financial_operation_runs where id = p_run_id for update;
  if v_run.id is null or v_run.operation_type <> 'transfer_finalise' then raise exception 'not_found: run'; end if;
  if v_run.confirmation_token is distinct from p_confirmation_token then raise exception 'invalid_token'; end if;
  if v_run.state in ('completed', 'failed') then
    return coalesce(v_run.result_summary, '{}'::jsonb) || jsonb_build_object('ok', true, 'already_completed', true);
  end if;
  if v_run.state <> 'executing' then raise exception 'run_not_executing'; end if;
  select count(*) filter (where outcome in ('provider_transfer_found_and_finalized', 'provider_transfer_created_and_finalized')),
         count(*) filter (where outcome in ('provider_transfer_mismatch', 'provider_lookup_ambiguous',
                                            'provider_lookup_failed', 'provider_outcome_uncertain', 'reconciliation_required')),
         count(*) filter (where outcome in ('failed', 'failed_permanent')),
         count(*)
    into v_final, v_recon, v_fail, v_total
    from public.financial_operation_run_items where run_id = p_run_id;
  v_skip := v_total - v_final - v_recon - v_fail;
  v_state := case when v_total > 0 and v_final = 0 and v_recon = 0 and v_fail = v_total then 'failed' else 'completed' end;
  v_action := case when v_state = 'failed' then 'execution_failed'
                   when v_recon > 0 or v_fail > 0 or v_skip > 0 then 'execution_partially_succeeded'
                   else 'execution_succeeded' end;
  update public.financial_operation_runs
     set state = v_state, executed_at = now(), completed_at = now(),
         rows_examined = v_total, rows_eligible = v_final, rows_claimed = v_final,
         rows_succeeded = v_final, rows_failed = v_fail,
         result_summary = jsonb_build_object('executed_at', now(), 'finalized_count', v_final,
           'reconciliation_count', v_recon, 'failed_count', v_fail, 'skipped_count', v_skip, 'requested_count', v_total)
   where id = p_run_id;
  if not exists (select 1 from public.financial_operation_run_events ev
                 where ev.run_id = p_run_id and ev.action in ('execution_succeeded', 'execution_partially_succeeded', 'execution_failed')) then
    insert into public.financial_operation_run_events (run_id, action, actor_account_id, detail)
    values (p_run_id, v_action, auth.uid(),
            jsonb_build_object('finalized', v_final, 'reconciliation', v_recon, 'failed', v_fail, 'skipped', v_skip));
  end if;
  return jsonb_build_object('ok', v_state = 'completed', 'state', v_state, 'finalized_count', v_final,
    'reconciliation_count', v_recon, 'failed_count', v_fail, 'skipped_count', v_skip, 'requested_count', v_total);
end;
$$;
revoke all on function app_private.complete_scoped_provider_transfer_run(uuid, text) from public, anon, authenticated;
grant execute on function app_private.complete_scoped_provider_transfer_run(uuid, text) to service_role;

-- ============================================================
-- 11. STALE RECOVERY — additive redefinition: identical legacy behaviour EXCEPT
--     attempts held by an ACTIVE scoped job are skipped (the saga owns them; a
--     stale scoped job must be resolved by lookup, never by rearming retry).
-- ============================================================
create or replace function public.recover_stale_transfers(p_minutes integer default 30)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare v_count integer;
begin
  with stale as (
    update public.companion_transfer_attempts ta
       set state = 'failed_retryable',
           failure_code = 'stale_claim',
           failure_message = 'Worker did not finalise in time; safe to retry.',
           updated_at = now()
     where ta.state = 'processing'
       and ta.stripe_transfer_id is null
       and ta.claimed_at < now() - make_interval(mins => greatest(p_minutes, 1))
       and not exists (select 1 from public.scoped_transfer_execution_jobs j
                       where j.transfer_attempt_id = ta.id
                         and j.state in ('provider_lookup_pending', 'lookup_recorded',
                                         'provider_create_pending', 'provider_outcome_unknown',
                                         'reconciliation_required'))
    returning ta.earning_id
  )
  update public.companion_earnings e set transfer_state = 'failed', updated_at = now()
    from stale where e.id = stale.earning_id and e.transfer_state = 'processing';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.recover_stale_transfers(integer) from public, anon, authenticated;
grant execute on function public.recover_stale_transfers(integer) to service_role;

-- ============================================================
-- 12. SUPPORT EXECUTE WRAPPER — from the EXACT applied 0077 body; the ONLY change
--     is the transfer_finalise branch, which AUTHORISES the Edge saga with a
--     structured result (SQL can never perform the provider work itself).
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
  -- Stage 3C2-C1: transfer REVIEW (database-read-only; unchanged).
  if v_control = 'transfer_claim' then
    perform app_private.begin_scoped_operation_execution(p_run_id, 'transfer_claim');
    return app_private.execute_scoped_transfer_preparation(p_run_id);
  end if;
  -- Stage 3C2-C2: transfer_finalise = PROVIDER execution. SQL cannot hold a
  -- transaction across a Stripe request, so execution is delegated to the scoped
  -- Edge saga; this branch only AUTHORISES it with a structured, non-throwing
  -- result. The saga revalidates everything server-side via the lease RPCs.
  if v_control = 'transfer_finalise' then
    if not exists (select 1 from public.financial_operation_run_events e
                   where e.run_id = p_run_id and e.action = 'provider_execution_authorized') then
      insert into public.financial_operation_run_events (run_id, action, actor_account_id)
        values (p_run_id, 'provider_execution_authorized', auth.uid());
    end if;
    return jsonb_build_object('ok', true, 'executed', false, 'code', 'provider_execution_required',
      'control', v_control, 'endpoint', 'scoped-stripe-transfers', 'max_batch', 5);
  end if;
  raise exception 'stage_not_enabled: % execution is deferred to a later stage', v_control;
end;
$$;
revoke all on function public.support_execute_operation_run(uuid, text) from public, anon;
grant execute on function public.support_execute_operation_run(uuid, text) to authenticated;

-- ============================================================
-- 13. SUPPORT PREVIEW — from the EXACT applied 0077 body; the ONLY change is that
--     transfer_finalise previews through the SAME shared transfer classifier.
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
  elsif v_run.operation_type in ('transfer_claim', 'transfer_finalise') then
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
-- 14. PostgREST schema reload.
-- ============================================================
select pg_notify('pgrst', 'reload schema');
