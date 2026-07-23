/**
 * Stage 3C1 — financial operations control plane (0073) contract proofs.
 *
 * Static/source contracts (no DB). They prove the control plane is ADDITIVE and
 * FINANCIALLY INERT: controls default disabled, every sensitive table forces
 * RLS with no policies, runs are always scoped and batch-capped, previews are
 * side-effect-free, execution is control-gated and — crucially — 0073 invokes
 * NO transfer / refund / dispute / reconciliation worker, calls no Stripe/HTTP,
 * enables no cron, and never touches the protected booking or the 177 findings.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const M = readFileSync(join(ROOT, 'supabase', 'migrations', '0073_financial_operations_control_plane.sql'), 'utf-8');
const APP = readFileSync(join(ROOT, 'src', 'App.tsx'), 'utf-8');

const stripSql = (s: string): string => s.replace(/--.*$/gm, '');
const M_CODE = stripSql(M);
function fn(name: string): string {
  const s = M.indexOf(`create or replace function ${name}`);
  if (s < 0) throw new Error(`0073 fn not found: ${name}`);
  return M.slice(s, M.indexOf('\n$$;', s));
}

describe('0073 tables — controls default disabled, RLS forced, runs scoped, events append-only', () => {
  it('every control seeds at the disabled default and the table default is disabled', () => {
    expect(M).toContain("state text not null default 'disabled'");
    // The 10 controls are seeded WITHOUT an explicit state (⇒ default disabled).
    for (const c of ['earning_release', 'transfer_claim', 'transfer_finalise', 'refund_claim',
                     'refund_finalise', 'plan_renewal', 'dispute_reconciliation',
                     'financial_reconciliation', 'evidence_review_release', 'production_live_operations']) {
      expect(M).toContain(`'${c}'`);
    }
    expect(M).toContain("check (state in ('disabled', 'dry_run_only', 'scoped_execution', 'enabled'))");
  });
  it('forces RLS with no policies on every new table (definer-only)', () => {
    for (const t of ['financial_operations_config', 'financial_operation_controls',
                     'financial_operation_control_events', 'financial_operation_runs',
                     'financial_operation_run_events']) {
      expect(M).toContain(`alter table public.${t} enable row level security`);
      expect(M).toContain(`alter table public.${t} force row level security`);
    }
    expect(M).not.toMatch(/create policy/i);
  });
  it('runs are ALWAYS scoped and batch-capped; no global/unbounded run exists', () => {
    expect(M).toContain('batch_limit integer not null check (batch_limit between 1 and 25)');
    expect(M).toContain('constraint fin_run_scoped check (');
    expect(M).toContain("scope_type = 'record_ids' and array_length(scoped_ids, 1) between 1 and 25");
    expect(M).toContain('idempotency_key text unique');
  });
  it('control + run event logs are append-only (never updated/deleted in 0073)', () => {
    expect(M_CODE).not.toMatch(/update\s+public\.financial_operation_run_events|delete\s+from\s+public\.financial_operation_run_events/i);
    expect(M_CODE).not.toMatch(/update\s+public\.financial_operation_control_events|delete\s+from\s+public\.financial_operation_control_events/i);
  });
});

describe('0073 environment + thresholds — server-owned, named, production-live safe', () => {
  it('models the four environments and defaults away from production_live', () => {
    expect(M).toContain("check (environment in ('development', 'hosted_test', 'production_dry_run', 'production_live'))");
    expect(M).toContain("environment text not null default 'hosted_test'");
  });
  it('names its thresholds rather than hiding bare numbers', () => {
    expect(M).toContain('stale_processing_minutes integer not null default 30');
    expect(M).toContain('stale_refund_minutes integer not null default 30');
    expect(M).toContain('run_expiry_minutes integer not null default 15');
    expect(M).toContain('max_batch_limit integer not null default 25');
    expect(M).toContain('dispute_deadline_warning_hours integer not null default 72');
  });
});

describe('0073 control transition — reasoned, audited, optimistic, phrase-gated', () => {
  const t = fn('public.support_set_financial_control');
  it('is support-gated, requires a reason and an expected-state match', () => {
    expect(t).toContain('if not app_private.is_support_admin() then raise exception');
    expect(t).toContain('reason_required');
    expect(t).toContain('state_mismatch');
    expect(t).toContain('for update');                              // single-winner lock
  });
  it('requires the confirmation phrase to reach any production-live enable', () => {
    expect(t).toContain("c_live_phrase constant text := 'ENABLE-PRODUCTION-LIVE'");
    expect(t).toContain('confirmation_required');
    expect(t).toContain("p_control = 'production_live_operations'");
  });
  it('writes exactly one audit event and runs NO worker', () => {
    expect(t).toContain('insert into public.financial_operation_control_events');
    const lc = stripSql(t).toLowerCase();
    for (const bad of ['claim_plan_transfers', 'make_earning_payable', 'finalize_transfer', 'claim_payment_refunds',
                       'finalize_refund', 'run_financial_reconciliation', 'process_plan_renewals', 'stripe']) {
      expect(lc).not.toContain(bad);
    }
  });
});

describe('0073 request/preview — scope enforced, previews side-effect-free', () => {
  it('request rejects empty/oversized scope and is idempotent on the key', () => {
    const r = fn('public.support_request_operation_run');
    expect(r).toContain('empty_scope');
    expect(r).toContain('batch_limit_exceeded');
    expect(r).toContain('where idempotency_key = p_idempotency_key');   // idempotent
    expect(r).toContain('confirmation_token');                          // opaque token minted
  });
  it('candidate resolution + preview never lock, claim or mutate financial rows', () => {
    const cand = fn('app_private.operation_candidate_ids');
    const rows = fn('app_private.operation_preview_rows');
    const prev = fn('public.support_preview_operation_run');
    // No FOR UPDATE / claim / financial writes in the read-only preview path.
    for (const body of [cand, rows]) {
      expect(body.toLowerCase()).not.toContain('for update');
    }
    for (const body of [cand, rows, prev]) {
      const c = stripSql(body);
      expect(c).not.toMatch(/update\s+public\.companion_earnings|update\s+public\.companion_transfer_attempts|update\s+public\.payment_refunds|update\s+public\.payment_disputes/i);
      expect(c).not.toMatch(/insert\s+into\s+public\.companion_transfer_attempts/i);
      expect(c.toLowerCase()).not.toContain('make_earning_payable');
      expect(c.toLowerCase()).not.toContain('claim_plan_transfers');
    }
    // Preview only writes RUN metadata + a preview_generated event.
    expect(prev).toContain('update public.financial_operation_runs');
    expect(prev).toContain("'preview_generated'");
  });
});

describe('0073 confirm/cancel/execute — token, idempotency, expiry, control-gated', () => {
  it('confirm needs the token, a previewed unexpired run, and is idempotent', () => {
    const c = fn('public.support_confirm_operation_run');
    expect(c).toContain('invalid_token');
    expect(c).toContain('run_expired');
    expect(c).toContain('preview_required');
    expect(c).toContain('already_confirmed');                       // repeat is a no-op
    expect(c).toContain('for update');
  });
  it('execute is control-gated, batch-capped, idempotent, and Stage-3C1 wires only earning_release', () => {
    const e = fn('public.support_execute_operation_run');
    expect(e).toContain('already_executed');                        // repeated confirmation no-op
    expect(e).toContain('effective_control_state');
    expect(e).toContain("'control_blocked'");                       // disabled ⇒ event + raise
    expect(e).toContain('control_disabled');
    expect(e).toContain('execution_not_permitted');                 // dry_run_only rejected
    expect(e).toContain('batch_limit_exceeded');                    // re-checked at execution
    expect(e).toContain("v_control <> 'earning_release'");
    expect(e).toContain('stage_not_enabled');                       // every other worker deferred
    // The ONLY worker it may call is the non-Stripe earning-release path.
    expect(e).toContain('perform app_private.make_earning_payable(v_id)');
    const lc = stripSql(e).toLowerCase();
    for (const bad of ['claim_plan_transfers', 'finalize_transfer', 'claim_payment_refunds', 'finalize_refund',
                       'run_financial_reconciliation', 'process_plan_renewals', 'reconcile_', 'stripe']) {
      expect(lc).not.toContain(bad);
    }
  });
});

describe('0073 readiness — support-only, no secrets', () => {
  const rd = fn('public.support_financial_readiness');
  it('is support-gated and surfaces safe aggregate counts only', () => {
    expect(rd).toContain('if not app_private.is_support_admin() then raise exception');
    expect(rd).toContain("'environment'");
    expect(rd).toContain("'controls'");
    expect(rd).toContain("'recent_runs'");
  });
  it('exposes no secrets, payloads, bank/card or message bodies', () => {
    expect(rd).not.toMatch(/stripe_[a-z_]*id|payload|card|bank|access_token|private_feedback|message_body/i);
  });
});

describe('0073 financial firewall (whole migration) — no worker, Stripe, cron, backfill or protected-row touch', () => {
  it('invokes no transfer/refund/dispute/reconciliation/renewal worker except the gated earning-release', () => {
    const lc = M_CODE.toLowerCase();
    for (const bad of ['claim_plan_transfers', 'finalize_transfer_succeeded', 'finalize_transfer_failed',
                       'finalize_transfer_reversed', 'recover_stale_transfers', 'claim_payment_refunds',
                       'finalize_refund_', 'recover_stale_refunds', 'process_plan_renewals',
                       'run_financial_reconciliation', 'process_financial_reconciliation',
                       'process_dispute_deadline_alerts', 'resolve_unconfirmed_attendance',
                       'release_eligible_earnings', 'reconcile_unresolved_dispute']) {
      expect(lc, bad).not.toContain(bad);
    }
    // make_earning_payable appears ONLY once, inside the execution wrapper.
    expect((M_CODE.match(/make_earning_payable/g) ?? []).length).toBeLessThanOrEqual(1);
  });
  it('makes no Stripe/HTTP call, enables no cron, and stores no secret', () => {
    const lc = M_CODE.toLowerCase();
    for (const bad of ['pg_net', 'net.http', 'http_post', 'extensions.http', 'cron.schedule', 'cron.unschedule',
                       'vault.', 'stripe_secret', 'secret_key', 'sk_live', 'sk_test']) {
      expect(lc, bad).not.toContain(bad);
    }
  });
  it('never backfills history or touches the protected booking / findings', () => {
    // The protected booking may be NAMED in the header comment (documenting that
    // it must not be touched) but must never appear in executable SQL.
    expect(M_CODE).not.toContain('ba4f943c-3e8d-4d4c-900d-fa551ccc5387');
    // No global mutation of financial rows (only run/control tables are written).
    expect(M_CODE).not.toMatch(/update\s+public\.bookings\s+set|update\s+public\.payment_disputes\s+set|update\s+public\.payment_refunds\s+set|delete\s+from\s+public\.companion_earnings/i);
    expect(M).toContain("select pg_notify('pgrst', 'reload schema')");
  });
});

describe('3C1 frontend route — support-only, server-protected, not in normal nav', () => {
  it('mounts /support/operations behind SupportOnly and lazy-loads it', () => {
    expect(APP).toContain("const InternalOperations = lazy(() => import('./pages/InternalOperations'))");
    expect(APP).toContain('<Route path="/support/operations" element={<SupportOnly><InternalOperations /></SupportOnly>} />');
  });
});
