/**
 * Stage 3E-H — hosted payout validation harness contracts
 * (scripts/validate-3e-payouts.mjs). Same source-contract style as
 * c3RolloutScripts.test.ts: behaviour that must hold on the operator's
 * machine is pinned against the script source.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const H = readFileSync(join(ROOT, 'scripts', 'validate-3e-payouts.mjs'), 'utf-8');

describe('3E-H harness: phrase, keys, project and identity guards', () => {
  it('1. every mutating mode requires the exact confirmation phrase', () => {
    expect(H).toContain("const PHRASE = 'VALIDATE-3E-TEST-PAYOUTS'");
    expect(H).toMatch(/MUTATING = \['--preflight', '--prepare-connect', '--prepare-earnings',\s*\n\s*'--enable-isolated-transfers', '--run-transfer-cases', '--restore-controls', '--cleanup'\]/);
    expect(H).toContain("MUTATING.some((m) => args.includes(m)) && argOf('--confirm') !== PHRASE");
  });
  it('2. live Stripe keys are rejected anywhere in the environment', () => {
    expect(H).toContain("v.startsWith('sk_live_')");
    expect(H).toContain("STRIPE_KEY.startsWith('sk_test_')");
  });
  it('3. the wrong Supabase project is rejected', () => {
    expect(H).toContain("const PROJECT_REF = 'gwtunmoefapiiybwlelw'");
    expect(H).toContain('URL_.includes(PROJECT_REF)');
  });
  it('4. fixture identities are unmistakable 3e test accounts (pattern self-check)', () => {
    expect(H).toContain('FIXTURE_EMAIL_RE = /^3e-(coord|member|comp|ops)-[a-z0-9]+@example\\.com$/');
    expect(H).toContain('fixture email failed its own pattern');
  });
  it('5+6. no operator-supplied destination, amount, currency or earning id — everything from snapshot/fixture constants', () => {
    // No CLI flag reads besides --confirm/--confirm-cleanup.
    const flagReads = [...H.matchAll(/argOf\('([^']+)'\)/g)].map((m) => m[1]).sort();
    expect(flagReads).toEqual(['--confirm', '--confirm-cleanup']);
    expect(H).toContain('const TRIAL_MINOR = 700');
    expect(H).toContain('const REGULAR_MINOR = 1600');
    expect(H).toContain('mustUuid(S.cases[key].earningId');
  });
});

describe('3E-H harness: idempotency, checkpointing and control restoration', () => {
  it('7. fixture creation is idempotent (existing snapshot short-circuits)', () => {
    expect(H).toContain('snapshot exists — preflight is idempotent');
    expect(H).toContain('cases complete — prepare-earnings is idempotent');
    expect(H).toContain('reusing existing case (resume)');
    expect(H).toContain('already transferred — skipping (idempotent)');
  });
  it('8. interrupted execution resumes from checkpoint/snapshot', () => {
    expect(H).toContain("const CKPT_FILE = '3e-checkpoint.local.json'");
    expect(H).toContain('checkpoint(step');
    expect(H).toContain('saveSnap(S);'); // snapshot updated after each completed transfer
  });
  it('9. inspection modes are read-only', () => {
    const insp = H.slice(H.indexOf('async function inspect'), H.indexOf('/* -------------------------- verify foundation'));
    expect(insp).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(|deleteUser/);
  });
  it('10. cleanup refuses to remove financial history', () => {
    const cl = H.slice(H.indexOf('async function cleanup'));
    expect(cl).toContain("argOf('--confirm-cleanup') !== 'CLEANUP-3E-FIXTURE'");
    expect(cl).toContain('fixture has financial history');
    expect(cl).toContain('retained by policy; nothing deleted');
    expect(cl).not.toMatch(/\.delete\(/);
  });
  it('11. controls are restored even after a failed matrix step (finally) and restore asserts the resting state', () => {
    expect(H).toMatch(/finally \{\s*\n\s*await setControl\('scoped_execution', 'disabled'\); \/\/ hard restore even on failure/);
    const rc = H.slice(H.indexOf('async function restoreControls'), H.indexOf('/* ------------------------------ inspect'));
    expect(rc).toContain('provider_transfer_amount_ceiling_minor: 0');
    expect(rc).toContain('provider_transfer_daily_ceiling_minor: 0');
    expect(rc).toContain('await assertRestingState()');
  });
  it('12. per-transfer AND daily ceilings are the smallest sufficient values and asserted zero at rest', () => {
    expect(H).toContain('const PER_TRANSFER_CEILING = REGULAR_NET');
    expect(H).toContain('const DAILY_CEILING = REGULAR_NET * MATRIX_TRANSFERS');
    expect(H).toContain("if (cfg.provider_transfer_amount_ceiling_minor !== 0) fail('per-transfer ceiling not 0')");
    expect(H).toContain("if (cfg.provider_transfer_daily_ceiling_minor !== 0) fail('daily ceiling not 0')");
  });
  it('13. allowlist scope is exactly the fixture destination via the audited support RPC', () => {
    expect(H).toContain("ops.rpc('support_set_transfer_destination_allowlist'");
    expect(H).toContain('p_stripe_account_id: S.connected_account_id');
    // and it is deactivated on restore
    expect(H).toMatch(/restoreControls[\s\S]{0,700}p_active: false/);
  });
});

describe('3E-H harness: verifier assertions', () => {
  const v = H.slice(H.indexOf('async function verify()'), H.indexOf('async function report()'));
  it('14. catches duplicate transfers (exactly-one attempt per transferred earning + E10 count)', () => {
    expect(v).toContain('exactly one attempt, succeeded, one provider id');
    expect(v).toContain("check('E10 duplicate run request created NO second transfer', e5Attempts === 1)");
  });
  it('15. catches amount, currency and destination mismatches (local + provider truth)', () => {
    expect(v).toContain('amount/currency/destination match the immutable earning');
    expect(v).toContain('provider transfer livemode=false, amount + destination agree');
  });
  it('16. catches a transfer against an ineligible earning (issue-held: 0 eligible in preview, 0 attempts)', () => {
    expect(v).toContain('E8 open issue prevents transfer (0 eligible in scoped preview, 0 attempts, projection untouched)');
    expect(v).toContain('e8Attempts === 0');
    expect(v).toContain('e8Eligible === 0');
  });
  it('17. confirms issue-held earnings have no transfer and E9 released exactly once via the REAL function', () => {
    expect(v).toContain("e9.state === 'payable'");
    expect(H).toContain("admin.rpc('release_eligible_earnings')");
  });
  it('18+19. package purchase alone has no earning; one completed package call has exactly one', () => {
    expect(v).toContain('E7 one completed plan call -> exactly one earning; unused allowance -> none');
    expect(v).toContain('planEarnings === 1');
  });
  it('economics: trial 0% and regular 5% verified from durable rows', () => {
    expect(v).toContain('E3 trial earning exists exactly once with 0% commission');
    expect(v).toContain('E4 regular earning uses the 5% snapshot');
    expect(v).toContain('E5/E6 credit-only and mixed produce the SAME earning');
  });
  it('deterministic summary line + sentinel + fixture-explained deltas', () => {
    expect(v).toContain('VERIFY RESULT pass=${pass} fail=${failCount}');
    expect(v).toContain('Stage 3C protected sentinel unchanged');
    expect(v).toContain('earning delta fully explained by this fixture');
  });
});

describe('3E-H harness: secrets and evidence hygiene', () => {
  it('21. no secrets in evidence: report excludes passwords/keys/tokens; confirmation token stays in memory', () => {
    const rep = H.slice(H.indexOf('async function report()'), H.indexOf('async function cleanup'));
    expect(rep).not.toMatch(/password|jwt|access_token|service_role|sk_test|confirmation_token/i);
    expect(H).toContain('token stays in process memory');
    expect(H).not.toMatch(/console\.log\([^)]*(SVC|STRIPE_KEY|ANON)\b/);
    expect(H).not.toMatch(/sk_test_[A-Za-z0-9]{8,}|sk_live_[A-Za-z0-9]/);
  });
  it('22. report output is deterministic content written to a local ignored file', () => {
    expect(H).toContain("const REPORT_FILE = '3e-report.local.json'");
    expect(H).toContain('writeFileSync(REPORT_FILE');
    expect(H).toContain('production_blocker');
  });
  it('reuses the REAL production boundaries — no parallel payout implementation', () => {
    for (const real of ['submit_companion_attendance', 'release_eligible_earnings',
      'report_conversation_issue', 'support_request_operation_run', 'support_preview_operation_run',
      'support_confirm_operation_run', 'scoped-stripe-transfers', 'ensure_connect_account',
      'refresh_connect_status', 'get_my_companion_earnings_summary']) {
      expect(H).toContain(real);
    }
    // It must NOT insert directly into earnings or attempts.
    expect(H).not.toMatch(/from\('companion_earnings'\)\s*\.insert/);
    expect(H).not.toMatch(/from\('companion_transfer_attempts'\)\s*\.insert/);
  });
});
