/**
 * Stage 3C2-C1 — scoped transfer PREPARATION (0077) contract proofs.
 *
 * Static/source contracts (no DB). They prove 0077 is ADDITIVE, moves NO money
 * and follows the hardened 3C2 architecture:
 *   - the executor is INERT without the wrapper's transaction-local run+operation
 *     context and is revoked from every client role AND service_role;
 *   - ONE classifier (classify_scoped_transfer) shared by preview and execution;
 *   - processing + NULL provider id maps to provider_lookup_required — never
 *     retryable, never eligible for a new transfer (null provider id ≠ absence);
 *   - execution is READ-ONLY towards financial rows: NO attempt is created (a
 *     queued attempt would be provider-consumable via the global claim upsert),
 *     no earning change, no processing reset, no finalisation call, no worker;
 *   - the protected historical ids appear nowhere in migration or fixtures;
 *   - earning_release and plan_renewal branches are unchanged.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const MIG = join(ROOT, 'supabase', 'migrations');
const M = readFileSync(join(MIG, '0077_scoped_transfer_preparation.sql'), 'utf-8');
const M76 = readFileSync(join(MIG, '0076_scoped_plan_renewal_execution.sql'), 'utf-8');
const stripSql = (s: string): string => s.replace(/--.*$/gm, '');
const M_CODE = stripSql(M);
function fn(src: string, name: string): string {
  const s = src.indexOf(`create or replace function ${name}`);
  if (s < 0) throw new Error(`fn not found: ${name}`);
  return src.slice(s, src.indexOf('\n$$;', s));
}

describe('0077 is additive — 0001–0076 untouched, 0077 highest', () => {
  it('adds 0077; no drops/creates of prior tables; vocabularies are supersets', () => {
    const files = readdirSync(MIG).filter((f) => /^\d{4}_.*\.sql$/.test(f)).map((f) => f.slice(0, 4)).sort();
    expect(files).toContain('0077');
    expect(files[files.length - 1]).toBe('0077');
    expect(M_CODE).not.toMatch(/drop table/i);
    expect(M_CODE).not.toMatch(/create table/i);   // items ledger + attempts reused
    // Every 0075/0076 outcome + action survives (supersets).
    for (const o of ['released', 'already_payable', 'not_yet_eligible', 'issue_held', 'evidence_held',
                     'transfer_already_started', 'renewed_credit_covered', 'renewal_prepared',
                     'closed_zero_occurrences', 'already_renewed', 'action_required_existing',
                     'item_released', 'item_renewed', 'item_prepared',
                     'execution_succeeded', 'execution_partially_succeeded', 'execution_failed']) {
      expect(M, o).toContain(`'${o}'`);
    }
  });
});

describe('0077 executor — inert without run+operation context; all direct grants revoked', () => {
  const e = fn(M, 'app_private.execute_scoped_transfer_preparation');
  it('context gate fires before ANY earning/attempt read or lock; run- and operation-specific', () => {
    const ctxIdx = e.indexOf("current_setting('app.scoped_op_exec_op'");
    const runLockIdx = e.indexOf('from public.financial_operation_runs where id = p_run_id for update');
    const earnLockIdx = e.indexOf('from public.companion_earnings where id = v_rec.id for update');
    expect(ctxIdx).toBeGreaterThan(0);
    expect(ctxIdx).toBeLessThan(runLockIdx);
    expect(ctxIdx).toBeLessThan(earnLockIdx);
    expect(e).toContain("nullif(current_setting('app.scoped_op_exec_op', true), '') is distinct from 'transfer_claim'");
    expect(e).toContain("nullif(current_setting('app.scoped_op_exec_run', true), '') is distinct from p_run_id::text");
    expect(e).toContain('execution_context_required');
  });
  it('executor revoked from PUBLIC, anon, authenticated AND service_role; shared context fn untouched', () => {
    expect(M).toContain('revoke all on function app_private.execute_scoped_transfer_preparation(uuid) from public, anon, authenticated, service_role');
    expect(M).not.toMatch(/grant execute on function app_private\.execute_scoped_transfer_preparation\(uuid\) to/);
    expect(M).not.toContain('create or replace function app_private.begin_scoped_operation_execution');
    expect(M).not.toContain('create or replace function app_private.batch_worker_enabled');
  });
  it('control semantics: scoped_execution only outside production_live; enabled + master inside it; 25 cap; explicit scope', () => {
    expect(e).toContain("v_env = 'production_live'");
    expect(e).toContain("v_ctrl <> 'enabled'");
    expect(e).toContain('production_live_locked');
    expect(e).toContain("v_ctrl <> 'scoped_execution'");
    expect(e).not.toContain("not in ('scoped_execution', 'enabled')");
    expect(e).toContain('empty_scope');
    expect(e).toContain('batch_limit_exceeded');
    expect(e).toContain('max_batch_limit');
  });
});

describe('0077 scope isolation — parent-run scoped_ids only', () => {
  const e = fn(M, 'app_private.execute_scoped_transfer_preparation');
  it('iterates ONLY scoped_ids with deterministic dedup; no payable-earnings candidate query', () => {
    expect(e).toContain('unnest(v_run.scoped_ids)');
    expect(e).toMatch(/row_number\(\) over \(order by first_pos\)/);
    expect(e).not.toMatch(/from public\.companion_earnings\s+e?\s*where\s+e?\.?state\s*=\s*'payable'/i);
    expect(e.toLowerCase()).not.toContain('operation_candidate_ids');
    expect(e).not.toContain('skip locked');
    expect(e).not.toContain('limit 100');
  });
});

describe('0077 moves NO money — the complete provider/worker firewall', () => {
  it('no Stripe/provider/HTTP/pg_net/Edge/cron code anywhere in the migration', () => {
    const lc = M_CODE.toLowerCase();
    for (const bad of ['stripe.', 'sk_live', 'sk_test', 'transfers.create', '/v1/transfers',
                       'pg_net', 'net.http', 'http_post', 'cron.schedule', 'cron.unschedule',
                       'functions/v1', 'x-billing-secret']) {
      expect(lc, bad).not.toContain(bad);
    }
  });
  it('never invokes claim_plan_transfers, any finaliser, recovery or other financial worker', () => {
    const lc = M_CODE.toLowerCase();
    for (const bad of ['claim_plan_transfers', 'finalize_transfer_succeeded', 'finalize_transfer_failed',
                       'finalize_transfer_reversed', 'recover_stale_transfers', 'release_eligible_earnings',
                       'process_plan_renewals', 'claim_payment_refunds', 'run_financial_reconciliation',
                       'process_dispute_deadline_alerts']) {
      expect(lc, bad).not.toContain(bad);
    }
  });
  it('C1 is READ-ONLY towards financial rows: no INSERT/UPDATE/DELETE on attempts, no earning mutation anywhere in 0077', () => {
    const lc = M_CODE.toLowerCase();
    expect(lc).not.toMatch(/insert\s+into\s+public\.companion_transfer_attempts/);
    expect(lc).not.toMatch(/update\s+public\.companion_transfer_attempts/);
    expect(lc).not.toMatch(/delete\s+from\s+public\.companion_transfer_attempts/);
    expect(lc).not.toMatch(/update\s+public\.companion_earnings/);
    expect(lc).not.toMatch(/insert\s+into\s+public\.companion_earnings/);
    expect(lc).not.toContain('stripe_transfer_id =');
    // No queued attempt (or any worker-consumable state) is ever created; the
    // stable key is derivable, never persisted.
    expect(lc).not.toContain("'queued',");
    expect(M).toContain("'stable_key_derivable', true");
  });
  it("REGRESSION (the audited blocker): the global claim treats 'queued' as NON-TERMINAL — its exclusion list omits queued and its upsert flips ANY conflicting attempt to processing. THIS is why C1 creates no queued attempts.", () => {
    const M73 = readFileSync(join(MIG, '0073_financial_operations_control_plane.sql'), 'utf-8');
    const claim = fn(M73, 'public.claim_plan_transfers');
    // The claim's not-exists list excludes ONLY processing/succeeded/failed_permanent…
    expect(claim).toContain("ta.state in ('processing', 'succeeded', 'failed_permanent')");
    expect(claim.slice(claim.indexOf('not exists'), claim.indexOf('order by'))).not.toContain("'queued'");
    // …so a queued attempt does NOT protect its earning, and the upsert would
    // consume it: on conflict (earning_id) → state 'processing' → returned to the
    // Edge Function, which POSTs the provider transfer.
    expect(claim).toContain("on conflict (earning_id) do update set");
    expect(claim).toContain("state = 'processing'");
    expect(claim).toContain('return next');
  });
  it('protected historical identifiers appear nowhere in the migration', () => {
    const lc = M_CODE.toLowerCase();
    for (const bad of ['ba4f943c', '71ecc', '080b', 'acct_1tuhb4dluvn4phj4']) {
      expect(lc, bad).not.toContain(bad);
    }
  });
});

describe('0077 single classifier — shared, read-only, provider-cautious, no secrets', () => {
  const cls = fn(M, 'app_private.classify_scoped_transfer');
  const e = fn(M, 'app_private.execute_scoped_transfer_preparation');
  const pv = fn(M, 'public.support_preview_operation_run');
  it('preview and execution both classify through classify_scoped_transfer', () => {
    expect(M).toContain('create or replace function app_private.classify_scoped_transfer(p_earning_id uuid, p_as_of timestamptz default now())');
    expect(e).toContain('app_private.classify_scoped_transfer(v_rec.id, v_as_of)');
    expect(pv).toContain('app_private.classify_scoped_transfer(d.id, now())');
  });
  it('classifier is stable and mutates nothing', () => {
    const createIdx = M.indexOf('create or replace function app_private.classify_scoped_transfer');
    expect(M.slice(createIdx, M.indexOf('$$', createIdx))).toContain('stable');
    expect(stripSql(cls)).not.toMatch(/insert into|update |delete from/i);
  });
  it('CRITICAL: processing + NULL provider id ⇒ provider_lookup_required (never retryable, never eligible)', () => {
    expect(cls).toContain("v_outcome := 'provider_lookup_required'; v_reason := 'processing_without_provider_id'");
    // The lookup branch never sets eligible and the eligible flag stays false there.
    const branch = cls.slice(cls.indexOf("elsif (ta.id is not null and ta.state = 'processing')"),
                             cls.indexOf("elsif ta.id is not null and ta.state = 'failed_retryable'"));
    expect(branch).not.toContain('v_eligible := true');
    expect(branch).toContain('v_lookup := true');
    // retryable failures are NOT re-armed in C1.
    expect(cls).toContain("'retry_deferred_to_provider_stage'");
  });
  it('mirrors the audited local eligibility (order settled, period paid, connect ready, GBP, holds, payable, net>0)', () => {
    expect(cls).toContain("po.status = 'succeeded'");
    expect(cls).toContain("bp.status = 'paid'");
    expect(cls).toContain('app_private.companion_payments_ready(e.companion_profile_id)');
    expect(cls).toContain("default_currency = 'gbp'");
    expect(cls).toContain('app_private.evidence_hold_blocks_payout(e.booking_id)');
    expect(cls).toContain("i.state <> 'resolved'");
    expect(cls).toContain("e.state <> 'payable'");
    expect(cls).toContain('coalesce(e.net_minor, 0) <= 0');
    expect(cls).toContain("e.transfer_state not in ('not_ready', 'ready', 'failed')");
  });
  it('exposes only support-safe facts — no destination account id, key value, payloads or secrets', () => {
    // Booleans only for sensitive facts.
    expect(cls).toContain("'provider_id_present'");
    expect(cls).toContain("'idempotency_key_present'");
    expect(cls).toContain("'destination_ready'");
    expect(cls).not.toContain("'connected_account_id'");
    expect(cls).not.toContain("'stripe_account_id'");
    expect(cls).not.toContain("'idempotency_key',");
    expect(cls).not.toContain("'stripe_transfer_id'");
    expect(cls).not.toMatch(/client_secret|bank|card_number|access_token/i);
  });
});

describe('0077 per-item containment, outcomes and events', () => {
  const e = fn(M, 'app_private.execute_scoped_transfer_preparation');
  it('per-item savepoints; safe SQLSTATE reasons; auth/run guards above the loop', () => {
    const loopIdx = e.indexOf('for v_rec in');
    const excIdx = e.indexOf('exception when others then', loopIdx);
    expect(excIdx).toBeGreaterThan(loopIdx);
    expect(excIdx).toBeLessThan(e.indexOf('end loop', loopIdx));
    expect(e).toContain('item_exception');
    expect(e.indexOf('execution_context_required')).toBeLessThan(loopIdx);
  });
  it('full outcome vocabulary present; unique item per (run, record); event dedupe + idempotent repeat', () => {
    for (const o of ['eligible_provider_action_required', 'provider_lookup_required', 'already_processing',
                     'already_transferred', 'not_payable', 'held_for_issue', 'evidence_held',
                     'connect_not_ready', 'zero_amount', 'retryable_failure', 'permanent_failure',
                     'reversed', 'not_found', 'invalid_state', 'failed']) {
      expect(M, o).toContain(`'${o}'`);
    }
    expect(e).toContain('on conflict (run_id, record_id) do nothing');
    expect(e).toContain("ev.run_id = p_run_id and ev.action = 'execution_started'");
    expect(e).toContain("if v_run.executed_at is not null or v_run.state = 'completed' or v_run.state = 'failed' then");
    expect(M).toContain("'item_provider_lookup_required'");
    // Eligible earnings record REVIEW-required — never that work was staged/queued.
    expect(M).toContain("'item_review_required'");
    expect(e).toContain("when 'eligible_provider_action_required' then 'item_review_required'");
    // No event vocabulary claims a provider transfer was created or prepared.
    expect(M_CODE.toLowerCase()).not.toContain('transfer_created');
    const eLc = stripSql(e).toLowerCase();
    expect(eLc).not.toContain("'item_prepared'");
  });
});

describe('0077 wrapper + preview — exact 0076 bodies; only the transfer_claim branch added', () => {
  const w = fn(M, 'public.support_execute_operation_run');
  const w76 = fn(M76, 'public.support_execute_operation_run');
  const pv = fn(M, 'public.support_preview_operation_run');
  it('shared guard prefix + earning_release + plan_renewal branches are byte-identical to 0076 (modulo whitespace/comments)', () => {
    const strip = (s: string) => stripSql(s).replace(/\s+/g, ' ');
    const seg = (src: string) => src.slice(
      src.indexOf('if not app_private.is_support_admin()'),
      src.indexOf("raise exception 'scope_required: scoped_execution requires explicit record ids';"));
    expect(strip(seg(w))).toBe(strip(seg(w76)));
    for (const branch of ["if v_control = 'earning_release' then", "if v_control = 'plan_renewal' then"]) {
      const cut = (src: string) => { const a = src.indexOf(branch); return src.slice(a, src.indexOf('end if;', a)); };
      expect(strip(cut(w))).toBe(strip(cut(w76)));
    }
    expect(w).toContain("if v_control = 'transfer_claim' then");
    expect(w).toContain("perform app_private.begin_scoped_operation_execution(p_run_id, 'transfer_claim')");
    expect(w).toContain('return app_private.execute_scoped_transfer_preparation(p_run_id)');
    expect(w).toContain('stage_not_enabled');
  });
  it('preview adds only the classifier branch; other branches intact; side-effect-free (no claim/attempt/state change)', () => {
    expect(pv).toContain("elsif v_run.operation_type = 'transfer_claim' then");
    expect(pv).toContain('app_private.classify_earning_release(d.id)');
    expect(pv).toContain('app_private.classify_plan_renewal(d.id, now())');
    expect(pv).toContain('app_private.operation_preview_rows');
    expect(stripSql(pv)).not.toMatch(/insert into public\.companion_transfer_attempts/i);
    expect(stripSql(pv)).not.toMatch(/update public\.(companion_earnings|companion_transfer_attempts)/i);
    expect(pv).not.toContain('financial_operation_run_items');
  });
  it('0077 does not redefine any 0075/0076 executor or classifier', () => {
    for (const f of ['execute_scoped_earning_release', 'classify_earning_release',
                     'execute_scoped_plan_renewal', 'classify_plan_renewal']) {
      expect(M).not.toContain(`create or replace function app_private.${f}`);
    }
  });
});

describe('0077 reconciliation interface (C1 contract only) + reload', () => {
  it('the repository lookup contract exists with the required classifications and a stub (no live provider code)', () => {
    const rec = readFileSync(join(ROOT, 'src', 'repositories', 'transferProviderReconciliation.ts'), 'utf-8');
    for (const c of ['provider_transfer_found_matching', 'provider_transfer_not_found',
                     'provider_transfer_found_mismatch', 'provider_lookup_ambiguous', 'provider_lookup_failed']) {
      expect(rec, c).toContain(c);
    }
    expect(rec).toContain('StubTransferProviderLookup');
    expect(rec).toContain('NEVER proves provider absence');
    // Not durable permission: documented + no persistence of 'not found'.
    expect(rec.replace(/\s*\n\s*\*\s*/g, ' ')).toContain('FRESH lookup immediately before creation');
    expect(rec.toLowerCase()).not.toContain("from 'stripe'");
    expect(rec).not.toMatch(/fetch\(|axios|https?:\/\/api\.stripe/i);
  });
  it('reloads PostgREST', () => {
    expect(M).toContain("select pg_notify('pgrst', 'reload schema')");
  });
});
