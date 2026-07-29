/**
 * 2G6E-C contracts — financial reconciliation & exception monitoring (0063).
 * Structural proofs that reconciliation is additive and read-only (moves no
 * money, makes no Stripe call), the run/finding/audit models + deterministic
 * dedupe + bounded service-role processor exist, support readers/actions are
 * gated and never edit financial values, the schedule is define-only, alerts are
 * recipient-deduped, audit-actor invariants are enforced, and the frontend
 * repository wires to the intended RPCs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const M = readFileSync(join(ROOT, 'supabase', 'migrations', '0063_financial_reconciliation.sql'), 'utf-8');
const REPO = readFileSync(join(ROOT, 'src', 'repositories', 'financeReconciliationRepository.ts'), 'utf-8');
const QUEUE = readFileSync(join(ROOT, 'src', 'pages', 'InternalReconciliation.tsx'), 'utf-8');
const DETAIL = readFileSync(join(ROOT, 'src', 'pages', 'InternalReconciliationDetail.tsx'), 'utf-8');
function fn(name: string): string {
  const s = M.indexOf(`create or replace function ${name}`);
  if (s < 0) throw new Error(`function not found: ${name}`);
  return M.slice(s, M.indexOf('\n$$;', s));
}

describe('0063 is additive and moves no money', () => {
  it('adds only new tables/columns/functions; never mutates financial rows or calls Stripe', () => {
    expect(M).not.toMatch(/drop\s+table/i);
    expect(M).not.toMatch(/\btruncate\b/i);
    // NEVER writes to money tables.
    for (const t of ['payment_orders', 'companion_earnings', 'companion_transfer_attempts', 'payment_refunds', 'settlement_adjustments', 'payment_disputes']) {
      expect(M).not.toMatch(new RegExp(`update\\s+public\\.${t}\\b`, 'i'));
      expect(M).not.toMatch(new RegExp(`insert\\s+into\\s+public\\.${t}\\b`, 'i'));
      expect(M).not.toMatch(new RegExp(`delete\\s+from\\s+public\\.${t}\\b`, 'i'));
    }
    // No Stripe / outbound calls.
    expect(M.toLowerCase()).not.toContain('stripe.com');
    expect(M).not.toMatch(/net\.http|extensions\.http|http_post/);
    expect(M).toContain("select pg_notify('pgrst', 'reload schema')");
  });
});

describe('0063 run/finding/audit models + constraints', () => {
  it('creates the run, finding and audit tables with RLS and no client policies', () => {
    for (const t of ['financial_reconciliation_runs', 'financial_reconciliation_findings', 'financial_reconciliation_audit']) {
      expect(M).toContain(`create table if not exists public.${t}`);
      expect(M).toContain(`alter table public.${t} enable row level security`);
      expect(M).not.toMatch(new RegExp(`create policy[^\\n]*${t}`));
    }
  });
  it('findings dedupe deterministically on finding_key and carry safe expected/observed jsonb', () => {
    expect(M).toContain('finding_key text not null unique');
    expect(M).toContain('expected jsonb not null default');
    expect(M).toContain('observed jsonb not null default');
    // Explicit finding status vocabulary.
    expect(M).toContain("check (status in ('open', 'acknowledged', 'investigating', 'cleared', 'resolved', 'ignored'))");
    expect(M).toContain("check (severity in ('info', 'warning', 'critical'))");
  });
  it('enforces audit-actor invariants (system-only actions may be actorless)', () => {
    expect(M).toContain("check (actor_account_id is not null\n           or action_type in ('created', 'refreshed', 'reopened', 'cleared'))");
    // A batch run (scheduled/manual/test) may be actorless; an 'entity' recheck must record its actor.
    expect(M).toContain("check (actor_account_id is not null or trigger_type in ('scheduled', 'manual', 'test'))");
    expect(M).toContain("trigger_type text not null check (trigger_type in ('scheduled', 'manual', 'entity', 'test'))");
    expect(M).toContain("scope text not null default 'full' check (scope in ('full', 'entity'))");
    // Recurrence cycle counter participates in the notification dedupe key.
    expect(M).toContain('notify_cycle integer not null default 1');
  });
  it('findings history is never deleted by clients (no delete path); append-only audit', () => {
    expect(M).not.toMatch(/delete\s+from\s+public\.financial_reconciliation_findings/i);
    expect(M).not.toMatch(/delete\s+from\s+public\.financial_reconciliation_audit/i);
    expect(M).not.toMatch(/update\s+public\.financial_reconciliation_audit/i);
  });
});

describe('0063 processor is bounded, service-role-only and deterministic', () => {
  it('caps the batch limit and never lets zero/negative/excessive limits run unbounded', () => {
    expect(fn('app_private.detect_financial_findings')).toContain('limit least(greatest(coalesce(p_limit, 500), 1), 5000)');
  });
  it('processor + detection + helpers are service-role/definer-only (never authenticated)', () => {
    for (const n of ['app_private.detect_financial_findings(uuid[], integer)',
                     'app_private.upsert_frec_finding(uuid, text, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb)',
                     'app_private.write_frec_audit(uuid, text, uuid, jsonb)',
                     'app_private.notify_frec_finding(uuid, text, text, integer)']) {
      expect(M).toContain(`revoke all on function ${n} from public, anon, authenticated`);
    }
    expect(M).toContain('revoke all on function app_private.process_financial_reconciliation(uuid[], integer, text, uuid) from public, anon, authenticated');
    expect(M).toContain('grant execute on function app_private.process_financial_reconciliation(uuid[], integer, text, uuid) to service_role');
    expect(M).not.toMatch(/grant execute on function app_private\.process_financial_reconciliation[^;]*to authenticated/);
    // Both manual entrypoints are service-role only — NEVER exposed to authenticated/anon.
    expect(M).toContain('revoke all on function public.run_financial_reconciliation(integer) from public, anon, authenticated');
    expect(M).toContain('grant execute on function public.run_financial_reconciliation(integer) to service_role');
    expect(M).not.toMatch(/grant execute on function public\.run_financial_reconciliation\(integer\)[^;]*to authenticated/);
    expect(M).toContain('revoke all on function public.run_financial_reconciliation_for_entities(uuid[]) from public, anon, authenticated');
    expect(M).toContain('grant execute on function public.run_financial_reconciliation_for_entities(uuid[]) to service_role');
    expect(M).not.toMatch(/grant execute on function public\.run_financial_reconciliation_for_entities[^;]*to authenticated/);
  });
  it('the fixture entrypoint is entity-scoped, tagged test, and demands entities', () => {
    const e = fn('public.run_financial_reconciliation_for_entities');
    expect(e).toContain('entities_required');
    expect(e).toContain("process_financial_reconciliation(p_entity_ids, 5000, 'test', null)");
  });
  it('BLOCKER GUARD: a bounded/scoped run never clears entities outside its scope', () => {
    const p = fn('app_private.process_financial_reconciliation');
    expect(p).toContain("set status = 'cleared', cleared_at = now()");
    expect(p).toContain("where status in ('open', 'acknowledged', 'investigating')");
    // Entity-scoped clear is restricted to the scanned scope.
    expect(p).toContain('and (p_scope_ids is null or primary_entity_id = any(p_scope_ids))');
    // A FULL run only clears on a complete (non-truncated) scan.
    expect(p).toContain('v_complete := v_scanned < v_cap');
    expect(p).toContain('if p_scope_ids is not null or v_complete then');
    // The clearing loop is guarded on the run identity, not a naked latest_run_id <> current.
    expect(p).toContain('latest_run_id is distinct from v_run');
    // Clear only changes status + cleared_at (ack/assignment fields untouched).
    expect(p).not.toMatch(/set[^;]*acknowledged_by\s*=\s*null/i);
    // Reports whether the scan was complete so operators can trust the clear.
    expect(p).toContain("'complete_scan'");
  });
  it('a resolved/ignored finding is not silently reopened; cleared recurs on a new cycle', () => {
    const u = fn('app_private.upsert_frec_finding');
    // ignored → recurrence recorded but stays ignored and SILENT.
    expect(u).toContain("if v_status = 'ignored' then");
    // resolved OR cleared → reopen a NEW cycle (visible), never a silent revive.
    expect(u).toContain("if v_status in ('resolved', 'cleared') then");
    expect(u).toContain("set status = 'open', cleared_at = null");
    expect(u).toContain('notify_cycle = notify_cycle + 1');
    expect(u).toContain("write_frec_audit(v_id, 'reopened'");
    // Reopen re-notifies on the fresh cycle.
    expect(u).toContain('notify_frec_finding(v_id, p_severity, p_type, v_cycle + 1)');
  });
});

describe('0063 support actions are gated and never edit financial values', () => {
  const RPCS: Array<[string, string]> = [
    ['public.support_reconciliation_queue', '()'],
    ['public.support_reconciliation_detail', '(uuid)'],
    ['public.support_assign_finding', '(uuid)'],
    ['public.support_update_finding_status', '(uuid, text, text)'],
    ['public.support_recheck_finding', '(uuid)'],
  ];
  it('every support RPC is definer, search_path empty, is_support_admin gated, revoked from public/anon', () => {
    for (const [name, sig] of RPCS) {
      const body = fn(name);
      expect(body).toContain("security definer set search_path = ''");
      expect(body).toContain('app_private.is_support_admin()');
      expect(M).toContain(`revoke all on function ${name}${sig} from public, anon`);
      expect(M).toContain(`grant execute on function ${name}${sig} to authenticated`);
    }
  });
  it('status update enforces the vocabulary and mandatory reason; never writes financial columns', () => {
    const s = fn('public.support_update_finding_status');
    expect(s).toContain("if p_status not in ('acknowledged', 'investigating', 'resolved', 'ignored')");
    expect(s).toContain('reason_required');
    // Support NEVER edits expected/observed/severity/amounts.
    expect(s).not.toMatch(/set[^;]*\b(expected|observed|severity)\s*=/);
  });
  it('recheck is read-only + entity-scoped: it cannot clear other entities, moves no money', () => {
    const r = fn('public.support_recheck_finding');
    // Recheck resolves the finding's OWN entity and runs an entity-scoped pass.
    expect(r).toContain('select primary_entity_id into v_entity');
    expect(r).toContain("perform app_private.process_financial_reconciliation(array[v_entity], 5000, 'entity', v_actor)");
    expect(r).not.toMatch(/p_amount|p_order|p_transfer_id|p_refund_amount|p_provider_status|p_outcome/);
    // No money-moving worker RPC is called from support code.
    expect(M).not.toMatch(/claim_plan_transfers|claim_payment_refunds|request_payment_refund|record_dispute_funds/i);
  });
});

describe('0063 alerting reuses notifications with recipient + cycle dedupe', () => {
  it('notifies only warning/critical, deduped per recipient per cycle, no secrets/bodies', () => {
    const n = fn('app_private.notify_frec_finding');
    expect(n).toContain("if p_severity not in ('warning', 'critical') then return");
    expect(n).toContain('insert into public.notifications');
    // Dedupe key scopes finding identity + active cycle + severity + recipient. A
    // repeat scan of the same cycle+severity dedupes; a reopen (new cycle) or a
    // severity worsening yields a fresh key → one new notification per recipient.
    expect(n).toContain("v_dedupe := 'frec:' || p_finding::text || ':' || p_cycle::text || ':' || p_severity || ':' || r.account_id::text");
    expect(n).toContain('on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing');
    expect(M).toContain('add column if not exists finding_id uuid');
  });
  it('a worsened severity on an open finding re-notifies (distinct dedupe key)', () => {
    const u = fn('app_private.upsert_frec_finding');
    expect(u).toContain('v_rank_new int := case p_severity when \'critical\' then 3 when \'warning\' then 2 else 1 end');
    expect(u).toContain('v_worse := v_rank_new >');
    expect(u).toContain('if v_worse then perform app_private.notify_frec_finding(v_id, p_severity, p_type, v_cycle); end if;');
  });
});

describe('0063 scheduling is define-only (never activated on apply)', () => {
  it('does not schedule a cron and never touches the dispute-deadline cron', () => {
    // No EXECUTED scheduling (plpgsql perform / DDL create extension) on apply.
    expect(M).not.toMatch(/perform\s+cron\.schedule/);
    expect(M).not.toMatch(/^\s*create extension if not exists pg_cron;/m);
    // Any EXECUTABLE schedule statement (perform/select cron.schedule(...)) must
    // be a comment line (activation docs) — never actually run on apply.
    for (const line of M.split('\n')) {
      if (/(perform|select)\s+cron\.schedule\(/.test(line)) expect(line.trimStart().startsWith('--')).toBe(true);
    }
    // No executed cron operation of any kind (so the operational dispute cron is untouched).
    expect(M).not.toMatch(/perform\s+cron\./);
    expect(M).toContain('NOT scheduled automatically');
    // Documented activation/inspect/disable commands are present.
    expect(M).toContain("cron.schedule('financial-reconciliation', '0 */6 * * *'");
    expect(M).toContain('cron.job_run_details');
  });
});

describe('0063 invariant accuracy — false-positive / false-negative guards', () => {
  const D = fn('app_private.detect_financial_findings');
  it('earning_stuck_payable is gated on Connect payout readiness (no onboarding false positives)', () => {
    // Only a payout-ready companion can have an expected automatic transfer.
    expect(D).toContain('earning_stuck_payable');
    expect(D).toMatch(/earning_stuck_payable[\s\S]*?exists \(select 1 from public\.connected_accounts ca[\s\S]*?ca\.account_id = e\.companion_account_id[\s\S]*?ca\.payouts_enabled and ca\.charges_enabled\)/);
  });
  it('onboarding-incomplete payable backlog is represented separately + informational', () => {
    expect(D).toContain("'earning_payable_connect_incomplete'");
    expect(D).toMatch(/earning_payable_connect_incomplete[\s\S]*?'info'/);
    // Uses NOT EXISTS on the same readiness predicate, so the two branches partition cleanly.
    expect(D).toMatch(/earning_payable_connect_incomplete[\s\S]*?not exists \(select 1 from public\.connected_accounts ca/);
  });
  it('permanently-failed transfers remain actionable (no silent false negative)', () => {
    expect(D).toContain("'transfer_failed_permanent'");
    expect(D).toMatch(/transfer_failed_permanent[\s\S]*?ta\.state = 'failed_permanent'/);
    expect(D).toMatch(/transfer_failed_permanent[\s\S]*?e\.transfer_state not in \('transferred', 'reversed'\)/);
  });
  it('critical invariants (money at risk) are severity critical', () => {
    for (const crit of ['transfer_missing_provider_id', 'refund_missing_provider_id',
                        'refund_exceeds_card', 'dispute_lost_funds_reinstated']) {
      expect(D).toMatch(new RegExp(`${crit}'[\\s\\S]{0,120}?'critical'`));
    }
  });
  it('detection is a pure read: no writes to any table inside the detection CTE', () => {
    expect(D).not.toMatch(/\b(insert|update|delete)\s+into?\s+public\./i);
  });
});

describe('0063 frontend wiring + no money-movement language', () => {
  it('repository calls the intended RPCs and never calls Stripe', () => {
    for (const rpc of ['support_reconciliation_queue', 'support_reconciliation_detail', 'support_assign_finding',
                       'support_update_finding_status', 'support_recheck_finding']) {
      expect(REPO).toContain(`'${rpc}'`);
    }
    expect(REPO.toLowerCase()).not.toContain('api.stripe.com');
    expect(REPO).not.toMatch(/new Stripe|fetch\(|axios/);
  });
  it('detail clearly states recheck moves no money; expected/observed shown as safe JSON', () => {
    expect(DETAIL.toLowerCase()).toContain('never moves money');
    expect(DETAIL).toContain('f.expected');
    expect(DETAIL).toContain('f.observed');
    expect(QUEUE).toContain('no money is moved');
  });
});
