#!/usr/bin/env node
/**
 * Stage 3C2-C3 Gate 7 — inspect the Gate-6 preview run and prepare/confirm
 * exactly ONE transfer_finalise execution run for the fresh fixture earning.
 *
 * DEFAULTS TO INSPECT-ONLY. Confirming requires --confirm-run plus the phrase
 * CONFIRM-ONE-C3-TRANSFER-RUN. The execution run is created idempotently
 * (fixed idempotency key), so re-running can NEVER create a duplicate run.
 *
 * It never: enables a control, changes the ceiling, invokes the Edge
 * Function, contacts Stripe, or creates an attempt/scoped job. The Gate-6
 * preview run is read, never mutated (preview-mode runs can never execute by
 * design: support_execute_operation_run raises `not_executable` for them).
 *
 * Token handling: the confirmation token is NEVER included in the report
 * (stderr). With --emit-token the token alone is printed to STDOUT so the
 * operator can capture it directly into the shell:
 *   $env:CONFIRMATION_TOKEN = node scripts/prepare-c3-transfer-run.mjs `
 *     --confirm-run --confirm "CONFIRM-ONE-C3-TRANSFER-RUN" --emit-token
 *
 * Env (never printed): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * SUPABASE_ANON_KEY. Optional FIXTURE_EMAIL_DOMAIN (default example.com).
 */
import { createClient } from '@supabase/supabase-js';

const PROJECT_REF = 'gwtunmoefapiiybwlelw';
const EARNING = 'd788368c-1989-4f76-95d3-9beae0aa9a6b';        // Gate-6 fresh earning (safe id)
const PREVIEW_RUN = 'de3d076b-b1d8-4eac-8bfa-e8897d1406c8';    // Gate-6 preview run (safe id)
const PROTECTED = ['ba4f943c-3e8d-4d4c-900d-fa551ccc5387', 'acct_1Tuhb4DLUvn4PHJ4'];
const PHRASE = 'CONFIRM-ONE-C3-TRANSFER-RUN';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const argOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const report = (o) => process.stderr.write(`${JSON.stringify(o, null, 2)}\n`);
const fail = (m) => { process.stderr.write(`ABORT: ${m}\n`); process.exit(1); };

for (const [k, v] of Object.entries(process.env)) {
  if (typeof v === 'string' && v.startsWith('sk_live_')) fail(`live key material in env ${k}`);
}
if (PROTECTED.includes(EARNING)) fail('protected id refused');
const URL_ = process.env.SUPABASE_URL ?? '';
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
if (!URL_ || !SVC || !ANON) fail('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY required.');
if (!URL_.includes(PROJECT_REF)) fail(`not project ${PROJECT_REF}`);
const admin = createClient(URL_, SVC, { auth: { persistSession: false } });
const must = (r, w) => { if (r.error) fail(`${w}: ${JSON.stringify(r.error)}`); return r.data; };

async function safeState() {
  const cfg = must(await admin.from('financial_operations_config').select('environment, provider_transfer_amount_ceiling_minor').single(), 'config');
  if (cfg.environment !== 'hosted_test') fail(`environment ${cfg.environment}`);
  if (cfg.provider_transfer_amount_ceiling_minor !== 0) fail('ceiling not 0');
  const ctl = must(await admin.from('financial_operation_controls').select('control_name, state'), 'controls');
  if (!ctl.every((c) => c.state === 'disabled')) fail('a control is not disabled');
  return cfg;
}
async function cleanChecks() {
  const attempts = must(await admin.from('companion_transfer_attempts').select('id').eq('earning_id', EARNING), 'attempts');
  const jobs = must(await admin.from('scoped_transfer_execution_jobs').select('id').eq('earning_id', EARNING), 'jobs');
  const earning = must(await admin.from('companion_earnings').select('state, transfer_state, net_minor, currency').eq('id', EARNING).single(), 'earning');
  return { attempts: attempts.length, scoped_jobs: jobs.length, earning };
}
async function inspectPreviewRun() {
  const run = must(await admin.from('financial_operation_runs')
    .select('operation_type, environment, execution_mode, scope_type, scoped_ids, batch_limit, dry_run, state, reason, requested_by_account_id, requested_at, expires_at, rows_examined, rows_eligible, result_summary')
    .eq('id', PREVIEW_RUN).single(), 'preview run');
  const items = must(await admin.from('financial_operation_run_items').select('id').eq('run_id', PREVIEW_RUN), 'items');
  const events = must(await admin.from('financial_operation_run_events').select('action').eq('run_id', PREVIEW_RUN), 'events');
  return {
    ...run, item_count: items.length, event_actions: events.map((e) => e.action),
    design_note: 'execution_mode=preview => support_execute_operation_run raises not_executable; this run is preview-only by design and stays inert. A fresh execute_scoped run is required.',
  };
}

(async () => {
  await safeState();
  const preview = await inspectPreviewRun();
  const before = await cleanChecks();

  if (!flag('--confirm-run')) {
    report({ mode: 'inspect-only', preview_run: preview, fixture: before,
      next: `re-run with --confirm-run --confirm "${PHRASE}" [--emit-token] to create+confirm the single execution run` });
    return;
  }
  if (argOf('--confirm') !== PHRASE) fail(`--confirm-run requires --confirm "${PHRASE}"`);
  if (before.earning.state !== 'payable' || before.earning.transfer_state !== 'not_ready') fail(`earning not payable/not_ready: ${JSON.stringify(before.earning)}`);
  if (before.attempts !== 0 || before.scoped_jobs !== 0) fail('attempt or scoped job already exists');

  // Fresh ops support user for the sanctioned support surface (the Gate-6 ops
  // user's credential was ephemeral by design).
  const email = `c3-g7-ops-${Date.now().toString(36)}@${process.env.FIXTURE_EMAIL_DOMAIN ?? 'example.com'}`;
  const pw = `Fx!${crypto.randomUUID()}`;
  const u = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (u.error) fail(`ops user: ${u.error.message}`);
  const ops = createClient(URL_, ANON, { auth: { persistSession: false } });
  const si = await ops.auth.signInWithPassword({ email, password: pw });
  if (si.error) fail(`ops sign-in: ${si.error.message}`);
  must(await ops.rpc('ensure_current_account'), 'ensure account');
  must(await admin.from('support_admins').upsert({ account_id: u.data.user.id }, { onConflict: 'account_id', ignoreDuplicates: true }), 'support admin');

  // IDEMPOTENT execution-run request: the fixed key means reruns return the
  // SAME run — a duplicate run is impossible.
  const rq = must(await ops.rpc('support_request_operation_run', {
    p_operation_type: 'transfer_finalise', p_execution_mode: 'execute_scoped', p_scope_type: 'record_ids',
    p_scoped_ids: [EARNING], p_batch_limit: null, p_reason: 'C3 controlled test-mode transfer (Gate 7)',
    p_idempotency_key: `c3-exec-${EARNING}`,
  }), 'request run');
  const runId = rq.run_id; const token = rq.confirmation_token;
  const pv = must(await ops.rpc('support_preview_operation_run', { p_run_id: runId }), 'preview');
  const row = (pv.rows ?? [])[0] ?? {};
  if (row.id !== EARNING || row.found !== true || row.eligible !== true) fail(`preview not eligible: ${JSON.stringify(row)}`);
  if (row.amount_minor !== 950 || String(row.currency).toUpperCase() !== 'GBP') fail(`amount/currency mismatch: ${row.amount_minor} ${row.currency}`);
  const cf = must(await ops.rpc('support_confirm_operation_run', { p_run_id: runId, p_confirmation_token: token }), 'confirm');

  const run = must(await admin.from('financial_operation_runs')
    .select('operation_type, execution_mode, scope_type, scoped_ids, state, expires_at, executed_at').eq('id', runId).single(), 'run verify');
  if (run.state !== 'confirmed' || run.executed_at !== null) fail(`unexpected run state: ${JSON.stringify(run)}`);
  if (JSON.stringify(run.scoped_ids) !== JSON.stringify([EARNING])) fail('scope mismatch');
  const after = await cleanChecks();
  const cfg = await safeState();

  report({
    mode: 'confirm-run',
    preview_run_reused: false,
    reason_new_run_required: 'Gate-6 run is execution_mode=preview (never executable by design).',
    execution_run: { run_id: runId, state: run.state, expires_at: run.expires_at,
      operation_type: run.operation_type, execution_mode: run.execution_mode,
      scope: run.scoped_ids, confirm_result: cf.state ?? cf,
      preview_row: { found: row.found, eligible: row.eligible, outcome: row.outcome, amount_minor: row.amount_minor, currency: row.currency } },
    fixture_after: after,
    state_after: { environment: cfg.environment, ceiling: cfg.provider_transfer_amount_ceiling_minor, controls_all_disabled: true },
    token_note: 'confirmation token NOT shown; use --emit-token to capture it into $env:CONFIRMATION_TOKEN',
  });
  if (flag('--emit-token')) process.stdout.write(token);
})().catch((e) => fail(e?.message ?? String(e)));
