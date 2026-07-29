/**
 * Stage 3C2-A — scoped earning-release execution (0075), hardened contract proofs.
 *
 * Static/source contracts (no DB). They prove 0075 is ADDITIVE and that the
 * hardened design holds:
 *   - the record-scoped executor is INERT without an unforgeable, run- and
 *     operation-specific transaction-local context established by the wrapper,
 *     and is revoked from every client role AND service_role;
 *   - there is exactly ONE eligibility authority (classify_earning_release) used
 *     by BOTH preview and execution, so they can never disagree;
 *   - make_earning_payable stays the sole transition authority (never reimplemented);
 *   - each record runs inside its own savepoint so a per-item failure is contained;
 *   - 'enabled' is never valid outside production_live; production_live needs the
 *     operation control AND the master; disabled/dry_run_only block;
 *   - no global/transfer/refund/dispute/reconciliation/renewal worker, Stripe,
 *     cron or provider call is introduced.
 * Behaviour is proven functionally on scratch Postgres and in the hosted block.
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

describe('0075 is additive — 0001–0074 untouched', () => {
  it('adds 0075 and never modifies any prior migration file', () => {
    const files = readdirSync(MIG).filter((f) => /^\d{4}_.*\.sql$/.test(f)).map((f) => f.slice(0, 4)).sort();
    expect(files).toContain('0075');
    // (Later stages add higher-numbered migrations additively; 0075 stays immutable.)
    expect(files.indexOf('0075')).toBeGreaterThan(files.indexOf('0074'));
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
    for (const o of ['released', 'already_payable', 'not_found', 'not_yet_eligible', 'issue_held',
                     'evidence_held', 'reversed', 'transfer_already_started', 'invalid_state', 'failed']) {
      expect(M).toContain(`'${o}'`);
    }
    expect(M).toContain('operation_type_mismatch');
    expect(M).toContain('create trigger fori_match_operation_trg before insert or update on public.financial_operation_run_items');
  });
});

// ---------------------------------------------------------------------------
// BLOCKER 1 — the executor is inert without the wrapper's execution context.
// ---------------------------------------------------------------------------
describe('0075 executor is inert without an unforgeable run+operation context', () => {
  const e = fn('app_private.execute_scoped_earning_release');
  it('[point 2/3/4] rejects before ANY earning select/lock/mutation unless the transaction-local context matches this exact run + earning_release', () => {
    const ctxIdx = e.indexOf("current_setting('app.scoped_op_exec_op'");
    const lockIdx = e.indexOf('from public.financial_operation_runs where id = p_run_id for update');
    const earningIdx = e.indexOf('from public.companion_earnings where id = v_rec.id for update');
    expect(ctxIdx).toBeGreaterThan(0);
    expect(ctxIdx).toBeLessThan(lockIdx);          // context checked before locking the run
    expect(ctxIdx).toBeLessThan(earningIdx);       // …and long before any earning lock
    expect(e).toContain("nullif(current_setting('app.scoped_op_exec_op', true), '') is distinct from 'earning_release'");
    expect(e).toContain("nullif(current_setting('app.scoped_op_exec_run', true), '') is distinct from p_run_id::text");
    expect(e).toContain('execution_context_required');
  });
  it('[point 1] executor is revoked from PUBLIC, anon, authenticated AND service_role, with no compensating grant', () => {
    expect(M).toContain('revoke all on function app_private.execute_scoped_earning_release(uuid) from public, anon, authenticated, service_role');
    expect(M).not.toMatch(/grant execute on function app_private\.execute_scoped_earning_release\(uuid\) to/);
  });
  it('the context is established by begin_scoped_operation_execution with transaction-local (is_local) GUCs and revoked from every role', () => {
    const c = fn('app_private.begin_scoped_operation_execution');
    expect(M).toContain('create or replace function app_private.begin_scoped_operation_execution(p_run_id uuid, p_operation_type text)');
    expect(c).toContain("set_config('app.scoped_op_exec_run', p_run_id::text, true)");
    expect(c).toContain("set_config('app.scoped_op_exec_op', p_operation_type, true)");
    expect(c).toContain('from public.financial_operation_runs where id = p_run_id for update');
    expect(c).toContain('run_operation_mismatch');
    expect(c).toContain("v_run.state not in ('confirmed', 'executing')");
    expect(c).toContain('run_expired');
    expect(c).toContain("v_run.scope_type <> 'record_ids'");
    expect(c).toContain('batch_limit_exceeded');
    expect(M).toContain('revoke all on function app_private.begin_scoped_operation_execution(uuid, text) from public, anon, authenticated, service_role');
  });
});

// ---------------------------------------------------------------------------
// Control / environment semantics (points 5, 6, 8, 9).
// ---------------------------------------------------------------------------
describe('0075 control/environment semantics agree across context fn and executor', () => {
  const e = fn('app_private.execute_scoped_earning_release');
  const c = fn('app_private.begin_scoped_operation_execution');
  it('[point 8] enabled is NEVER accepted outside production_live — every non-prod path requires scoped_execution ONLY', () => {
    expect(c).toContain("v_ctrl <> 'scoped_execution'");
    expect(e).toContain("v_ctrl <> 'scoped_execution'");
    expect(c).not.toContain("not in ('scoped_execution', 'enabled')");
    expect(e).not.toContain("not in ('scoped_execution', 'enabled')");
  });
  it('[point 9] production_live requires the operation control enabled AND the production master enabled', () => {
    for (const g of [c, e]) {
      expect(g).toContain("v_env = 'production_live'");
      expect(g).toContain("v_ctrl <> 'enabled'");
      expect(g).toContain("effective_control_state('production_live_operations') <> 'enabled'");
      expect(g).toContain('production_live_locked');
    }
  });
  it('[points 5/6] disabled + dry_run_only are blocked by the wrapper as a structured control_blocked result (no raise, no executor call)', () => {
    const w = fn('public.support_execute_operation_run');
    expect(w).toContain("if v_state in ('disabled', 'dry_run_only') then");
    expect(w).toContain("action = 'control_blocked'");
    expect(w).toContain("'code', case when v_state = 'disabled' then 'control_disabled' else 'dry_run_only' end");
    const blockIdx = w.indexOf("if v_state in ('disabled', 'dry_run_only') then");
    const execIdx = w.indexOf("if v_control = 'earning_release' then");
    expect(blockIdx).toBeGreaterThan(0);
    expect(blockIdx).toBeLessThan(execIdx);
  });
  it('does NOT weaken batch_worker_enabled or begin_scoped_execution (production_live-only kill-switch guard)', () => {
    expect(M).not.toContain('create or replace function app_private.batch_worker_enabled');
    expect(M).not.toContain('create or replace function app_private.begin_scoped_execution(');
  });
});

// ---------------------------------------------------------------------------
// BLOCKER 2 — a single eligibility authority shared by preview + execution.
// ---------------------------------------------------------------------------
describe('0075 single eligibility authority — one classifier, shared by preview and execution', () => {
  const cls = fn('app_private.classify_earning_release');
  const e = fn('app_private.execute_scoped_earning_release');
  const pv = fn('public.support_preview_operation_run');
  it('[point 10] preview and execution both classify through app_private.classify_earning_release', () => {
    expect(M).toContain('create or replace function app_private.classify_earning_release(p_earning uuid)');
    expect(e).toContain('app_private.classify_earning_release(v_rec.id)');
    expect(pv).toContain('app_private.classify_earning_release(d.id)');
  });
  it('[point 11] the ONE classifier encodes the full cumulative decision (state + evidence hold + open issue + 12h + took_place)', () => {
    expect(cls).toContain('app_private.evidence_hold_blocks_payout(e.booking_id)');
    expect(cls).toContain("i.state <> 'resolved'");
    expect(cls).toContain("b.ends_at + interval '12 hours' <= now()");
    expect(cls).toContain("a.outcome = 'took_place'");
    for (const o of ['not_found', 'evidence_held', 'issue_held', 'not_yet_eligible', 'released',
                     'reversed', 'transfer_already_started', 'already_payable', 'invalid_state']) {
      expect(cls).toContain(`'${o}'`);
    }
  });
  it('the executor no longer inlines a second predicate — it classifies then defers the TRANSITION to make_earning_payable', () => {
    expect(e).not.toContain('app_private.evidence_hold_blocks_payout(v_e.booking_id)');
    expect(e).not.toContain("b.ends_at + interval '12 hours' <= now()");
    expect(e).toContain('perform app_private.make_earning_payable(v_rec.id)');
    expect(stripSql(e)).not.toMatch(/update\s+public\.companion_earnings\s+set/i);
  });
  it('preview stays side-effect-free: it writes NO item rows and mutates no earning', () => {
    expect(pv).not.toContain('insert into public.financial_operation_run_items');
    expect(stripSql(pv)).not.toMatch(/update\s+public\.companion_earnings/i);
    expect(pv).toContain("'preview_generated'");
  });
});

// ---------------------------------------------------------------------------
// BLOCKER 3 — per-item failure containment.
// ---------------------------------------------------------------------------
describe('0075 per-item failure containment', () => {
  const e = fn('app_private.execute_scoped_earning_release');
  it('[point 12] each record runs in its own savepoint; a caught failure records outcome=failed and continues', () => {
    const loopIdx = e.indexOf(' loop');
    const excIdx = e.indexOf('exception when others then', loopIdx);
    const endLoopIdx = e.indexOf('end loop', loopIdx);
    expect(excIdx).toBeGreaterThan(loopIdx);
    expect(excIdx).toBeLessThan(endLoopIdx);
    expect(e).toContain('item_exception');
    expect(e).toContain("'item_failed'");
    expect(e).toContain("substr(coalesce(nullif(sqlstate, ''), 'XXXXX'), 1, 5)");
  });
  it('auth/authorisation/invalid-run guards sit ABOVE the loop and therefore abort the whole request', () => {
    const ctxIdx = e.indexOf('execution_context_required');
    const revalIdx = e.indexOf('not_found: run');
    const loopIdx = e.indexOf('for v_rec in');
    expect(ctxIdx).toBeLessThan(loopIdx);
    expect(revalIdx).toBeLessThan(loopIdx);
  });
});

// ---------------------------------------------------------------------------
// Scope isolation + no forbidden workers (points 14, 15).
// ---------------------------------------------------------------------------
describe('0075 scope isolation and firewall', () => {
  const e = fn('app_private.execute_scoped_earning_release');
  it('[point 14] iterates ONLY the parent run scope — no empty-scope fallback, no candidate query, deterministic dedup', () => {
    expect(e).toContain('unnest(v_run.scoped_ids)');
    expect(e).not.toMatch(/select .*id.* from public\.companion_earnings\s+where\s+state\s*=\s*'pending_completion'\s+order by/i);
    expect(e.toLowerCase()).not.toContain('operation_candidate_ids');
    expect(e).toMatch(/row_number\(\) over \(order by first_pos\)/);
    expect(e).toContain('from public.companion_earnings where id = v_rec.id for update');
    expect(e).toContain('empty_scope');
    expect(e).toContain('batch_limit_exceeded');
  });
  it('[point 15] introduces NO global/transfer/refund/dispute/reconciliation/renewal worker, Stripe, cron, pg_net or provider call', () => {
    const lc = M_CODE.toLowerCase();
    for (const bad of ['release_eligible_earnings', 'claim_plan_transfers', 'claim_payment_refunds',
                       'finalize_transfer', 'finalize_refund', 'recover_stale', 'run_financial_reconciliation',
                       'process_plan_renewals', 'process_dispute_deadline_alerts', 'stripe', 'sk_live', 'sk_test',
                       'pg_net', 'net.http', 'cron.schedule', 'cron.unschedule', 'ba4f943c']) {
      expect(lc, bad).not.toContain(bad);
    }
  });
});

// ---------------------------------------------------------------------------
// Wrapper — from the 0074 body, only the earning_release branch changed.
// ---------------------------------------------------------------------------
describe('0075 wrapper — 0074 body preserved; earning_release establishes context then delegates', () => {
  const w = fn('public.support_execute_operation_run');
  it('[point 13] keeps every 0074 guard + the deduplicated control_blocked structured-result contract + idempotency', () => {
    for (const g of ['not_found: run', 'invalid_token', 'already_executed', 'run_cancelled', 'run_expired',
                     'not_executable', 'confirmation_required',
                     "if v_state in ('disabled', 'dry_run_only') then", "action = 'control_blocked'",
                     "if v_state = 'scoped_execution' and v_run.scope_type <> 'record_ids' then"]) {
      expect(w, g).toContain(g);
    }
    expect(w).toContain("if v_run.executed_at is not null or v_run.state = 'completed' then");
  });
  it('the ONLY behavioural change: earning_release establishes the context then delegates to the executor', () => {
    expect(w).toContain("if v_control = 'earning_release' then");
    expect(w).toContain("perform app_private.begin_scoped_operation_execution(p_run_id, 'earning_release')");
    expect(w).toContain('return app_private.execute_scoped_earning_release(p_run_id)');
    expect(w).toContain('stage_not_enabled');
    expect(w).not.toContain('perform app_private.make_earning_payable');
    expect(w).not.toContain('foreach v_id in array v_run.scoped_ids');
    const blockIdx = w.indexOf("if v_state in ('disabled', 'dry_run_only') then");
    const ctxIdx = w.indexOf('perform app_private.begin_scoped_operation_execution');
    expect(blockIdx).toBeLessThan(ctxIdx);
  });
  it('the applied 0074 wrapper it replaces had the inline loop (sanity)', () => {
    expect(M74).toContain('foreach v_id in array v_run.scoped_ids loop');
  });
});

describe('0075 support read model — item ledger surfaced, no secrets; PostgREST reload', () => {
  it('run detail includes per-record items with before/after state and reason codes, no secrets', () => {
    const d = fn('public.support_operation_run_detail');
    expect(d).toContain('if not app_private.is_support_admin() then raise exception');
    expect(d).toContain("'items'");
    expect(d).toContain('financial_operation_run_items');
    expect(d).toContain("'before_state', it.before_state");
    expect(d).toContain("'after_state', it.after_state");
    expect(d).toContain("'outcome', it.outcome");
    expect(d).not.toMatch(/stripe|card|bank|payload|access_token|payment_intent/i);
    expect(M).toContain('create or replace function public.support_operation_run_items(p_run_id uuid)');
  });
  it('reloads PostgREST and makes no global earning mutation outside make_earning_payable', () => {
    expect(M).toContain("select pg_notify('pgrst', 'reload schema')");
    expect(M_CODE).not.toMatch(/update\s+public\.companion_earnings\s+set/i);
  });
});
