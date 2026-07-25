-- ============================================================================
-- 0084 — Stage 3E-B: transfer rollout-control hardening (additive).
-- ============================================================================
-- Closes audit gaps G1 and G2 (docs/stage-3e-companion-payout-execution-audit
-- §10). The scoped transfer saga (0077/0078) already enforces: environment
-- gate, per-operation controls, per-transfer ceiling, leases, fresh-lookup
-- and exactly-once identity. This migration adds two fail-closed controls the
-- Stage 3E rollout specification requires and 0078 lacked:
--
--   G1  DAILY AGGREGATE CEILING — provider_transfer_daily_ceiling_minor
--       (default 0 = deny). The sum of all provider-accepted transfer amounts
--       for the current UTC day plus the candidate amount must stay within it.
--   G2  DESTINATION ALLOWLIST — transfer_destination_allowlist. Outside
--       production_live, a transfer may only be authorised toward an
--       explicitly allowlisted connected account (empty list = deny all),
--       so hosted test validation can never touch an unexpected destination.
--       In production_live the allowlist is advisory-off (the production
--       gate remains the 0073 dual-control path).
--
-- Both are enforced inside app_private.authorize_scoped_transfer_create — the
-- single last gate before any provider contact — so NO code path can bypass
-- them (the raw 0048 claim path is already blocked by the 0073 execution-
-- context guard). Purely additive: no existing table/row is altered, no
-- historical data touched, no prior function's semantics weakened.
-- ----------------------------------------------------------------------------

-- 1. Daily aggregate ceiling (single-row config; integer minor units; 0 = deny).
alter table public.financial_operations_config
  add column if not exists provider_transfer_daily_ceiling_minor integer not null default 0
    check (provider_transfer_daily_ceiling_minor >= 0);

comment on column public.financial_operations_config.provider_transfer_daily_ceiling_minor is
  'FINANCIAL INVARIANT: sum of provider-accepted transfer amounts per UTC day '
  'may never exceed this. 0 denies all transfer authorisation. Raised only '
  'deliberately for isolated hosted tests, restored to 0 afterwards.';

-- 2. Destination allowlist (deny-by-default outside production_live).
create table if not exists public.transfer_destination_allowlist (
  stripe_account_id text primary key,
  active boolean not null default true,
  note text not null default '',
  added_by_account_id uuid references public.accounts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.transfer_destination_allowlist enable row level security;
alter table public.transfer_destination_allowlist force row level security;
-- No client policies at all: read/write is service-side or via the guarded
-- support RPCs below. Browsers can never see raw connected-account ids here.

-- Immutable audit of every allowlist change.
create table if not exists public.transfer_destination_allowlist_events (
  id uuid primary key default gen_random_uuid(),
  stripe_account_id text not null,
  action text not null check (action in ('added', 'activated', 'deactivated')),
  reason text not null,
  actor_account_id uuid references public.accounts(id),
  created_at timestamptz not null default now()
);
alter table public.transfer_destination_allowlist_events enable row level security;
alter table public.transfer_destination_allowlist_events force row level security;

-- 3. Support-gated allowlist management (audited; no unrestricted mutation).
create or replace function public.support_set_transfer_destination_allowlist(
  p_stripe_account_id text, p_active boolean, p_reason text
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare v_existing public.transfer_destination_allowlist;
begin
  if not app_private.is_support_admin() then
    raise exception 'forbidden: support authorisation required';
  end if;
  if p_stripe_account_id is null or p_stripe_account_id !~ '^acct_[A-Za-z0-9]+$' then
    raise exception 'invalid_destination: expected a Stripe connected-account id';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason_required';
  end if;

  select * into v_existing from public.transfer_destination_allowlist
   where stripe_account_id = p_stripe_account_id for update;

  if v_existing.stripe_account_id is null then
    insert into public.transfer_destination_allowlist
      (stripe_account_id, active, note, added_by_account_id)
    values (p_stripe_account_id, p_active, trim(p_reason), auth.uid());
    insert into public.transfer_destination_allowlist_events
      (stripe_account_id, action, reason, actor_account_id)
    values (p_stripe_account_id,
            case when p_active then 'added' else 'deactivated' end,
            trim(p_reason), auth.uid());
  else
    update public.transfer_destination_allowlist
       set active = p_active, updated_at = now()
     where stripe_account_id = p_stripe_account_id;
    insert into public.transfer_destination_allowlist_events
      (stripe_account_id, action, reason, actor_account_id)
    values (p_stripe_account_id,
            case when p_active then 'activated' else 'deactivated' end,
            trim(p_reason), auth.uid());
  end if;
  return jsonb_build_object('ok', true, 'stripe_account_id', p_stripe_account_id,
                            'active', p_active);
end;
$$;
revoke all on function public.support_set_transfer_destination_allowlist(text, boolean, text)
  from public, anon;
grant execute on function public.support_set_transfer_destination_allowlist(text, boolean, text)
  to authenticated; -- internally gated by is_support_admin()

create or replace function public.support_list_transfer_destination_allowlist()
returns table (stripe_account_id text, active boolean, note text,
               created_at timestamptz, updated_at timestamptz)
language plpgsql security definer
set search_path = ''
as $$
begin
  if not app_private.is_support_admin() then
    raise exception 'forbidden: support authorisation required';
  end if;
  return query
    select a.stripe_account_id, a.active, a.note, a.created_at, a.updated_at
    from public.transfer_destination_allowlist a
    order by a.created_at desc;
end;
$$;
revoke all on function public.support_list_transfer_destination_allowlist() from public, anon;
grant execute on function public.support_list_transfer_destination_allowlist() to authenticated;

-- 4. Shared guard used by the authorize gate (and testable in isolation).
--    Returns NULL when authorisation may proceed, else a stable denial code.
create or replace function app_private.transfer_rollout_denial(
  p_destination text, p_amount_minor integer
)
returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_cfg public.financial_operations_config;
  v_env text;
  v_today_minor bigint;
begin
  select * into v_cfg from public.financial_operations_config where id = true;
  v_env := app_private.current_financial_environment();

  -- G2 destination allowlist: outside production_live every destination must
  -- be explicitly, actively allowlisted. Empty list therefore denies all.
  if v_env <> 'production_live' then
    if not exists (select 1 from public.transfer_destination_allowlist a
                   where a.stripe_account_id = p_destination and a.active) then
      return 'destination_not_allowlisted';
    end if;
  end if;

  -- G1 daily aggregate ceiling: provider-accepted amounts today (UTC) plus
  -- the candidate must fit. Counts every attempt that holds a provider
  -- transfer id — including uncertain outcomes — because money may have moved.
  select coalesce(sum(t.amount_minor), 0) into v_today_minor
  from public.companion_transfer_attempts t
  where t.stripe_transfer_id is not null
    and t.updated_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  if v_today_minor + p_amount_minor > v_cfg.provider_transfer_daily_ceiling_minor then
    return 'daily_ceiling_exceeded';
  end if;

  return null;
end;
$$;
revoke all on function app_private.transfer_rollout_denial(text, integer) from public, anon, authenticated;

-- 4b. Audit-event vocabulary: add the denial action (same cumulative pattern
--     as 0075/0076/0077/0078).
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
    'provider_create_denied',
    'execution_succeeded', 'execution_partially_succeeded', 'execution_failed'));

-- 5. Enforce inside the single pre-provider gate. This is the 0078 function
--    reproduced byte-for-byte with ONLY the new guard block added (marked).
create or replace function app_private.authorize_scoped_transfer_create(p_job_id uuid, p_lease_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job public.scoped_transfer_execution_jobs; v_run public.financial_operation_runs;
        ta public.companion_transfer_attempts; v_env text; v_ctrl text; v_denial text;
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
  -- ---- 0084 ROLLOUT GUARDS (G1 daily aggregate ceiling, G2 allowlist) ----
  v_denial := app_private.transfer_rollout_denial(ta.connected_account_id, ta.amount_minor);
  if v_denial is not null then
    if not exists (select 1 from public.financial_operation_run_events ev
                   where ev.run_id = v_job.run_id and ev.action = 'provider_create_denied' and ev.record_id = v_job.earning_id) then
      insert into public.financial_operation_run_events (run_id, action, record_id, actor_account_id, detail)
      values (v_job.run_id, 'provider_create_denied', v_job.earning_id, auth.uid(),
              jsonb_build_object('denial', v_denial));
    end if;
    raise exception 'rollout_denied: %', v_denial;
  end if;
  -- -----------------------------------------------------------------------
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
