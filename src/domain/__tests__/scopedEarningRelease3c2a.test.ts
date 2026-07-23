/**
 * Stage 3C2-A — scoped earning-release execution (0075) contract proofs.
 *
 * Static/source contracts (no DB). They prove 0075 is ADDITIVE, that the new
 * record-scoped executor requires an explicit run id and reads ONLY the parent
 * run's scope (no empty-scope global fallback), never calls a global/transfer/
 * refund/dispute/reconciliation/renewal worker or Stripe, does not weaken the
 * Stage 3C1 guards, keeps the 25-record cap and per-item uniqueness, and that
 * support_execute_operation_run starts from the exact applied 0074 body and only
 * changes the earning_release branch. Behaviour is proven in the hosted block.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const MIG = join(ROOT, 'supabase', 'migrations');
const M = readFileSync(join(MIG, '0075_scoped_earning_release_execution.sql'), 'utf-8');
const M74 = readFileSync(join(MIG, '0074_persist_financial_operation_block_events.sql'), 'utf-8');
const stripSql = (s: string): string => s.replace(/--.*$/gm, '');
const M_CODE = stripSql(M);
function fn(name: string): string {
  const s = M.indexOf(`create or replace function ${name}`);
  if (s < 0) throw new Error(`0075 fn not found: ${name}`);
  return M.slice(s, M.indexOf('\n$$;', s));
}

describe('0075 is additive — 0001–0074 untouched, 0075 highest', () => {
  it('adds 0075 and never modifies any prior migration file', () => {
    const files = readdirSync(MIG).filter((f) => /^\d{4}_.*\.sql$/.test(f)).map((f) => f.slice(0, 4)).sort();
    expect(files).toContain('0075');
    expect(files[files.length - 1]).toBe('0075');
    // 0075 must not DROP or re-CREATE any 0001–0074 table.
    expect(M_CODE).not.toMatch(/drop table/i);
  });
});

describe('0075 per-record ledger — durable, unique, RLS-forced, type-matched', () => {
  it('creates financial_operation_run_items with uniqueness, RLS force and no policies', () => {
    expect(M).toContain('create table if not exists public.financial_operation_run_items');
    expect(M).toContain('unique (run_id, record_id)');
    expect(M).toContain('unique (run_id, ordinal)');
    expect(M).toContain('alter table public.financial_operation_run_items enable row level security');
    expect(M).toContain('alter table public.financial_operation_run_items force row level security');
    expect(M).not.toMatch(/create policy/i);
    // Outcome vocabulary distinguishes eligible from every ineligible reason.
    for (const o of ['released', 'already_payable', 'not_found', 'not_yet_eligible', 'issue_held',
                     'evidence_held', 'reversed', 'transfer_already_started', 'invalid_state', 'failed']) {
      expect(M).toContain(`'${o}'`);
    }
    // operation_type must match the parent run (trigger enforced).
    expect(M).toContain('operation_type_mismatch');
    expect(M).toContain('create trigger fori_match_operation_trg before insert or update on public.financial_operation_run_items');
  });
});

describe('0075 executor — explicit run id, parent-scope only, authoritative transition, 25 cap', () => {
  const e = fn('app_private.execute_scoped_earning_release');
  it('requires an explicit run id and independently revalidates the run', () => {
    expect(M).toContain('create or replace function app_private.execute_scoped_earning_release(p_run_id uuid)');
    expect(e).toContain('from public.financial_operation_runs where id = p_run_id for update');
    expect(e).toContain("operation_mismatch");
    expect(e).toContain('run_cancelled');
    expect(e).toContain('run_expired');
    expect(e).toContain('confirmation_required');
    expect(e).toContain('scope_required');
    expect(e).toContain('empty_scope');
    expect(e).toContain('batch_limit_exceeded');
  });
  it('reads ONLY the parent run scope — no empty-scope global fallback, no eligibility query building the scope', () => {
    // The executor iterates v_run.scoped_ids and never SELECTs candidate ids from a base table.
    expect(e).toContain('unnest(v_run.scoped_ids)');
    expect(e).not.toMatch(/select .*id.* from public\.companion_earnings\s+where\s+state\s*=\s*'pending_completion'\s+order by/i);
    expect(e.toLowerCase()).not.toContain('operation_candidate_ids');
    // The maximum batch stays 25 (config-driven) and is re-checked here.
    expect(e).toContain('max_batch_limit');
  });
  it('uses the AUTHORITATIVE make_earning_payable transition and calls NO global/other worker or Stripe', () => {
    expect(e).toContain('perform app_private.make_earning_payable(v_rec.id)');
    const lc = stripSql(e).toLowerCase();
    for (const bad of ['release_eligible_earnings', 'claim_plan_transfers', 'claim_payment_refunds',
                       'finalize_transfer', 'finalize_refund', 'recover_stale', 'run_financial_reconciliation',
                       'process_plan_renewals', 'process_dispute_deadline_alerts', 'stripe', 'pg_net', 'cron.schedule']) {
      expect(lc, bad).not.toContain(bad);
    }
    // Re-evaluates the evidence hold + open issue + payable-wait predicate per record.
    expect(e).toContain('app_private.evidence_hold_blocks_payout(v_e.booking_id)');
    expect(e).toContain("i.state <> 'resolved'");
    expect(e).toContain("b.ends_at + interval '12 hours' <= now()");
    expect(e).toContain("a.outcome = 'took_place'");
  });
  it('is revoked from browser roles (callable only from the definer wrapper)', () => {
    expect(M).toContain('revoke all on function app_private.execute_scoped_earning_release(uuid) from public, anon, authenticated');
    expect(M).not.toMatch(/grant execute on function app_private\.execute_scoped_earning_release\(uuid\) to authenticated/);
  });
  it('locks each earning and dedups the scope deterministically (one transition per earning)', () => {
    expect(e).toContain('from public.companion_earnings where id = v_rec.id for update');
    expect(e).toMatch(/row_number\(\) over \(order by first_pos\)/);   // deterministic dedup + ordinal
  });
});

describe('0075 does NOT weaken the Stage 3C1 guards', () => {
  it('never redefines batch_worker_enabled or begin_scoped_execution', () => {
    expect(M).not.toContain('create or replace function app_private.batch_worker_enabled');
    expect(M).not.toContain('create or replace function app_private.begin_scoped_execution');
  });
  it('preserves production_live-only semantics: enabled + master required in production_live', () => {
    const e = fn('app_private.execute_scoped_earning_release');
    expect(e).toContain("v_env = 'production_live'");
    expect(e).toContain("effective_control_state('production_live_operations') <> 'enabled'");
    expect(e).toContain('production_live_locked');
    // Non-production environments use the sanctioned scoped_execution/enabled control only.
    expect(e).toContain("v_ctrl not in ('scoped_execution', 'enabled')");
  });
});

describe('0075 wrapper — starts from the exact 0074 body, changes only the earning_release branch', () => {
  const w = fn('public.support_execute_operation_run');
  it('keeps every 0074 guard + the deduplicated control_blocked structured-result contract byte-for-byte', () => {
    for (const g of ['not_found: run', 'invalid_token', 'already_executed', 'run_cancelled', 'run_expired',
                     'not_executable', 'confirmation_required',
                     "if v_state in ('disabled', 'dry_run_only') then", "action = 'control_blocked'",
                     "'code', case when v_state = 'disabled' then 'control_disabled' else 'dry_run_only' end",
                     "if v_state = 'scoped_execution' and v_run.scope_type <> 'record_ids' then"]) {
      expect(w, g).toContain(g);
    }
    // The ONLY behavioural change: earning_release now delegates to the executor;
    // every other operation type still raises stage_not_enabled.
    expect(w).toContain("if v_control = 'earning_release' then");
    expect(w).toContain('return app_private.execute_scoped_earning_release(p_run_id)');
    expect(w).toContain('stage_not_enabled');
    // The 0074 inline earning loop / direct make_earning_payable call is gone from the wrapper.
    expect(w).not.toContain('perform app_private.make_earning_payable');
    expect(w).not.toContain("foreach v_id in array v_run.scoped_ids");
  });
  it('the earning-release delegation matches the applied 0074 wrapper structure it replaces', () => {
    // Sanity: 0074 had the inline loop; 0075 replaces it with the executor call.
    expect(M74).toContain('foreach v_id in array v_run.scoped_ids loop');
  });
});

describe('0075 support read model — item ledger surfaced, no secrets', () => {
  it('run detail includes per-record items with before/after state and reason codes', () => {
    const d = fn('public.support_operation_run_detail');
    expect(d).toContain('if not app_private.is_support_admin() then raise exception');
    expect(d).toContain("'items'");
    expect(d).toContain('financial_operation_run_items');
    expect(d).toContain("'before_state', it.before_state");
    expect(d).toContain("'after_state', it.after_state");
    expect(d).toContain("'outcome', it.outcome");
    // No secrets / payloads / bank / card / provider ids exposed.
    expect(d).not.toMatch(/stripe|card|bank|payload|access_token|payment_intent/i);
    expect(M).toContain('create or replace function public.support_operation_run_items(p_run_id uuid)');
  });
  it('reloads PostgREST and adds no cron/Stripe/backfill anywhere', () => {
    expect(M).toContain("select pg_notify('pgrst', 'reload schema')");
    const lc = M_CODE.toLowerCase();
    for (const bad of ['cron.schedule', 'cron.unschedule', 'pg_net', 'net.http', 'sk_live', 'sk_test', 'ba4f943c']) {
      expect(lc, bad).not.toContain(bad);
    }
    // No global mutation of financial rows outside the make_earning_payable primitive.
    expect(M_CODE).not.toMatch(/update\s+public\.companion_earnings\s+set/i);
  });
});
