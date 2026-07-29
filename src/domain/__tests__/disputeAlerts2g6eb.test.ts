/**
 * 2G6E-B contracts — dispute evidence-deadline alerts & escalation (0062).
 * Structural proofs that the alert model is additive, urgency thresholds are
 * explicit and server-derived, the processor is service-role-only, the alert
 * ledger is immutable + deduplicated, support readers are gated, terminal /
 * no-deadline / evidence-submitted disputes are handled, the cron schedule is
 * safe + unique, the frontend repository wires to the intended RPCs, and no
 * Stripe API call or automatic evidence submission exists.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const M = readFileSync(join(ROOT, 'supabase', 'migrations', '0062_dispute_deadline_alerts.sql'), 'utf-8');
const REPO = readFileSync(join(ROOT, 'src', 'repositories', 'disputeSupportRepository.ts'), 'utf-8');
const QUEUE = readFileSync(join(ROOT, 'src', 'pages', 'InternalDisputes.tsx'), 'utf-8');
const DETAIL = readFileSync(join(ROOT, 'src', 'pages', 'InternalDisputeDetail.tsx'), 'utf-8');
function fn(name: string): string {
  const s = M.indexOf(`create or replace function ${name}`);
  if (s < 0) throw new Error(`function not found: ${name}`);
  return M.slice(s, M.indexOf('\n$$;', s));
}

describe('0062 is additive and never touches dispute financial behaviour', () => {
  it('adds only new tables/columns/functions; no destructive DDL, no money rewrites', () => {
    expect(M).not.toMatch(/drop\s+table/i);
    expect(M).not.toMatch(/\btruncate\b/i);
    expect(M).not.toMatch(/update\s+public\.companion_earnings/i);
    expect(M).not.toMatch(/update\s+public\.settlement_adjustments/i);
    expect(M).not.toMatch(/update\s+public\.payment_disputes\s+set/i);
    expect(M).not.toContain('delete from');
    expect(M).toContain("select pg_notify('pgrst', 'reload schema')");
  });
  it('reuses the existing notification table (dedupe + on-conflict-do-nothing), not a second system', () => {
    expect(fn('app_private.emit_dispute_alert_notification')).toContain('insert into public.notifications');
    expect(fn('app_private.emit_dispute_alert_notification')).toContain('on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing');
    expect(M).toContain('add column if not exists dispute_id uuid references public.payment_disputes(id) on delete set null');
  });
});

describe('0062 urgency model is explicit, server-derived and centralised', () => {
  const u = fn('app_private.dispute_urgency');
  it('is IMMUTABLE, takes p_now (never the browser clock), search_path empty', () => {
    expect(u).toContain('returns text language sql immutable set search_path = \'\'');
    expect(u).toContain('p_due timestamptz, p_internal_state text, p_now timestamptz');
  });
  it('defines all seven states with clear contiguous thresholds', () => {
    expect(u).toContain("when p_internal_state in ('won', 'lost', 'closed_warning') then 'closed'");
    expect(u).toContain("when p_due is null then 'no_deadline'");
    expect(u).toContain("when p_due < p_now then 'overdue'");
    expect(u).toContain("when p_due - p_now < interval '24 hours' then 'critical'");
    expect(u).toContain("when p_due - p_now < interval '72 hours' then 'urgent'");
    expect(u).toContain("when p_due - p_now <= interval '7 days' then 'due_soon'");
    expect(u).toContain("else 'normal'");
  });
});

describe('0062 alert ledger is immutable + deduplicated', () => {
  it('has a unique dedupe key, threshold constraint, RLS on and NO client policies', () => {
    expect(M).toContain('create table if not exists public.dispute_deadline_alerts');
    expect(M).toContain('dedupe_key text not null unique');
    expect(M).toContain("check (threshold in ('warn_7d', 'warn_3d', 'warn_24h', 'overdue', 'escalation'))");
    expect(M).toContain('alter table public.dispute_deadline_alerts enable row level security');
    expect(M).not.toMatch(/create policy[^\n]*dispute_deadline_alerts/);
    // Append-only: no update/delete of the ledger anywhere.
    expect(M).not.toMatch(/update\s+public\.dispute_deadline_alerts/i);
    expect(M).not.toMatch(/delete\s+from\s+public\.dispute_deadline_alerts/i);
    // Dedupe scope includes the deadline snapshot so a changed deadline re-alerts.
    expect(fn('app_private.process_one_dispute_alert')).toContain("v_epoch := to_char(v_d.evidence_due_at at time zone 'UTC'");
    expect(fn('app_private.process_one_dispute_alert')).toContain('on conflict (dedupe_key) do nothing');
  });
});

describe('0062 processor policy: terminal/no-deadline/evidence-submitted handling', () => {
  const p = fn('app_private.process_one_dispute_alert');
  it('never alerts terminal, no-deadline or normal disputes', () => {
    expect(p).toContain("if v_urgency in ('closed', 'no_deadline', 'normal') then");
    expect(p).toContain("return jsonb_build_object('urgency', v_urgency, 'alerts', 0)");
  });
  it('suppresses alerts after a manual submission unless the provider still needs a response', () => {
    expect(p).toContain('dispute_manual_evidence');
    expect(p).toContain("lower(coalesce(v_d.provider_status, '')) in ('needs_response', 'warning_needs_response')");
    expect(p).toContain("if v_has_evidence and not v_needs_response then");
    expect(p).toContain("'suppressed', 'evidence_recorded'");
  });
  it('maps urgency to at-most-one threshold and escalates unassigned critical/overdue', () => {
    expect(p).toContain("when 'due_soon' then 'warn_7d'");
    expect(p).toContain("when 'urgent'   then 'warn_3d'");
    expect(p).toContain("when 'critical' then 'warn_24h'");
    expect(p).toContain("when 'overdue'  then 'overdue'");
    expect(p).toContain("if v_owner is null then v_escalate := true; end if;");
    // Escalation records the support audit event exactly once (ledger-gated) and
    // never reassigns ownership or resolution.
    expect(p).toContain("'escalated', null,");
    expect(p).not.toMatch(/assigned_account_id\s*=\s*[^n]/); // never reassigns an owner
  });
});

describe('0062 security + grants', () => {
  it('low-level processing functions are service-role only / definer-private', () => {
    for (const n of ['app_private.dispute_urgency(timestamptz, text, timestamptz)',
                     'app_private.emit_dispute_alert_notification(uuid, public.payment_disputes, text, text, text)',
                     'app_private.process_one_dispute_alert(uuid)']) {
      expect(M).toContain(`revoke all on function ${n} from public, anon, authenticated`);
    }
    expect(M).toContain('revoke all on function app_private.process_dispute_deadline_alerts(integer) from public, anon, authenticated');
    expect(M).toContain('grant execute on function app_private.process_dispute_deadline_alerts(integer) to service_role');
    // The browser processor is NOT granted to authenticated.
    expect(M).not.toMatch(/grant execute on function app_private\.process_dispute_deadline_alerts\(integer\) to authenticated/);
  });
  it('support-facing RPCs are gated, definer, search_path empty, revoked from public/anon', () => {
    for (const [n, sig] of [['public.support_recheck_dispute_alerts', '(uuid)'],
                            ['public.support_dispute_alerts', '(uuid)'],
                            ['public.support_dispute_queue', '()']] as const) {
      const b = fn(n);
      expect(b).toContain("security definer set search_path = ''");
      expect(b).toContain('app_private.is_support_admin()');
      expect(M).toContain(`revoke all on function ${n}${sig} from public, anon`);
      expect(M).toContain(`grant execute on function ${n}${sig} to authenticated`);
    }
  });
  it('the recheck wrapper takes only a dispute id — never a deadline or recipient', () => {
    const r = fn('public.support_recheck_dispute_alerts');
    expect(r).toMatch(/support_recheck_dispute_alerts\(p_dispute uuid\)/);
    expect(r).not.toMatch(/p_due|p_deadline|p_recipient|p_threshold|p_now/);
    expect(r).toContain('return app_private.process_one_dispute_alert(p_dispute)');
  });
});

describe('0062 scheduling is DEFERRED (never auto-activated on apply)', () => {
  it('does not schedule the cron on apply; documents an hourly, unique, disable-able job', () => {
    // Applying 0062 must NOT create/activate the job (no perform cron.schedule).
    expect(M).not.toMatch(/perform\s+cron\.schedule/);
    expect(M).not.toMatch(/^\s*create extension if not exists pg_cron;/m);
    expect(M).toContain('NOT scheduled automatically');
    // The exact hourly activation + inspect + disable commands are documented.
    expect(M).toContain("cron.schedule('dispute-deadline-alerts', '0 * * * *'");
    expect(M).toContain('select app_private.process_dispute_deadline_alerts();');
    expect(M).toContain("cron.unschedule(jobid) from cron.job where jobname = 'dispute-deadline-alerts'");
    expect(M).toContain('cron.job_run_details');
  });
});

describe('0062 processor limit is bounded (zero/negative/excessive safe)', () => {
  it('caps the batch limit between 1 and 1000', () => {
    expect(fn('app_private.process_dispute_deadline_alerts')).toContain('limit least(greatest(coalesce(p_limit, 200), 1), 1000)');
  });
});

describe('0062 audit widening enforces the actor invariant', () => {
  it('allows a null actor ONLY for system escalation; human actions require an actor', () => {
    expect(M).toContain('alter table public.dispute_support_audit alter column actor_account_id drop not null');
    expect(M).toContain("check (actor_account_id is not null or action_type = 'escalated')");
    expect(M).toContain("'escalated'));"); // action type widened
  });
});

describe('0062 delivery semantics do not over-claim external delivery', () => {
  it('records in-app alerts as created (delivered/delivered_at reserved for an external channel)', () => {
    expect(M).toContain("delivery_state text not null default 'created' check (delivery_state in ('created', 'pending', 'delivered', 'failed'))");
    expect(M).not.toMatch(/'notification', 'delivered', v_now/);
    expect(M).not.toMatch(/'escalation', 'delivered', v_now/);
    expect(fn('app_private.process_one_dispute_alert')).toContain("'notification', 'created', null, v_dedupe");
  });
});

describe('0062 escalation surfaces an actionable (not stale) signal', () => {
  it('derives escalation_active from current urgency + non-resolved handling', () => {
    expect(fn('public.support_dispute_queue')).toContain("'escalation_active'");
    expect(fn('public.support_dispute_queue')).toContain("app_private.dispute_urgency(d.evidence_due_at, d.internal_state, v_now) in ('critical', 'overdue')");
    expect(fn('public.support_dispute_queue')).toContain("coalesce(c.handling_status, 'unassigned') <> 'resolved'");
    expect(fn('public.support_dispute_alerts')).toContain("'escalation_active'");
    // Frontend badge uses the derived active signal, not the raw historical flag.
    expect(QUEUE).toContain('r.escalationActive');
    expect(DETAIL).toContain('alerts?.escalation_active');
  });
});

describe('0062 frontend wiring and manual-only language', () => {
  it('repository calls the new RPCs and never calls Stripe', () => {
    for (const rpc of ['support_dispute_alerts', 'support_recheck_dispute_alerts', 'support_dispute_queue']) {
      expect(REPO).toContain(`'${rpc}'`);
    }
    expect(REPO.toLowerCase()).not.toContain('api.stripe.com');
    expect(REPO).not.toMatch(/new Stripe|fetch\(|axios/);
  });
  it('queue urgency + time-remaining come from the server; detail shows manual-only reminder', () => {
    // Queue uses the server urgency + server seconds, never Date.now for classification.
    expect(QUEUE).toContain('r.urgency');
    expect(QUEUE).toContain('r.secondsRemaining');
    expect(QUEUE).not.toMatch(/Date\.now\([^)]*\)[^;]*urgen/i);
    // Detail: urgency label from server, manual submission reminder, recheck action.
    expect(DETAIL).toContain('URGENCY_LABEL[alerts.urgency]');
    expect(DETAIL).toContain('recheckDisputeAlerts');
    expect(DETAIL.toLowerCase()).toContain('manually');
    expect(DETAIL.toLowerCase()).not.toContain('submitted to stripe automatically');
  });
});
