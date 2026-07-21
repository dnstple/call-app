-- ============================================================
-- 2G6E-B — dispute evidence-deadline alerts & support escalation (migration 0062)
--
-- Additive to the immutable 0056–0061 baseline. This stage warns the support team
-- early enough to PREPARE and MANUALLY submit dispute evidence in Stripe before
-- the provider deadline. It never calls Stripe, never submits evidence, and never
-- changes dispute/provider/financial state. Urgency is derived from trusted server
-- timestamps only; the browser clock is never authoritative.
--
-- It adds:
--   * a deterministic server-side urgency function;
--   * an immutable, deduplicated alert ledger (dispute_deadline_alerts);
--   * a service-role-only processor (batch + per-dispute) that creates alerts and
--     support notifications and escalates unassigned critical/overdue cases;
--   * a support-gated "recheck now" wrapper and alert-history reader;
--   * an extended support queue exposing urgency/escalation/alert fields;
--   * a guarded hourly pg_cron schedule (idempotent; safe on re-deploy).
--
-- Reuses the established notification pattern (public.notifications with a
-- (user_id, dedupe_key) partial-unique dedupe, on-conflict-do-nothing, RLS
-- own-rows-only) and the established guarded pg_cron pattern.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Additive columns on existing tables.
-- ------------------------------------------------------------
-- Support notifications carry a safe dispute reference for deep-linking to
-- /internal/disputes/:disputeId (no secrets, no bodies).
alter table public.notifications
  add column if not exists dispute_id uuid references public.payment_disputes(id) on delete set null;

-- Escalation flag on the one-to-one support case (never reassigns ownership or
-- overwrites resolution).
alter table public.dispute_support_cases
  add column if not exists escalated boolean not null default false;
alter table public.dispute_support_cases
  add column if not exists escalated_at timestamptz;

-- 2G6E-B introduces SYSTEM-initiated audit events (escalation runs under the
-- service role / cron, with no human actor). Allow a null actor for those; every
-- existing human-initiated 0061 event still records auth.uid(). Widen the action
-- vocabulary to include 'escalated'.
alter table public.dispute_support_audit alter column actor_account_id drop not null;
do $$
begin
  alter table public.dispute_support_audit drop constraint if exists dispute_support_audit_action_type_check;
  alter table public.dispute_support_audit add constraint dispute_support_audit_action_type_check
    check (action_type in
      ('case_claimed', 'case_released', 'status_changed', 'note_added',
       'evidence_recorded', 'reconcile_attempted', 'adjustment_acknowledged', 'adjustment_resolved',
       'escalated'));
end $$;

-- ------------------------------------------------------------
-- 2. Immutable, deduplicated alert ledger.
-- ------------------------------------------------------------
create table if not exists public.dispute_deadline_alerts (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references public.payment_disputes(id),
  threshold text not null
    check (threshold in ('warn_7d', 'warn_3d', 'warn_24h', 'overdue', 'escalation')),
  urgency_snapshot text not null,
  evidence_due_at_snapshot timestamptz,
  recipient_account_id uuid references public.accounts(id),  -- null for pool escalation ledger rows
  channel text not null default 'notification' check (channel in ('notification', 'escalation')),
  delivery_state text not null default 'delivered' check (delivery_state in ('pending', 'delivered', 'failed')),
  delivered_at timestamptz,
  failure_reason text,
  -- Dedupe scope encodes dispute + threshold + DEADLINE SNAPSHOT + recipient, so a
  -- materially changed deadline yields a new key (new alert), while repeated
  -- processor runs at the same deadline never duplicate.
  dedupe_key text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists dispute_deadline_alerts_dispute_idx on public.dispute_deadline_alerts (dispute_id, created_at);
alter table public.dispute_deadline_alerts enable row level security;

-- ============================================================
-- 3. Deterministic server-side urgency. Thresholds live HERE (single source),
--    not scattered as magic numbers. Terminal disputes and null deadlines are
--    handled explicitly. p_now is passed so the function is IMMUTABLE + testable.
-- ============================================================
create or replace function app_private.dispute_urgency(p_due timestamptz, p_internal_state text, p_now timestamptz)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_internal_state in ('won', 'lost', 'closed_warning') then 'closed'
    when p_due is null then 'no_deadline'
    when p_due < p_now then 'overdue'
    when p_due - p_now < interval '24 hours' then 'critical'   -- < 24h
    when p_due - p_now < interval '72 hours' then 'urgent'     -- 24–72h
    when p_due - p_now <= interval '7 days' then 'due_soon'    -- 3–7 days
    else 'normal'                                              -- > 7 days
  end;
$$;
revoke all on function app_private.dispute_urgency(timestamptz, text, timestamptz) from public, anon, authenticated;

-- Emit a support notification for one recipient (dedup aligned with the ledger).
-- Body is safe: dispute reference + urgency + deadline only; no bodies/notes/secrets.
create or replace function app_private.emit_dispute_alert_notification(
  p_recipient uuid, p_dispute public.payment_disputes, p_urgency text, p_threshold text, p_dedupe text
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications (user_id, type, title, body, dispute_id, dedupe_key)
  values (
    p_recipient, 'dispute_deadline_alert',
    'Dispute evidence deadline (' || p_urgency || ')',
    'Dispute ' || p_dispute.stripe_dispute_id || ' is ' || p_urgency
      || '. Evidence due ' || coalesce(to_char(p_dispute.evidence_due_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC', 'unknown')
      || '. Prepare and submit evidence MANUALLY in Stripe before the deadline.',
    p_dispute.id, p_dedupe)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
end;
$$;
revoke all on function app_private.emit_dispute_alert_notification(uuid, public.payment_disputes, text, text, text) from public, anon, authenticated;

-- ============================================================
-- 4. Core per-dispute alert processor. Idempotent + concurrency-safe: the alert
--    ledger's unique(dedupe_key) is the single dedup authority; every side effect
--    (notification, escalation, audit) is gated on a NEW ledger insert.
-- ============================================================
create or replace function app_private.process_one_dispute_alert(p_dispute uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_d public.payment_disputes;
  v_now timestamptz := now();
  v_urgency text; v_threshold text; v_epoch text; v_dedupe text; v_alert_id uuid;
  v_has_evidence boolean; v_needs_response boolean;
  v_owner uuid; v_notify_pool boolean := false; v_escalate boolean := false;
  v_alerts int := 0; v_notifs int := 0; v_escalations int := 0;
  r_admin record; v_case_id uuid;
begin
  select * into v_d from public.payment_disputes where id = p_dispute;
  if v_d.id is null then return jsonb_build_object('skipped', 'not_found'); end if;

  v_urgency := app_private.dispute_urgency(v_d.evidence_due_at, v_d.internal_state, v_now);
  -- No alerts for terminal, no-deadline, or not-yet-due disputes.
  if v_urgency in ('closed', 'no_deadline', 'normal') then
    return jsonb_build_object('urgency', v_urgency, 'alerts', 0);
  end if;

  -- Evidence-submitted suppression: once a manual submission is recorded, stop
  -- alerting UNLESS the provider still explicitly requires a (new) response.
  v_has_evidence := exists (select 1 from public.dispute_manual_evidence me where me.dispute_id = p_dispute);
  v_needs_response := lower(coalesce(v_d.provider_status, '')) in ('needs_response', 'warning_needs_response');
  if v_has_evidence and not v_needs_response then
    return jsonb_build_object('urgency', v_urgency, 'suppressed', 'evidence_recorded');
  end if;

  v_threshold := case v_urgency
    when 'due_soon' then 'warn_7d'
    when 'urgent'   then 'warn_3d'
    when 'critical' then 'warn_24h'
    when 'overdue'  then 'overdue'
    else null end;
  if v_threshold is null then return jsonb_build_object('urgency', v_urgency, 'alerts', 0); end if;

  -- Deadline snapshot → a materially changed deadline produces new dedupe keys.
  v_epoch := to_char(v_d.evidence_due_at at time zone 'UTC', 'YYYYMMDD"T"HH24MISS');
  select id, assigned_account_id into v_case_id, v_owner
    from public.dispute_support_cases where dispute_id = p_dispute;

  -- Recipient policy (least-noisy): due_soon/urgent → owner if assigned else pool;
  -- critical/overdue → owner (if any) AND pool; unassigned critical/overdue escalates.
  if v_urgency in ('critical', 'overdue') then
    v_notify_pool := true;
    if v_owner is null then v_escalate := true; end if;
  end if;

  -- 1) Owner alert.
  if v_owner is not null then
    v_dedupe := 'dda:' || p_dispute::text || ':' || v_threshold || ':' || v_epoch || ':owner:' || v_owner::text;
    insert into public.dispute_deadline_alerts
      (dispute_id, threshold, urgency_snapshot, evidence_due_at_snapshot, recipient_account_id, channel, delivery_state, delivered_at, dedupe_key)
    values (p_dispute, v_threshold, v_urgency, v_d.evidence_due_at, v_owner, 'notification', 'delivered', v_now, v_dedupe)
    on conflict (dedupe_key) do nothing returning id into v_alert_id;
    if v_alert_id is not null then
      v_alerts := v_alerts + 1;
      perform app_private.emit_dispute_alert_notification(v_owner, v_d, v_urgency, v_threshold, v_dedupe);
      v_notifs := v_notifs + 1;
    end if;
  end if;

  -- 2) Pool alert (unassigned at any threshold, or everyone at critical/overdue).
  if v_notify_pool or v_owner is null then
    for r_admin in select account_id from public.support_admins loop
      if v_owner is not null and r_admin.account_id = v_owner then continue; end if; -- owner already alerted
      v_dedupe := 'dda:' || p_dispute::text || ':' || v_threshold || ':' || v_epoch || ':pool:' || r_admin.account_id::text;
      insert into public.dispute_deadline_alerts
        (dispute_id, threshold, urgency_snapshot, evidence_due_at_snapshot, recipient_account_id, channel, delivery_state, delivered_at, dedupe_key)
      values (p_dispute, v_threshold, v_urgency, v_d.evidence_due_at, r_admin.account_id, 'notification', 'delivered', v_now, v_dedupe)
      on conflict (dedupe_key) do nothing returning id into v_alert_id;
      if v_alert_id is not null then
        v_alerts := v_alerts + 1;
        perform app_private.emit_dispute_alert_notification(r_admin.account_id, v_d, v_urgency, v_threshold, v_dedupe);
        v_notifs := v_notifs + 1;
      end if;
    end loop;
  end if;

  -- 3) Escalation for unassigned critical/overdue — idempotent, ledger-gated so the
  --    case flag + support audit event happen at most once per deadline snapshot.
  if v_escalate then
    v_dedupe := 'dda:' || p_dispute::text || ':escalation:' || v_epoch;
    insert into public.dispute_deadline_alerts
      (dispute_id, threshold, urgency_snapshot, evidence_due_at_snapshot, recipient_account_id, channel, delivery_state, delivered_at, dedupe_key)
    values (p_dispute, 'escalation', v_urgency, v_d.evidence_due_at, null, 'escalation', 'delivered', v_now, v_dedupe)
    on conflict (dedupe_key) do nothing returning id into v_alert_id;
    if v_alert_id is not null then
      v_escalations := v_escalations + 1;
      -- Ensure a case row and mark it escalated WITHOUT reassigning ownership or
      -- touching resolution/handling status.
      insert into public.dispute_support_cases (dispute_id, escalated, escalated_at)
      values (p_dispute, true, v_now)
      on conflict (dispute_id) do update
        set escalated = true, escalated_at = coalesce(public.dispute_support_cases.escalated_at, v_now),
            last_handled_at = v_now, updated_at = v_now;
      select id into v_case_id from public.dispute_support_cases where dispute_id = p_dispute;
      -- Immutable support audit event (system actor = null). Exactly once.
      insert into public.dispute_support_audit (dispute_id, case_id, action_type, actor_account_id, metadata)
      values (p_dispute, v_case_id, 'escalated', null,
              jsonb_build_object('reason', 'unassigned_' || v_urgency, 'threshold', v_threshold, 'urgency', v_urgency));
    end if;
  end if;

  return jsonb_build_object('urgency', v_urgency, 'threshold', v_threshold,
    'alerts', v_alerts, 'notifications', v_notifs, 'escalations', v_escalations);
end;
$$;
revoke all on function app_private.process_one_dispute_alert(uuid) from public, anon, authenticated;

-- ============================================================
-- 5. Service-role-only batch processor. Bounded, idempotent, concurrency-safe.
--    Scans ONLY disputes with a live deadline — never unrelated financial records.
-- ============================================================
create or replace function app_private.process_dispute_deadline_alerts(p_limit integer default 200)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r record; v jsonb;
  v_processed int := 0; v_alerts int := 0; v_notifs int := 0; v_escalations int := 0;
begin
  for r in
    select d.id from public.payment_disputes d
    where d.internal_state not in ('won', 'lost', 'closed_warning')
      and d.evidence_due_at is not null
    order by d.evidence_due_at asc
    limit greatest(coalesce(p_limit, 200), 1)
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
revoke all on function app_private.process_dispute_deadline_alerts(integer) from public, anon, authenticated;
grant execute on function app_private.process_dispute_deadline_alerts(integer) to service_role;

-- ============================================================
-- 6. Support-facing RPCs (authenticated + is_support_admin gated, fail closed).
-- ============================================================

-- "Recheck now": run the alert logic for ONE dispute. The caller supplies only a
-- dispute id — never a deadline or a recipient; those come from trusted data.
create or replace function public.support_recheck_dispute_alerts(p_dispute uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not app_private.is_support_admin() then raise exception 'not_found: recheck'; end if;
  if not exists (select 1 from public.payment_disputes d where d.id = p_dispute) then
    raise exception 'not_found: recheck';
  end if;
  return app_private.process_one_dispute_alert(p_dispute);
end;
$$;
revoke all on function public.support_recheck_dispute_alerts(uuid) from public, anon;
grant execute on function public.support_recheck_dispute_alerts(uuid) to authenticated;

-- Alert + escalation history + current server urgency/countdown for the detail page.
create or replace function public.support_dispute_alerts(p_dispute uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_d public.payment_disputes; v_now timestamptz := now();
begin
  if not app_private.is_support_admin() then raise exception 'not_found: alerts'; end if;
  select * into v_d from public.payment_disputes where id = p_dispute;
  if v_d.id is null then raise exception 'not_found: alerts'; end if;
  select jsonb_build_object(
    'dispute_id', v_d.id,
    'evidence_due_at', v_d.evidence_due_at,
    'urgency', app_private.dispute_urgency(v_d.evidence_due_at, v_d.internal_state, v_now),
    'seconds_remaining', case when v_d.evidence_due_at is null then null
      else extract(epoch from (v_d.evidence_due_at - v_now))::bigint end,
    'escalated', coalesce((select c.escalated from public.dispute_support_cases c where c.dispute_id = p_dispute), false),
    'escalated_at', (select c.escalated_at from public.dispute_support_cases c where c.dispute_id = p_dispute),
    'has_manual_evidence', exists (select 1 from public.dispute_manual_evidence me where me.dispute_id = p_dispute),
    'alerts', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'threshold', a.threshold, 'urgency_snapshot', a.urgency_snapshot,
        'evidence_due_at_snapshot', a.evidence_due_at_snapshot, 'recipient_account_id', a.recipient_account_id,
        'channel', a.channel, 'delivery_state', a.delivery_state, 'delivered_at', a.delivered_at,
        'created_at', a.created_at) order by a.created_at desc)
      from public.dispute_deadline_alerts a where a.dispute_id = p_dispute), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;
revoke all on function public.support_dispute_alerts(uuid) from public, anon;
grant execute on function public.support_dispute_alerts(uuid) to authenticated;

-- ------------------------------------------------------------
-- 7. Extend the support queue (redefine; adds urgency/escalation/alert fields).
--    Urgency now comes from the shared server function (7-state model).
-- ------------------------------------------------------------
create or replace function public.support_dispute_queue()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_now timestamptz := now();
begin
  if not app_private.is_support_admin() then raise exception 'not_found: queue'; end if;
  select coalesce(jsonb_agg(x order by
      (x->>'evidence_due_at') asc nulls last, (x->>'created_at') desc), '[]'::jsonb) into v
  from (
    select jsonb_build_object(
      'id', d.id, 'stripe_dispute_id', d.stripe_dispute_id,
      'provider_status', d.provider_status, 'internal_state', d.internal_state,
      'disputed_amount_minor', d.disputed_amount_minor, 'currency', d.currency,
      'reason', d.reason, 'evidence_due_at', d.evidence_due_at,
      'seconds_remaining', case when d.evidence_due_at is null then null
        else extract(epoch from (d.evidence_due_at - v_now))::bigint end,
      'urgency', app_private.dispute_urgency(d.evidence_due_at, d.internal_state, v_now),
      'is_unresolved_mapping', (d.payment_order_id is null),
      'funds_withdrawn', d.funds_withdrawn, 'funds_reinstated', d.funds_reinstated,
      'outcome', d.outcome, 'created_at', d.created_at,
      'handling_status', coalesce(c.handling_status, 'unassigned'),
      'assigned_account_id', c.assigned_account_id,
      'assigned_display_name', (select a.display_name from public.accounts a where a.id = c.assigned_account_id),
      'escalated', coalesce(c.escalated, false),
      'has_manual_evidence', exists (select 1 from public.dispute_manual_evidence me where me.dispute_id = d.id),
      'has_open_adjustment', exists (
        select 1 from public.settlement_adjustments sa where sa.dispute_id = d.id and sa.state <> 'resolved'),
      'latest_alert_threshold', (select a.threshold from public.dispute_deadline_alerts a
        where a.dispute_id = d.id order by a.created_at desc limit 1)) as x
    from public.payment_disputes d
    left join public.dispute_support_cases c on c.dispute_id = d.id) s;
  return v;
end;
$$;
revoke all on function public.support_dispute_queue() from public, anon;
grant execute on function public.support_dispute_queue() to authenticated;

-- ============================================================
-- 8. Hourly schedule (guarded + idempotent). The processor is pure SQL (no Stripe,
--    no Vault, no external call), so it is safe to schedule directly. Re-running
--    the migration never duplicates the job. If pg_cron is unavailable, the exact
--    manual activation command is printed instead.
-- ============================================================
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — schedule hourly: select app_private.process_dispute_deadline_alerts();';
    return;
  end if;
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'dispute-deadline-alerts';
  perform cron.schedule('dispute-deadline-alerts', '0 * * * *',
    $cron$select app_private.process_dispute_deadline_alerts();$cron$);
  raise notice 'Scheduled dispute-deadline-alerts hourly via pg_cron.';
exception when others then
  raise notice 'dispute-deadline-alerts scheduling skipped (%). Invoke app_private.process_dispute_deadline_alerts() hourly.', sqlerrm;
end $$;

select pg_notify('pgrst', 'reload schema');
