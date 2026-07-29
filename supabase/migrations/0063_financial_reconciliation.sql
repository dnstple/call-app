-- ============================================================
-- 2G6E-C — financial reconciliation & exception monitoring (migration 0063)
--
-- Additive to the immutable 0056–0062 baseline. This stage DETECTS accounting /
-- operational mismatches across orders, earnings, transfers, refunds, disputes,
-- allocations, settlement adjustments and the webhook ledger, and records durable
-- findings for support to investigate. It NEVER moves money: no payment, refund,
-- transfer, payout or dispute mutation; no Stripe API call; no change to any
-- amount, total, earning, transfer or dispute outcome. It only reads existing
-- internal state + stored provider identifiers and writes findings/runs/audit.
--
-- Provider state: this stage relies on the existing webhook ledger
-- (stripe_webhook_events) and stored Stripe identifiers, which are sufficient for
-- the invariants below — so NO new Edge Function and NO live Stripe call is added.
--
-- Scheduling is DEFERRED: applying this migration does NOT create a cron job. It
-- never touches the operational 2G6E-B dispute-deadline cron. Activation commands
-- are documented at the end.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Additive column: notifications carry a safe finding reference for deep-links.
-- ------------------------------------------------------------
alter table public.notifications
  add column if not exists finding_id uuid;

-- ------------------------------------------------------------
-- 2. Immutable reconciliation-run ledger.
-- ------------------------------------------------------------
create table if not exists public.financial_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  scope text not null default 'full' check (scope in ('full', 'entity')),
  -- scheduled = cron; manual = service dry run; entity = support recheck (has an
  -- actor); test = fixture-scoped service run (excluded from operational readers).
  trigger_type text not null check (trigger_type in ('scheduled', 'manual', 'entity', 'test')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  scanned_count integer not null default 0,
  findings_created integer not null default 0,
  findings_refreshed integer not null default 0,
  findings_cleared integer not null default 0,
  error_count integer not null default 0,
  error_summary text,                            -- safe: no secrets, no payloads
  actor_account_id uuid references public.accounts(id),
  created_at timestamptz not null default now(),
  -- A batch (scheduled/manual/test service) run has no human actor; a
  -- support-triggered 'entity' recheck MUST record its actor. A caller cannot
  -- label an actorless run as 'entity'.
  constraint financial_reconciliation_runs_actor_check
    check (actor_account_id is not null or trigger_type in ('scheduled', 'manual', 'test'))
);
create index if not exists financial_reconciliation_runs_started_idx
  on public.financial_reconciliation_runs (started_at desc);
alter table public.financial_reconciliation_runs enable row level security;

-- ------------------------------------------------------------
-- 3. Durable finding model (deterministic dedupe via finding_key).
-- ------------------------------------------------------------
create table if not exists public.financial_reconciliation_findings (
  id uuid primary key default gen_random_uuid(),
  finding_key text not null unique,              -- '<finding_type>:<primary_entity_id>'
  finding_type text not null,
  severity text not null check (severity in ('info', 'warning', 'critical')),
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'investigating', 'cleared', 'resolved', 'ignored')),
  primary_entity_type text not null,
  primary_entity_id uuid not null,
  order_id uuid references public.payment_orders(id),
  earning_id uuid references public.companion_earnings(id),
  transfer_id uuid references public.companion_transfer_attempts(id),
  refund_id uuid references public.payment_refunds(id),
  dispute_id uuid references public.payment_disputes(id),
  provider_ref text,                             -- safe provider id (e.g. tr_/re_/du_), never a secret
  expected jsonb not null default '{}'::jsonb,   -- safe structured summary only
  observed jsonb not null default '{}'::jsonb,   -- safe structured summary only
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrence_count integer not null default 1,
  -- Bumped each time the finding enters a NEW active cycle (created / reopened
  -- from cleared or resolved). Part of the notification dedupe key so a genuine
  -- recurrence re-notifies while repeated scans of the same cycle do not.
  notify_cycle integer not null default 1,
  cleared_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.accounts(id),
  assigned_account_id uuid references public.accounts(id),
  resolved_at timestamptz,
  resolved_by uuid references public.accounts(id),
  resolution_reason text,
  ignored_reason text,
  latest_run_id uuid references public.financial_reconciliation_runs(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists frec_findings_status_idx on public.financial_reconciliation_findings (status, severity);
create index if not exists frec_findings_type_idx on public.financial_reconciliation_findings (finding_type);
create index if not exists frec_findings_owner_idx on public.financial_reconciliation_findings (assigned_account_id);
alter table public.financial_reconciliation_findings enable row level security;

-- ------------------------------------------------------------
-- 4. Immutable finding audit trail. Server-derived actor/timestamp. A null actor
--    is permitted ONLY for system-generated actions.
-- ------------------------------------------------------------
create table if not exists public.financial_reconciliation_audit (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.financial_reconciliation_findings(id),
  action_type text not null
    check (action_type in
      ('created', 'refreshed', 'reopened', 'cleared', 'acknowledged', 'investigating',
       'assigned', 'resolved', 'ignored', 'rechecked')),
  actor_account_id uuid references public.accounts(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- Human actions (assign/ack/investigating/resolved/ignored/rechecked) require an
  -- actor; only system-generated detection events may be actorless.
  constraint frec_audit_actor_check
    check (actor_account_id is not null
           or action_type in ('created', 'refreshed', 'reopened', 'cleared'))
);
create index if not exists frec_audit_finding_idx on public.financial_reconciliation_audit (finding_id, created_at);
alter table public.financial_reconciliation_audit enable row level security;

-- ============================================================
-- Private helpers.
-- ============================================================

-- Append an immutable finding-audit event (actor server-derived).
create or replace function app_private.write_frec_audit(
  p_finding uuid, p_action text, p_actor uuid, p_metadata jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.financial_reconciliation_audit (finding_id, action_type, actor_account_id, metadata)
  values (p_finding, p_action, p_actor, coalesce(p_metadata, '{}'::jsonb));
end;
$$;
revoke all on function app_private.write_frec_audit(uuid, text, uuid, jsonb) from public, anon, authenticated;

-- Notify the support pool for a new/worsened finding (recipient-deduped via the
-- established notifications dedupe_key + on-conflict-do-nothing). Info findings do
-- not notify. Body carries only a safe finding reference + severity + type.
create or replace function app_private.notify_frec_finding(p_finding uuid, p_severity text, p_finding_type text, p_cycle integer)
returns void language plpgsql security definer set search_path = '' as $$
declare r record; v_dedupe text;
begin
  if p_severity not in ('warning', 'critical') then return; end if;
  for r in select account_id from public.support_admins loop
    -- Key scope: finding identity + active cycle + severity + recipient. A repeated
    -- scan of the same cycle+severity dedupes; a reopen (new cycle) or a severity
    -- worsening yields a NEW key → one fresh notification per recipient.
    v_dedupe := 'frec:' || p_finding::text || ':' || p_cycle::text || ':' || p_severity || ':' || r.account_id::text;
    insert into public.notifications (user_id, type, title, body, finding_id, dedupe_key)
    values (r.account_id, 'financial_reconciliation_alert',
      'Financial reconciliation (' || p_severity || ')',
      'A ' || p_severity || ' financial reconciliation finding (' || p_finding_type
        || ') needs review. Open the internal reconciliation queue. No money is moved automatically.',
      p_finding, v_dedupe)
    on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
  end loop;
end;
$$;
revoke all on function app_private.notify_frec_finding(uuid, text, text, integer) from public, anon, authenticated;

-- Upsert one detected finding against the current run. Deterministic dedupe on
-- finding_key: refresh + occurrence bump; reopen a previously CLEARED finding on
-- a new occurrence (never silently reopen a resolved/ignored one). Returns the
-- action taken ('created' | 'refreshed' | 'reopened' | 'skip').
create or replace function app_private.upsert_frec_finding(
  p_run uuid, p_key text, p_type text, p_severity text,
  p_entity_type text, p_entity uuid,
  p_order uuid, p_earning uuid, p_transfer uuid, p_refund uuid, p_dispute uuid,
  p_provider_ref text, p_expected jsonb, p_observed jsonb
)
returns text language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_status text; v_sev text; v_cycle int; v_worse boolean;
  v_rank_new int := case p_severity when 'critical' then 3 when 'warning' then 2 else 1 end;
begin
  select id, status, severity, notify_cycle into v_id, v_status, v_sev, v_cycle
    from public.financial_reconciliation_findings where finding_key = p_key for update;

  if v_id is null then
    insert into public.financial_reconciliation_findings
      (finding_key, finding_type, severity, primary_entity_type, primary_entity_id,
       order_id, earning_id, transfer_id, refund_id, dispute_id, provider_ref,
       expected, observed, latest_run_id)
    values (p_key, p_type, p_severity, p_entity_type, p_entity,
       p_order, p_earning, p_transfer, p_refund, p_dispute, p_provider_ref,
       coalesce(p_expected, '{}'::jsonb), coalesce(p_observed, '{}'::jsonb), p_run)
    returning id into v_id;
    perform app_private.write_frec_audit(v_id, 'created', null, jsonb_build_object('severity', p_severity, 'type', p_type));
    perform app_private.notify_frec_finding(v_id, p_severity, p_type, 1);
    return 'created';
  end if;

  if v_status = 'ignored' then
    -- Explicitly suppressed by support: record recurrence but stay ignored + silent.
    update public.financial_reconciliation_findings
       set last_seen_at = now(), occurrence_count = occurrence_count + 1,
           observed = coalesce(p_observed, '{}'::jsonb), latest_run_id = p_run, updated_at = now()
     where id = v_id;
    return 'refreshed';
  end if;

  if v_status in ('resolved', 'cleared') then
    -- A genuine recurrence after a support resolution (or after auto-clear) is a
    -- NEW active cycle: reopen so the problem is visible, clear the prior
    -- resolution fields (history stays in the audit trail), and re-notify.
    update public.financial_reconciliation_findings
       set status = 'open', cleared_at = null, severity = p_severity,
           notify_cycle = notify_cycle + 1, last_seen_at = now(),
           occurrence_count = occurrence_count + 1, observed = coalesce(p_observed, '{}'::jsonb),
           resolved_at = null, resolved_by = null, resolution_reason = null,
           acknowledged_at = null, acknowledged_by = null,
           latest_run_id = p_run, updated_at = now()
     where id = v_id;
    perform app_private.write_frec_audit(v_id, 'reopened', null,
      jsonb_build_object('severity', p_severity, 'from', v_status));
    perform app_private.notify_frec_finding(v_id, p_severity, p_type, v_cycle + 1);
    return 'reopened';
  end if;

  -- open / acknowledged / investigating → refresh (preserve ack/assignment). If the
  -- severity WORSENED, re-notify (the new severity yields a distinct dedupe key).
  v_worse := v_rank_new > case v_sev when 'critical' then 3 when 'warning' then 2 else 1 end;
  update public.financial_reconciliation_findings
     set last_seen_at = now(), occurrence_count = occurrence_count + 1,
         severity = p_severity, observed = coalesce(p_observed, '{}'::jsonb),
         latest_run_id = p_run, updated_at = now()
   where id = v_id;
  if v_worse then perform app_private.notify_frec_finding(v_id, p_severity, p_type, v_cycle); end if;
  return 'refreshed';
end;
$$;
revoke all on function app_private.upsert_frec_finding(uuid, text, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated;

-- ============================================================
-- 5. Detection: the deterministic financial invariants supported by the schema.
--    Returns one row per violation in a common shape. Read-only; no mutation.
--    STALE thresholds are centralised here (transfer/payable stuck windows).
-- ============================================================
create or replace function app_private.detect_financial_findings(p_scope_ids uuid[], p_limit integer)
returns table (
  finding_key text, finding_type text, severity text, entity_type text, entity_id uuid,
  order_id uuid, earning_id uuid, transfer_id uuid, refund_id uuid, dispute_id uuid,
  provider_ref text, expected jsonb, observed jsonb
) language sql stable set search_path = '' as $$
  with detections (finding_key, finding_type, severity, entity_type, entity_id,
                   order_id, earning_id, transfer_id, refund_id, dispute_id,
                   provider_ref, expected, observed) as (
    -- B: earning net must equal basis - commission.
    select ('earning_net_mismatch:' || e.id::text)::text, 'earning_net_mismatch'::text, 'warning'::text,
           'earning'::text, e.id, e.payment_order_id, e.id, null::uuid, null::uuid, null::uuid, null::text,
           jsonb_build_object('net_minor', e.basis_minor - e.commission_minor),
           jsonb_build_object('net_minor', e.net_minor, 'basis_minor', e.basis_minor, 'commission_minor', e.commission_minor)
    from public.companion_earnings e
    where e.net_minor <> e.basis_minor - e.commission_minor

    -- C5: earning payable and unclaimed beyond 72h with no transfer attempt.
    -- Gated on Connect readiness: only a companion whose connected account can
    -- actually receive payouts should ever have an automatic transfer. A stuck
    -- payable for an onboarding-incomplete companion is EXPECTED, not an anomaly,
    -- so it is excluded here and represented separately (informational) below —
    -- this prevents flooding support with known onboarding backlog.
    union all
    select 'earning_stuck_payable:' || e.id::text, 'earning_stuck_payable', 'warning',
           'earning', e.id, e.payment_order_id, e.id, null, null, null, null,
           jsonb_build_object('expected', 'transfer attempt within 72h of payable'),
           jsonb_build_object('state', e.state, 'transfer_state', e.transfer_state, 'payable_at', e.payable_at)
    from public.companion_earnings e
    where e.state = 'payable' and e.transfer_state = 'not_ready'
      and e.payable_at is not null and e.payable_at < now() - interval '72 hours'
      and not exists (select 1 from public.companion_transfer_attempts ta where ta.earning_id = e.id)
      and exists (select 1 from public.connected_accounts ca
                  where ca.account_id = e.companion_account_id
                    and ca.payouts_enabled and ca.charges_enabled)

    -- C5b: payable beyond 72h but the companion cannot yet receive payouts
    -- (Connect onboarding incomplete). Surfaced separately and informational so
    -- the backlog stays visible without paging support as an anomaly.
    union all
    select 'earning_payable_connect_incomplete:' || e.id::text, 'earning_payable_connect_incomplete', 'info',
           'earning', e.id, e.payment_order_id, e.id, null, null, null, null,
           jsonb_build_object('expected', 'companion Connect payouts enabled before payable transfer'),
           jsonb_build_object('state', e.state, 'transfer_state', e.transfer_state, 'payable_at', e.payable_at,
             'connect_ready', false)
    from public.companion_earnings e
    where e.state = 'payable' and e.transfer_state = 'not_ready'
      and e.payable_at is not null and e.payable_at < now() - interval '72 hours'
      and not exists (select 1 from public.companion_transfer_attempts ta where ta.earning_id = e.id)
      and not exists (select 1 from public.connected_accounts ca
                      where ca.account_id = e.companion_account_id
                        and ca.payouts_enabled and ca.charges_enabled)

    -- C1: a succeeded transfer must have a provider transfer id.
    union all
    select 'transfer_missing_provider_id:' || ta.id::text, 'transfer_missing_provider_id', 'critical',
           'transfer', ta.id, e.payment_order_id, ta.earning_id, ta.id, null, null, null,
           jsonb_build_object('expected', 'stripe_transfer_id present when succeeded'),
           jsonb_build_object('state', ta.state, 'stripe_transfer_id', ta.stripe_transfer_id)
    from public.companion_transfer_attempts ta
    join public.companion_earnings e on e.id = ta.earning_id
    where ta.state = 'succeeded' and ta.stripe_transfer_id is null

    -- C3: a succeeded transfer whose earning is not marked transferred.
    union all
    select 'transfer_state_disagreement:' || ta.id::text, 'transfer_state_disagreement', 'warning',
           'transfer', ta.id, e.payment_order_id, ta.earning_id, ta.id, null, null, ta.stripe_transfer_id,
           jsonb_build_object('expected_earning_transfer_state', 'transferred'),
           jsonb_build_object('attempt_state', ta.state, 'earning_transfer_state', e.transfer_state)
    from public.companion_transfer_attempts ta
    join public.companion_earnings e on e.id = ta.earning_id
    where ta.state = 'succeeded' and e.transfer_state <> 'transferred'

    -- C6: a transfer stuck in queued/processing beyond 24h.
    union all
    select 'transfer_stuck:' || ta.id::text, 'transfer_stuck', 'warning',
           'transfer', ta.id, e.payment_order_id, ta.earning_id, ta.id, null, null, null,
           jsonb_build_object('expected', 'resolved within 24h'),
           jsonb_build_object('state', ta.state, 'created_at', ta.created_at)
    from public.companion_transfer_attempts ta
    join public.companion_earnings e on e.id = ta.earning_id
    where ta.state in ('queued', 'processing') and ta.created_at < now() - interval '24 hours'

    -- C7: a permanently-failed transfer whose earning is not in a terminal
    -- transfer state remains actionable — the companion is owed money that never
    -- moved. Without this, a hard-failed payout is a silent false negative.
    union all
    select 'transfer_failed_permanent:' || ta.id::text, 'transfer_failed_permanent', 'warning',
           'transfer', ta.id, e.payment_order_id, ta.earning_id, ta.id, null, null, null,
           jsonb_build_object('expected', 'failed payout resolved (retried, reversed or written off)'),
           jsonb_build_object('attempt_state', ta.state, 'earning_transfer_state', e.transfer_state)
    from public.companion_transfer_attempts ta
    join public.companion_earnings e on e.id = ta.earning_id
    where ta.state = 'failed_permanent'
      and e.transfer_state not in ('transferred', 'reversed')

    -- D1: a succeeded refund must have a provider refund id.
    union all
    select 'refund_missing_provider_id:' || rf.id::text, 'refund_missing_provider_id', 'critical',
           'refund', rf.id, rf.payment_order_id, null, null, rf.id, null, null,
           jsonb_build_object('expected', 'stripe_refund_id present when succeeded'),
           jsonb_build_object('state', rf.state, 'stripe_refund_id', rf.stripe_refund_id)
    from public.payment_refunds rf
    where rf.state = 'succeeded' and rf.card_refund_minor > 0 and rf.stripe_refund_id is null

    -- D2: succeeded card refunds for an order must not exceed the captured card.
    union all
    select 'refund_exceeds_card:' || o.id::text, 'refund_exceeds_card', 'critical',
           'order', o.id, o.id, null, null, null, null, null,
           jsonb_build_object('card_amount_minor', o.card_amount_minor),
           jsonb_build_object('succeeded_card_refund_minor', s.refunded)
    from public.payment_orders o
    join (select payment_order_id, sum(card_refund_minor) as refunded
          from public.payment_refunds where state = 'succeeded' group by payment_order_id) s
      on s.payment_order_id = o.id
    where s.refunded > o.card_amount_minor

    -- E1: a terminal dispute must have its closure audit fields populated.
    union all
    select 'dispute_closure_audit_incomplete:' || d.id::text, 'dispute_closure_audit_incomplete', 'warning',
           'dispute', d.id, d.payment_order_id, null, null, null, d.id, d.stripe_dispute_id,
           jsonb_build_object('expected', 'outcome and closed_at populated'),
           jsonb_build_object('internal_state', d.internal_state, 'outcome', d.outcome, 'closed_at', d.closed_at)
    from public.payment_disputes d
    where d.internal_state in ('won', 'lost', 'closed_warning')
      and (d.outcome is null or d.closed_at is null)

    -- E2: a won dispute must not still hold earnings.
    union all
    select 'dispute_won_hold_not_released:' || d.id::text, 'dispute_won_hold_not_released', 'warning',
           'dispute', d.id, d.payment_order_id, null, null, null, d.id, d.stripe_dispute_id,
           jsonb_build_object('expected', 'no held allocations when won'),
           jsonb_build_object('held_allocations',
             (select count(*) from public.payment_dispute_earnings pde where pde.dispute_id = d.id and pde.hold_state = 'held'))
    from public.payment_disputes d
    where d.internal_state = 'won'
      and exists (select 1 from public.payment_dispute_earnings pde where pde.dispute_id = d.id and pde.hold_state = 'held')

    -- E3: a lost dispute must not show funds reinstated.
    union all
    select 'dispute_lost_funds_reinstated:' || d.id::text, 'dispute_lost_funds_reinstated', 'critical',
           'dispute', d.id, d.payment_order_id, null, null, null, d.id, d.stripe_dispute_id,
           jsonb_build_object('expected', 'funds_reinstated=false when lost'),
           jsonb_build_object('funds_withdrawn', d.funds_withdrawn, 'funds_reinstated', d.funds_reinstated)
    from public.payment_disputes d
    where d.internal_state = 'lost' and d.funds_reinstated = true

    -- E4: an unresolved provider mapping remains visible (informational).
    union all
    select 'dispute_unresolved_mapping:' || d.id::text, 'dispute_unresolved_mapping', 'info',
           'dispute', d.id, null, null, null, null, d.id, d.stripe_dispute_id,
           jsonb_build_object('expected', 'mapped payment_order_id'),
           jsonb_build_object('internal_state', d.internal_state, 'payment_order_id', d.payment_order_id)
    from public.payment_disputes d
    where d.payment_order_id is null and d.internal_state not in ('won', 'lost', 'closed_warning')

    -- F1: a processed webhook event must record a result. The event id is text, so
    -- a deterministic md5(id)::uuid gives it a stable uuid entity (uniformly
    -- scopable/recheckable like every other invariant).
    union all
    select 'webhook_processed_no_result:' || w.id, 'webhook_processed_no_result', 'warning',
           'webhook_event', md5(w.id)::uuid, null, null, null, null, null, w.id,
           jsonb_build_object('expected', 'non-null result when processed'),
           jsonb_build_object('status', w.status, 'result', w.result, 'event_type', w.event_type)
    from public.stripe_webhook_events w
    where w.status = 'processed' and w.result is null

    -- A2: a succeeded card-funded order must carry a PaymentIntent id.
    union all
    select 'order_succeeded_missing_pi:' || o.id::text, 'order_succeeded_missing_pi', 'warning',
           'order', o.id, o.id, null, null, null, null, null,
           jsonb_build_object('expected', 'stripe_payment_intent_id present'),
           jsonb_build_object('status', o.status, 'card_amount_minor', o.card_amount_minor)
    from public.payment_orders o
    where o.status = 'succeeded' and o.card_amount_minor > 0 and o.stripe_payment_intent_id is null
  )
  select finding_key, finding_type, severity, entity_type, entity_id,
         order_id, earning_id, transfer_id, refund_id, dispute_id,
         provider_ref, expected, observed
  from detections
  -- Scope filter: null p_scope_ids → full scan; otherwise ONLY the given entities
  -- (used by support recheck + fixture-scoped runs so nothing else is evaluated).
  where (p_scope_ids is null or entity_id = any(p_scope_ids))
  limit least(greatest(coalesce(p_limit, 500), 1), 5000);
$$;
revoke all on function app_private.detect_financial_findings(uuid[], integer) from public, anon, authenticated;

-- ============================================================
-- 6. Service-role-only batch processor. Bounded, idempotent, concurrency-safe via
--    finding_key uniqueness. Records an immutable run. Never mutates money rows.
--
--    SAFE CLEARING (the decisive invariant): a run NEVER clears a finding merely
--    because its entity fell outside the batch or scope.
--      * entity-scoped run (p_scope_ids not null): clears ONLY findings whose
--        primary_entity_id was in the scanned scope and was not re-detected.
--      * full run (p_scope_ids null): clears stale findings ONLY when the scan was
--        COMPLETE — i.e. detection returned fewer rows than the cap. A TRUNCATED
--        full run (limit reached) clears nothing, because absence from a bounded
--        result set is not proof of resolution.
--    Any exception rolls the whole run back atomically (no half-applied changes,
--    no run row, no clearing) and re-raises — errors are never swallowed.
-- ============================================================
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
revoke all on function app_private.process_financial_reconciliation(uuid[], integer, text, uuid) from public, anon, authenticated;
grant execute on function app_private.process_financial_reconciliation(uuid[], integer, text, uuid) to service_role;

-- ============================================================
-- 7. Support-facing RPCs (authenticated + is_support_admin gated, fail closed).
-- ============================================================

create or replace function public.support_reconciliation_queue()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: queue'; end if;
  select coalesce(jsonb_agg(x order by
      (case (x->>'severity') when 'critical' then 0 when 'warning' then 1 else 2 end),
      (x->>'last_seen_at') desc), '[]'::jsonb) into v
  from (
    select jsonb_build_object(
      'id', f.id, 'finding_type', f.finding_type, 'severity', f.severity, 'status', f.status,
      'primary_entity_type', f.primary_entity_type, 'primary_entity_id', f.primary_entity_id,
      'order_id', f.order_id, 'earning_id', f.earning_id, 'transfer_id', f.transfer_id,
      'refund_id', f.refund_id, 'dispute_id', f.dispute_id, 'provider_ref', f.provider_ref,
      'expected', f.expected, 'observed', f.observed,
      'first_seen_at', f.first_seen_at, 'last_seen_at', f.last_seen_at, 'occurrence_count', f.occurrence_count,
      'assigned_account_id', f.assigned_account_id,
      'assigned_display_name', (select a.display_name from public.accounts a where a.id = f.assigned_account_id),
      'created_at', f.created_at) as x
    from public.financial_reconciliation_findings f) s;
  return v;
end;
$$;
revoke all on function public.support_reconciliation_queue() from public, anon;
grant execute on function public.support_reconciliation_queue() to authenticated;

create or replace function public.support_reconciliation_detail(p_finding uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_f public.financial_reconciliation_findings;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: detail'; end if;
  select * into v_f from public.financial_reconciliation_findings where id = p_finding;
  if v_f.id is null then raise exception 'not_found: detail'; end if;
  select jsonb_build_object(
    'finding', jsonb_build_object(
      'id', v_f.id, 'finding_key', v_f.finding_key, 'finding_type', v_f.finding_type,
      'severity', v_f.severity, 'status', v_f.status,
      'primary_entity_type', v_f.primary_entity_type, 'primary_entity_id', v_f.primary_entity_id,
      'order_id', v_f.order_id, 'earning_id', v_f.earning_id, 'transfer_id', v_f.transfer_id,
      'refund_id', v_f.refund_id, 'dispute_id', v_f.dispute_id, 'provider_ref', v_f.provider_ref,
      'expected', v_f.expected, 'observed', v_f.observed,
      'first_seen_at', v_f.first_seen_at, 'last_seen_at', v_f.last_seen_at,
      'occurrence_count', v_f.occurrence_count, 'cleared_at', v_f.cleared_at,
      'acknowledged_at', v_f.acknowledged_at, 'acknowledged_by', v_f.acknowledged_by,
      'assigned_account_id', v_f.assigned_account_id,
      'assigned_display_name', (select a.display_name from public.accounts a where a.id = v_f.assigned_account_id),
      'resolved_at', v_f.resolved_at, 'resolved_by', v_f.resolved_by,
      'resolution_reason', v_f.resolution_reason, 'ignored_reason', v_f.ignored_reason),
    'audit', coalesce((select jsonb_agg(jsonb_build_object(
        'id', au.id, 'action_type', au.action_type, 'actor_account_id', au.actor_account_id,
        'metadata', au.metadata, 'created_at', au.created_at) order by au.created_at)
      from public.financial_reconciliation_audit au where au.finding_id = p_finding), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;
revoke all on function public.support_reconciliation_detail(uuid) from public, anon;
grant execute on function public.support_reconciliation_detail(uuid) to authenticated;

-- Claim/assign a finding to the caller (support-admin model only).
create or replace function public.support_assign_finding(p_finding uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid();
begin
  if not app_private.is_support_admin() then raise exception 'not_found: assign'; end if;
  update public.financial_reconciliation_findings
     set assigned_account_id = v_actor, updated_at = now()
   where id = p_finding and status not in ('cleared', 'resolved', 'ignored');
  if not found then raise exception 'not_found: assign'; end if;
  perform app_private.write_frec_audit(p_finding, 'assigned', v_actor, jsonb_build_object('assigned_to', v_actor));
end;
$$;
revoke all on function public.support_assign_finding(uuid) from public, anon;
grant execute on function public.support_assign_finding(uuid) to authenticated;

-- Move a finding through the investigation lifecycle. Support NEVER edits
-- expected/observed financial values or severity.
create or replace function public.support_update_finding_status(p_finding uuid, p_status text, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_from text;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: status'; end if;
  if p_status not in ('acknowledged', 'investigating', 'resolved', 'ignored') then
    raise exception 'invalid_status';
  end if;
  if p_status in ('resolved', 'ignored') and coalesce(char_length(trim(p_reason)), 0) = 0 then
    raise exception 'reason_required';
  end if;
  select status into v_from from public.financial_reconciliation_findings where id = p_finding for update;
  if v_from is null then raise exception 'not_found: status'; end if;
  -- Idempotent no-op if already in the requested terminal state.
  if v_from = p_status and p_status in ('resolved', 'ignored') then return; end if;

  update public.financial_reconciliation_findings
     set status = p_status,
         acknowledged_at = case when p_status = 'acknowledged' then coalesce(acknowledged_at, now()) else acknowledged_at end,
         acknowledged_by = case when p_status = 'acknowledged' then coalesce(acknowledged_by, v_actor) else acknowledged_by end,
         resolved_at = case when p_status = 'resolved' then now() else resolved_at end,
         resolved_by = case when p_status = 'resolved' then v_actor else resolved_by end,
         resolution_reason = case when p_status = 'resolved' then left(trim(p_reason), 2000) else resolution_reason end,
         ignored_reason = case when p_status = 'ignored' then left(trim(p_reason), 2000) else ignored_reason end,
         updated_at = now()
   where id = p_finding;
  perform app_private.write_frec_audit(p_finding,
    case p_status when 'acknowledged' then 'acknowledged' when 'investigating' then 'investigating'
                  when 'resolved' then 'resolved' else 'ignored' end,
    v_actor, jsonb_build_object('from', v_from, 'to', p_status));
end;
$$;
revoke all on function public.support_update_finding_status(uuid, text, text) from public, anon;
grant execute on function public.support_update_finding_status(uuid, text, text) to authenticated;

-- Narrowly-scoped recheck: re-evaluate reconciliation for THIS finding's own
-- entity ONLY (entity-scoped run). It moves NO money, chooses no provider state,
-- cannot change any financial amount, and CANNOT clear findings for other
-- entities — it only re-runs the read-only detection scoped to this entity.
create or replace function public.support_recheck_finding(p_finding uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_entity uuid; v_status text;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: recheck'; end if;
  select primary_entity_id into v_entity from public.financial_reconciliation_findings where id = p_finding;
  if v_entity is null then raise exception 'not_found: recheck'; end if;
  -- Entity-scoped run: detection + clearing are restricted to this finding's entity.
  perform app_private.process_financial_reconciliation(array[v_entity], 5000, 'entity', v_actor);
  perform app_private.write_frec_audit(p_finding, 'rechecked', v_actor, '{}'::jsonb);
  select status into v_status from public.financial_reconciliation_findings where id = p_finding;
  return jsonb_build_object('finding_id', p_finding, 'status', v_status);
end;
$$;
revoke all on function public.support_recheck_finding(uuid) from public, anon;
grant execute on function public.support_recheck_finding(uuid) to authenticated;

-- ------------------------------------------------------------
-- Service-role manual entrypoints. Both run the SAME read-only detection as the
-- deferred cron and are exposed to the service role ONLY (never authenticated/
-- anon). They move no money and take no caller-selected financial values.
--   * run_financial_reconciliation()            → deliberate FULL reconciliation.
--   * run_financial_reconciliation_for_entities → entity-scoped (fixtures / ops);
--     tagged trigger 'test' so operational readers can exclude it.
-- ------------------------------------------------------------
create or replace function public.run_financial_reconciliation(p_limit integer default 500)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return app_private.process_financial_reconciliation(null, p_limit, 'manual', null);
end;
$$;
revoke all on function public.run_financial_reconciliation(integer) from public, anon, authenticated;
grant execute on function public.run_financial_reconciliation(integer) to service_role;

create or replace function public.run_financial_reconciliation_for_entities(p_entity_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_entity_ids is null or array_length(p_entity_ids, 1) is null then
    raise exception 'entities_required';
  end if;
  return app_private.process_financial_reconciliation(p_entity_ids, 5000, 'test', null);
end;
$$;
revoke all on function public.run_financial_reconciliation_for_entities(uuid[]) from public, anon, authenticated;
grant execute on function public.run_financial_reconciliation_for_entities(uuid[]) to service_role;

select pg_notify('pgrst', 'reload schema');

-- ============================================================
-- 8. Scheduling is DEFERRED — this migration NEVER creates a cron job and NEVER
--    touches the operational 2G6E-B 'dispute-deadline-alerts' cron.
--
--    Rollout order: (1) apply schema; (2) run focused hosted tests; (3) review
--    existing data; (4) controlled manual reconciliation; (5) inspect findings;
--    (6) only then activate cron.
--
--    MANUAL RECONCILIATION (dry run, no schedule; service role):
--      select public.run_financial_reconciliation();   -- or app_private.process_financial_reconciliation()
--    ACTIVATE (every 6 hours, idempotent — safe to re-run, never duplicates):
--      create extension if not exists pg_cron;
--      select cron.unschedule(jobid) from cron.job where jobname = 'financial-reconciliation';
--      select cron.schedule('financial-reconciliation', '0 */6 * * *',
--        $$select app_private.process_financial_reconciliation();$$);
--    INSPECT JOB:   select jobid, schedule, active from cron.job where jobname = 'financial-reconciliation';
--    INSPECT RUNS:  select status, return_message, start_time from cron.job_run_details
--                     where jobid = (select jobid from cron.job where jobname = 'financial-reconciliation')
--                     order by start_time desc limit 10;
--    DISABLE:       select cron.unschedule(jobid) from cron.job where jobname = 'financial-reconciliation';
-- ============================================================
do $$
begin
  raise notice 'financial-reconciliation NOT scheduled automatically. Activate via cron.schedule() only after hosted validation + a manual dry run.';
end $$;
