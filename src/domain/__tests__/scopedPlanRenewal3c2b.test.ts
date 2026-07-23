/**
 * Stage 3C2-B — scoped plan-renewal execution (0076) contract proofs.
 *
 * Static/source contracts (no DB). They prove 0076 is ADDITIVE and follows the
 * hardened Stage 3C2-A architecture:
 *   - the record-scoped executor is INERT without the wrapper's transaction-local
 *     run+operation context and is revoked from every client role AND service_role;
 *   - ONE classifier (classify_plan_renewal) is shared by preview and execution;
 *   - the state transition is the EXISTING authoritative renew_plan_billing_period
 *     (0043) — never reimplemented; process_plan_renewals is never invoked;
 *   - no due-plan candidate query can expand the approved scope; empty scope never
 *     becomes global selection; the 25-record cap holds;
 *   - card-funded renewals stop at the existing safe pending state: no Stripe,
 *     no pg_net/HTTP, no cron, no fabricated provider success;
 *   - per-item savepoint containment; deduplicated audit events;
 *   - earning_release behaviour is unchanged.
 * Behaviour is proven functionally on scratch Postgres and in the hosted block.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const MIG = join(ROOT, 'supabase', 'migrations');
const M = readFileSync(join(MIG, '0076_scoped_plan_renewal_execution.sql'), 'utf-8');
const M75 = readFileSync(join(MIG, '0075_scoped_earning_release_execution.sql'), 'utf-8');
const stripSql = (s: string): string => s.replace(/--.*$/gm, '');
const M_CODE = stripSql(M);
function fn(src: string, name: string): string {
  const s = src.indexOf(`create or replace function ${name}`);
  if (s < 0) throw new Error(`fn not found: ${name}`);
  return src.slice(s, src.indexOf('\n$$;', s));
}

describe('0076 is additive — 0001–0075 untouched, 0076 highest', () => {
  it('adds 0076 and never drops/replaces a prior table or migration', () => {
    const files = readdirSync(MIG).filter((f) => /^\d{4}_.*\.sql$/.test(f)).map((f) => f.slice(0, 4)).sort();
    expect(files).toContain('0076');
    // (Later stages add higher-numbered migrations additively; 0076 stays immutable.)
    expect(files.indexOf('0076')).toBeGreaterThan(files.indexOf('0075'));
    expect(M_CODE).not.toMatch(/drop table/i);
    // Vocabulary extensions are supersets: every 0075 outcome/action survives.
    for (const o of ['released', 'already_payable', 'not_found', 'not_yet_eligible', 'issue_held',
                     'evidence_held', 'reversed', 'transfer_already_started', 'invalid_state', 'failed',
                     'item_released', 'item_skipped', 'item_failed',
                     'execution_succeeded', 'execution_partially_succeeded', 'execution_failed']) {
      expect(M, o).toContain(`'${o}'`);
    }
  });
  it('reuses financial_operation_run_items — no operation-specific duplicate ledger', () => {
    expect(M_CODE).not.toMatch(/create table/i);
  });
});

describe('0076 executor — inert without run+operation context; every direct grant revoked', () => {
  const e = fn(M, 'app_private.execute_scoped_plan_renewal');
  it('context gate fires before ANY plan read/lock/mutation and is run- + operation-specific', () => {
    const ctxIdx = e.indexOf("current_setting('app.scoped_op_exec_op'");
    const runLockIdx = e.indexOf('from public.financial_operation_runs where id = p_run_id for update');
    const planLockIdx = e.indexOf('from public.conversation_plans where id = v_rec.id for update');
    expect(ctxIdx).toBeGreaterThan(0);
    expect(ctxIdx).toBeLessThan(runLockIdx);
    expect(ctxIdx).toBeLessThan(planLockIdx);
    expect(e).toContain("nullif(current_setting('app.scoped_op_exec_op', true), '') is distinct from 'plan_renewal'");
    expect(e).toContain("nullif(current_setting('app.scoped_op_exec_run', true), '') is distinct from p_run_id::text");
    expect(e).toContain('execution_context_required');
  });
  it('executor is revoked from PUBLIC, anon, authenticated AND service_role with no compensating grant', () => {
    expect(M).toContain('revoke all on function app_private.execute_scoped_plan_renewal(uuid) from public, anon, authenticated, service_role');
    expect(M).not.toMatch(/grant execute on function app_private\.execute_scoped_plan_renewal\(uuid\) to/);
  });
  it('does NOT redefine the shared context fn, batch_worker_enabled or begin_scoped_execution', () => {
    expect(M).not.toContain('create or replace function app_private.begin_scoped_operation_execution');
    expect(M).not.toContain('create or replace function app_private.batch_worker_enabled');
    expect(M).not.toContain('create or replace function app_private.begin_scoped_execution(');
  });
});

describe('0076 scope isolation — explicit ids only, 25 cap, no due-plan expansion', () => {
  const e = fn(M, 'app_private.execute_scoped_plan_renewal');
  it('iterates ONLY the parent run scope with deterministic dedup; empty scope rejected', () => {
    expect(e).toContain('unnest(v_run.scoped_ids)');
    expect(e).toMatch(/row_number\(\) over \(order by first_pos\)/);
    expect(e).toContain('empty_scope');
    expect(e).toContain('batch_limit_exceeded');
    expect(e).toContain("v_run.scope_type <> 'record_ids'");
    expect(e).toContain('max_batch_limit');
  });
  it('never selects due plans — no candidate query over active/billing plans', () => {
    expect(e).not.toMatch(/from public\.conversation_plans\s+p?\s*where\s+p?\.?status\s*=\s*'active'/i);
    expect(e.toLowerCase()).not.toContain('operation_candidate_ids');
    expect(e).not.toContain('limit 100');
  });
  it('never invokes the global worker or any other financial worker', () => {
    const lc = stripSql(e).toLowerCase();
    for (const bad of ['process_plan_renewals', 'release_eligible_earnings', 'claim_plan_transfers',
                       'claim_payment_refunds', 'finalize_transfer', 'finalize_refund', 'recover_stale',
                       'run_financial_reconciliation', 'process_dispute_deadline_alerts']) {
      expect(lc, bad).not.toContain(bad);
    }
  });
});

describe('0076 control/environment semantics (identical to 0075)', () => {
  const e = fn(M, 'app_private.execute_scoped_plan_renewal');
  it('enabled is NEVER accepted outside production_live; production_live needs op + master', () => {
    expect(e).toContain("v_env = 'production_live'");
    expect(e).toContain("v_ctrl <> 'enabled'");
    expect(e).toContain("effective_control_state('production_live_operations') <> 'enabled'");
    expect(e).toContain('production_live_locked');
    expect(e).toContain("v_ctrl <> 'scoped_execution'");
    expect(e).not.toContain("not in ('scoped_execution', 'enabled')");
  });
});

describe('0076 single classifier — shared by preview and execution, read-only, no secrets', () => {
  const cls = fn(M, 'app_private.classify_plan_renewal');
  const e = fn(M, 'app_private.execute_scoped_plan_renewal');
  const pv = fn(M, 'public.support_preview_operation_run');
  it('preview and execution both classify through classify_plan_renewal', () => {
    expect(M).toContain('create or replace function app_private.classify_plan_renewal(p_plan_id uuid, p_as_of timestamptz default now())');
    expect(e).toContain('app_private.classify_plan_renewal(v_rec.id, v_as_of)');
    expect(pv).toContain('app_private.classify_plan_renewal(d.id, now())');
  });
  it('classifier is stable (read-only), computes the exact period key + authoritative pricing, mutates nothing', () => {
    const createIdx = M.indexOf('create or replace function app_private.classify_plan_renewal');
    const header = M.slice(createIdx, M.indexOf('$$', createIdx));
    expect(header).toContain('stable');
    expect(cls).toContain("date_trunc('month', p_as_of)::date");
    expect(cls).toContain('app_private.monthly_period_end');
    expect(cls).toContain('plan_schedule_slots');
    expect(cls).toContain('(v_gross * 10) / 100');                       // authoritative 10% plan discount
    expect(stripSql(cls)).not.toMatch(/insert into|update |delete from/i);
    // Credit prediction is capped at the period net — never the full balance.
    expect(cls).toContain('least(v_credit, v_net)');
    // No payment-method identifiers / provider ids / secrets (amount fields like
    // card_amount_minor and the boolean payment_method_ready flag are safe).
    expect(cls).not.toMatch(/stripe_customer_id|payment_intent|client_secret|card_number|bank|access_token/i);
  });
  it('executor uses eligible-only delegation to the AUTHORITATIVE renew_plan_billing_period (never reimplements it)', () => {
    expect(e).toContain('public.renew_plan_billing_period(v_rec.id, v_period)');
    // The executor itself never writes billing rows directly.
    const lc = stripSql(e).toLowerCase();
    expect(lc).not.toMatch(/insert into public\.plan_billing_periods/);
    expect(lc).not.toMatch(/insert into public\.payment_orders/);
    expect(lc).not.toMatch(/update public\.plan_billing_periods/);
    expect(lc).not.toMatch(/update public\.payment_orders/);
    expect(lc).not.toContain('spend_account_credit');                    // credit path lives inside the authority
    expect(lc).not.toContain('finalise_paid_order');                     // settlement path lives inside the authority
  });
  it('ONE deterministic as-of instant per run drives every item period', () => {
    expect(e).toContain('v_as_of := now();');
    expect(e).toContain("v_period := date_trunc('month', v_as_of)::date");
  });
});

describe('0076 provider boundary — no Stripe, no HTTP, no cron, no fabricated success', () => {
  it('the whole migration is free of provider/cron/network code', () => {
    // The classifier's read of stripe_customers.payment_method_ready is a local
    // READINESS flag read (no provider call) — exclude the table name, then require
    // every other provider/network/cron signature to be absent.
    const lc = M_CODE.toLowerCase().replaceAll('stripe_customers', 'pm_readiness_table');
    for (const bad of ['stripe', 'sk_live', 'sk_test', 'payment_intent', 'client_secret',
                       'pg_net', 'net.http', 'http_post', 'cron.schedule', 'cron.unschedule',
                       'ba4f943c']) {
      expect(lc, bad).not.toContain(bad);
    }
  });
  it("never marks an order/period paid itself — 'paid' appears only in classification/derivation, not in a write", () => {
    expect(M_CODE).not.toMatch(/set\s+status\s*=\s*'paid'/i);
    expect(M_CODE).not.toMatch(/set\s+status\s*=\s*'succeeded'/i);
  });
});

describe('0076 per-item containment + outcome vocabulary + events', () => {
  const e = fn(M, 'app_private.execute_scoped_plan_renewal');
  it('each plan runs in its own savepoint; contained failures record a safe SQLSTATE reason', () => {
    const loopIdx = e.indexOf('for v_rec in');
    const excIdx = e.indexOf('exception when others then', loopIdx);
    const endLoopIdx = e.indexOf('end loop', loopIdx);
    expect(excIdx).toBeGreaterThan(loopIdx);
    expect(excIdx).toBeLessThan(endLoopIdx);
    expect(e).toContain('item_exception');
    expect(e).toContain("substr(coalesce(nullif(sqlstate, ''), 'XXXXX'), 1, 5)");
    // Auth/context/run guards sit ABOVE the loop and abort the whole request.
    expect(e.indexOf('execution_context_required')).toBeLessThan(loopIdx);
    expect(e.indexOf('not_found: run')).toBeLessThan(loopIdx);
  });
  it('items carry the full plan-renewal outcome vocabulary + one row per (run, plan)', () => {
    for (const o of ['renewed_credit_covered', 'renewal_prepared', 'closed_zero_occurrences',
                     'already_renewed', 'action_required_existing', 'payment_failed_existing',
                     'plan_not_active', 'plan_paused', 'plan_ended', 'billing_not_enabled', 'not_recurring']) {
      expect(M, o).toContain(`'${o}'`);
    }
    expect(e).toContain('on conflict (run_id, record_id) do nothing');
    expect(e).toContain("'plan_renewal', v_rec.id, v_rec.ordinal");
  });
  it('events: item_renewed/item_prepared added additively; execution_started + terminal events deduplicated', () => {
    expect(M).toContain("'item_renewed', 'item_prepared'");
    expect(e).toContain("e.run_id = p_run_id and e.action = 'execution_started'");
    for (const a of ['execution_succeeded', 'execution_partially_succeeded', 'execution_failed']) {
      expect(e, a).toContain(`'${a}'`);
    }
    // Idempotent second execution returns the durable result (no re-run, no event dup).
    expect(e).toContain("if v_run.executed_at is not null or v_run.state = 'completed' or v_run.state = 'failed' then");
  });
  it('safe details expose only non-secret billing summaries', () => {
    expect(e).toContain("'period_start', v_period");
    expect(e).toContain("'card_amount_minor', v_bp.card_amount_minor");
    expect(e).toContain("'provider_action_required'");
    expect(e).not.toMatch(/stripe|payment_intent|client_secret|card_number|bank/i);
  });
});

describe('0076 wrapper + preview — from the EXACT 0075 bodies; only plan_renewal branches added', () => {
  const w = fn(M, 'public.support_execute_operation_run');
  const w75 = fn(M75, 'public.support_execute_operation_run');
  const pv = fn(M, 'public.support_preview_operation_run');
  const pv75 = fn(M75, 'public.support_preview_operation_run');
  it('wrapper keeps every 0074/0075 guard + the control_blocked structured contract + the earning_release branch unchanged', () => {
    for (const g of ['not_found: run', 'invalid_token', 'already_executed', 'run_cancelled', 'run_expired',
                     'not_executable', 'confirmation_required',
                     "if v_state in ('disabled', 'dry_run_only') then", "action = 'control_blocked'",
                     "'code', case when v_state = 'disabled' then 'control_disabled' else 'dry_run_only' end",
                     "if v_state = 'scoped_execution' and v_run.scope_type <> 'record_ids' then",
                     "perform app_private.begin_scoped_operation_execution(p_run_id, 'earning_release')",
                     'return app_private.execute_scoped_earning_release(p_run_id)',
                     'stage_not_enabled']) {
      expect(w, g).toContain(g);
    }
    // The ONLY addition: the plan_renewal branch (context then delegate).
    expect(w).toContain("if v_control = 'plan_renewal' then");
    expect(w).toContain("perform app_private.begin_scoped_operation_execution(p_run_id, 'plan_renewal')");
    expect(w).toContain('return app_private.execute_scoped_plan_renewal(p_run_id)');
    // The SHARED GUARD PREFIX (everything before the operation branches) is
    // byte-for-byte the 0075 body modulo whitespace/comments: compare from the
    // is_support_admin guard to the scope_required guard inclusive.
    const strip = (s: string) => stripSql(s).replace(/\s+/g, ' ');
    const seg = (src: string) => {
      const a = src.indexOf('if not app_private.is_support_admin()');
      const b = src.indexOf("raise exception 'scope_required: scoped_execution requires explicit record ids';");
      return src.slice(a, b);
    };
    expect(strip(seg(w))).toBe(strip(seg(w75)));
    // And the earning_release branch itself is identical to 0075's.
    const branch = (src: string) => {
      const a = src.indexOf("if v_control = 'earning_release' then");
      const b = src.indexOf('end if;', a);
      return src.slice(a, b);
    };
    expect(strip(branch(w))).toBe(strip(branch(w75)));
  });
  it('preview adds ONLY the classifier-driven plan_renewal branch; earning_release + generic branches unchanged; side-effect-free', () => {
    expect(pv).toContain("elsif v_run.operation_type = 'plan_renewal' then");
    expect(pv).toContain('app_private.classify_plan_renewal(d.id, now())');
    expect(pv).toContain('app_private.classify_earning_release(d.id)');          // 0075 branch intact
    expect(pv).toContain('app_private.operation_preview_rows');                  // other ops unchanged
    expect(pv).not.toContain('insert into public.financial_operation_run_items');
    expect(stripSql(pv)).not.toMatch(/insert into public\.(plan_billing_periods|payment_orders|credit_ledger|package_credit_ledger)/i);
    expect(stripSql(pv)).not.toMatch(/update public\.(conversation_plans|plan_billing_periods|payment_orders|credit_ledger)/i);
    expect(pv).toContain("'preview_generated'");
    // First-occurrence dedup ordering preserved.
    expect(pv75).toContain('min(u.pos) as first_pos');
    expect(pv).toContain('min(u.pos) as first_pos');
  });
  it('earning_release executor and classifier are NOT redefined by 0076', () => {
    expect(M).not.toContain('create or replace function app_private.execute_scoped_earning_release');
    expect(M).not.toContain('create or replace function app_private.classify_earning_release');
  });
});

describe('0076 uniqueness + reload', () => {
  it('relies on the existing unique(plan_id, period_start) + order idempotency (does not weaken them) and reloads PostgREST', () => {
    // 0076 must not drop or alter those uniqueness constraints.
    expect(M_CODE).not.toMatch(/drop constraint.*(plan_billing_periods|payment_orders)/i);
    expect(M).toContain("select pg_notify('pgrst', 'reload schema')");
  });
});
