#!/usr/bin/env node
/**
 * Stage 3C2-C3 Gate 8 — ONE-SHOT guarded orchestrator for the single
 * controlled Stripe TEST-MODE transfer.
 *
 * In one process (operator runs ONE command):
 *   1. creates/retrieves the single execute_scoped transfer_finalise run via
 *      the IDEMPOTENT support request (fixed key c3-exec-<earning>) — the
 *      confirmation token stays in process memory, never displayed;
 *   2. confirms the run (idempotent) and re-verifies: confirmed, unexpired,
 *      scope exactly the fixture earning, 950 GBP, correct destination, no
 *      attempt/scoped job, hosted_test, all controls disabled, ceiling 0;
 *   3. try { ceiling := 950 (config; no RPC surface exists for it — service
 *      write, verified); transfer_finalise := scoped_execution via the
 *      sanctioned support_set_financial_control RPC (all other controls
 *      verified disabled); ONE invocation of scoped-stripe-transfers; }
 *      finally { control -> disabled via the RPC, ceiling -> 0, then re-read
 *      and HARD-VERIFY (non-zero exit if restoration fails); }
 *   4. prints ONLY safe fields (never the token, service key or billing
 *      secret; the Stripe transfer id is safe and needed for Gate 9).
 *
 * Refuses: expired run (see --new-key), wrong project, non-hosted_test env,
 * sk_live material, any earning but the fixture's, any destination but the
 * approved test account, amount != 950 GBP, >1 scoped id, pre-existing
 * attempt/scoped job, any enabled control, production master non-disabled.
 *
 * Env (never printed): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * SUPABASE_ANON_KEY, BILLING_WORKER_SECRET. Optional FIXTURE_EMAIL_DOMAIN.
 * --new-key mints a fresh run when the previous idempotent run expired.
 */
import { createClient } from '@supabase/supabase-js';

const PROJECT_REF = 'gwtunmoefapiiybwlelw';
const EARNING = 'd788368c-1989-4f76-95d3-9beae0aa9a6b';
const DEST = 'acct_1Twgq3D8sYj40rhj';
const AMOUNT = 950;
const PHRASE = 'EXECUTE-ONE-TEST-MODE-TRANSFER';
const PROTECTED_DEST = 'acct_1Tuhb4DLUvn4PHJ4';

const args = process.argv.slice(2);
const argOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const say = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const fail = (m) => { console.error(`ABORT: ${m}`); process.exit(1); };

for (const [k, v] of Object.entries(process.env)) {
  if (typeof v === 'string' && v.startsWith('sk_live_')) fail(`live key material in env ${k}`);
}
if (argOf('--confirm') !== PHRASE) fail(`requires --confirm "${PHRASE}"`);
if (DEST === PROTECTED_DEST) fail('protected destination');
const URL_ = process.env.SUPABASE_URL ?? '';
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
const BILLING = process.env.BILLING_WORKER_SECRET ?? '';
if (!URL_ || !SVC || !ANON || !BILLING) fail('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, BILLING_WORKER_SECRET required.');
if (!URL_.includes(PROJECT_REF)) fail(`not project ${PROJECT_REF}`);
const admin = createClient(URL_, SVC, { auth: { persistSession: false } });
const must = (r, w) => { if (r.error) fail(`${w}: ${JSON.stringify(r.error)}`); return r.data; };
// HEAD/count queries return { data: null, count } — never read .data for them.
// A missing count is a HARD SAFE ABORT, never treated as zero.
const safeCount = (r, w) => {
  if (r.error) fail(`${w}: ${JSON.stringify(r.error)}`);
  if (typeof r.count !== 'number') fail(`${w}: count unavailable (null response) — aborting safely`);
  return r.count;
};

async function assertBaseline() {
  const cfg = must(await admin.from('financial_operations_config').select('environment, provider_transfer_amount_ceiling_minor').single(), 'config');
  if (cfg.environment !== 'hosted_test') fail(`environment ${cfg.environment}`);
  if (cfg.provider_transfer_amount_ceiling_minor !== 0) fail('ceiling not 0 at start');
  const ctl = must(await admin.from('financial_operation_controls').select('control_name, state'), 'controls');
  const bad = ctl.filter((c) => c.state !== 'disabled');
  if (bad.length) fail(`non-disabled controls: ${bad.map((c) => `${c.control_name}=${c.state}`).join(', ')}`);
}
async function fixtureClean() {
  const e = must(await admin.from('companion_earnings').select('state, transfer_state, net_minor, currency, companion_account_id').eq('id', EARNING).single(), 'earning');
  if (e.state !== 'payable' || e.transfer_state !== 'not_ready') fail(`earning not payable/not_ready: ${e.state}/${e.transfer_state}`);
  if (e.net_minor !== AMOUNT || e.currency !== 'GBP') fail(`amount/currency mismatch: ${e.net_minor} ${e.currency}`);
  const ca = must(await admin.from('connected_accounts').select('stripe_account_id').eq('account_id', e.companion_account_id).single(), 'destination');
  if (ca.stripe_account_id !== DEST) fail(`destination mismatch: ${ca.stripe_account_id}`);
  const att = must(await admin.from('companion_transfer_attempts').select('id').eq('earning_id', EARNING), 'attempts');
  const jobs = must(await admin.from('scoped_transfer_execution_jobs').select('id').eq('earning_id', EARNING), 'jobs');
  if (att.length || jobs.length) fail(`pre-existing attempt(${att.length})/job(${jobs.length})`);
}
async function opsClient() {
  const email = `c3-g8-ops-${Date.now().toString(36)}@${process.env.FIXTURE_EMAIL_DOMAIN ?? 'example.com'}`;
  const pw = `Fx!${crypto.randomUUID()}`;
  const u = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (u.error) fail(`ops user: ${u.error.message}`);
  const ops = createClient(URL_, ANON, { auth: { persistSession: false } });
  const si = await ops.auth.signInWithPassword({ email, password: pw });
  if (si.error) fail(`ops sign-in: ${si.error.message}`);
  must(await ops.rpc('ensure_current_account'), 'ensure account');
  must(await admin.from('support_admins').upsert({ account_id: u.data.user.id }, { onConflict: 'account_id', ignoreDuplicates: true }), 'support admin');
  return ops;
}
async function setControl(ops, from, to) {
  const cur = must(await admin.from('financial_operation_controls').select('state').eq('control_name', 'transfer_finalise').single(), 'control read').state;
  if (cur === to) return;
  if (from && cur !== from) fail(`transfer_finalise is ${cur}, expected ${from}`);
  must(await ops.rpc('support_set_financial_control', {
    p_control: 'transfer_finalise', p_expected_state: cur, p_new_state: to,
    p_reason: `C3 Gate 8 ${to}`, p_expires_at: null, p_confirmation: null,
  }), `set control ${to}`);
}
async function setCeiling(v) {
  must(await admin.from('financial_operations_config').update({ provider_transfer_amount_ceiling_minor: v }).eq('id', true).select('id'), `ceiling ${v}`);
  const c = must(await admin.from('financial_operations_config').select('provider_transfer_amount_ceiling_minor').single(), 'ceiling verify');
  if (c.provider_transfer_amount_ceiling_minor !== v) fail(`ceiling verify failed (${c.provider_transfer_amount_ceiling_minor} != ${v})`);
}

async function replay() {
  // GATE 10 — idempotency replay of the COMPLETED run. Controls stay disabled
  // and the ceiling stays 0 for the whole replay: the completed-run idempotent
  // branch in begin_scoped_provider_transfer_run returns BEFORE the expiry,
  // control and ceiling gates, and the Edge returns before any item work, so
  // nothing can execute. Same earning, same fixed key, no parameter changes.
  await assertBaseline();   // resting state required: all disabled, ceiling 0
  const pre = {
    attempts: must(await admin.from('companion_transfer_attempts').select('id, state, stripe_transfer_id').eq('earning_id', EARNING), 'attempts'),
    jobs: must(await admin.from('scoped_transfer_execution_jobs').select('id, state, provider_transfer_id').eq('earning_id', EARNING), 'jobs'),
  };
  if (pre.attempts.length !== 1 || pre.attempts[0].state !== 'succeeded') fail(`replay expects exactly one succeeded attempt (${JSON.stringify(pre.attempts)})`);
  if (pre.jobs.length !== 1 || pre.jobs[0].state !== 'finalized_success') fail(`replay expects exactly one finalized job (${JSON.stringify(pre.jobs)})`);
  const providerId = pre.attempts[0].stripe_transfer_id;
  const ops = await opsClient();
  // SAME fixed key -> the SAME completed run + its token (never a new run).
  const rq = must(await ops.rpc('support_request_operation_run', {
    p_operation_type: 'transfer_finalise', p_execution_mode: 'execute_scoped', p_scope_type: 'record_ids',
    p_scoped_ids: [EARNING], p_batch_limit: null, p_reason: 'C3 idempotency replay (Gate 10)',
    p_idempotency_key: `c3-exec-${EARNING}`,
  }), 'request run');
  if (rq.idempotent !== true) fail('expected the idempotent existing run, got a new one');
  const runId = rq.run_id; const token = rq.confirmation_token;
  const evBefore = safeCount(await admin.from('financial_operation_run_events').select('id', { count: 'exact', head: true }).eq('run_id', runId), 'events before');
  const res = await fetch(`${URL_.replace(/\/$/, '')}/functions/v1/scoped-stripe-transfers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SVC, Authorization: `Bearer ${SVC}`, 'x-billing-secret': BILLING },
    body: JSON.stringify({ run_id: runId, confirmation_token: token }),
  });
  let j = null; try { j = await res.json(); } catch { j = null; }
  const post = {
    attempts: must(await admin.from('companion_transfer_attempts').select('id, state, stripe_transfer_id').eq('earning_id', EARNING), 'attempts after'),
    jobs: must(await admin.from('scoped_transfer_execution_jobs').select('id, state, provider_transfer_id').eq('earning_id', EARNING), 'jobs after'),
    run: must(await admin.from('financial_operation_runs').select('state, executed_at').eq('id', runId).single(), 'run after'),
  };
  const evAfter = safeCount(await admin.from('financial_operation_run_events').select('id', { count: 'exact', head: true }).eq('run_id', runId), 'events after');
  const cfg = must(await admin.from('financial_operations_config').select('environment, provider_transfer_amount_ceiling_minor').single(), 'config');
  say({ step: 'replay_result', run_id: runId,
    response: { status: res.status, ok: j?.ok, already_executed: j?.already_executed, error: j?.error },
    attempts_count: post.attempts.length, jobs_count: post.jobs.length,
    provider_id_stable: post.attempts[0]?.stripe_transfer_id === providerId,
    job_provider_id_stable: post.jobs[0]?.provider_transfer_id === providerId,
    run_state: post.run.state, event_count_delta: evAfter - evBefore,
    state: { environment: cfg.environment, ceiling: cfg.provider_transfer_amount_ceiling_minor } });
  if (!(res.status === 200 && j?.already_executed === true)) fail('replay did not return already_executed');
  if (post.attempts.length !== 1 || post.jobs.length !== 1) fail('replay changed attempt/job counts');
  if (post.attempts[0].stripe_transfer_id !== providerId) fail('provider id changed');
  say('REPLAY OK — idempotent, zero new provider/local state.');
}

(async () => {
  if (args.includes('--replay')) { await replay(); return; }
  await assertBaseline();
  await fixtureClean();
  const ops = await opsClient();

  // 1-2: create/retrieve + confirm the SINGLE run (idempotent fixed key).
  const key = args.includes('--new-key') ? `c3-exec-${EARNING}-${Date.now().toString(36)}` : `c3-exec-${EARNING}`;
  const rq = must(await ops.rpc('support_request_operation_run', {
    p_operation_type: 'transfer_finalise', p_execution_mode: 'execute_scoped', p_scope_type: 'record_ids',
    p_scoped_ids: [EARNING], p_batch_limit: null, p_reason: 'C3 controlled test-mode transfer (Gate 8)',
    p_idempotency_key: key,
  }), 'request run');
  const runId = rq.run_id; const token = rq.confirmation_token;   // token: memory only
  let run = must(await admin.from('financial_operation_runs')
    .select('state, expires_at, scoped_ids, execution_mode, operation_type, executed_at').eq('id', runId).single(), 'run read');
  if (new Date(run.expires_at).getTime() - Date.now() < 60_000) {
    fail(`run ${runId} expired/near expiry (${run.expires_at}) — re-run with --new-key`);
  }
  if (run.operation_type !== 'transfer_finalise' || run.execution_mode !== 'execute_scoped') fail('run shape mismatch');
  if (JSON.stringify(run.scoped_ids) !== JSON.stringify([EARNING])) fail(`scope mismatch: ${JSON.stringify(run.scoped_ids)}`);
  if (run.state === 'requested') {
    const pv = must(await ops.rpc('support_preview_operation_run', { p_run_id: runId }), 'preview');
    const row = (pv.rows ?? [])[0] ?? {};
    if (row.id !== EARNING || row.found !== true || row.eligible !== true || row.amount_minor !== AMOUNT) {
      fail(`preview not eligible: ${JSON.stringify({ id: row.id, found: row.found, eligible: row.eligible, amount: row.amount_minor })}`);
    }
  }
  must(await ops.rpc('support_confirm_operation_run', { p_run_id: runId, p_confirmation_token: token }), 'confirm');
  run = must(await admin.from('financial_operation_runs').select('state, expires_at, executed_at').eq('id', runId).single(), 'run verify');
  if (run.state !== 'confirmed' && run.state !== 'executing') fail(`run not confirmed: ${run.state}`);
  if (run.executed_at !== null) fail('run already executed');
  say({ step: 'run_ready', run_id: runId, state: run.state, expires_at: run.expires_at });

  // 3: guarded execution with HARD finally-restoration.
  let invoked = null; let invokeErr = null;
  try {
    await setCeiling(AMOUNT);                       // exact fixture requirement, no higher
    await setControl(ops, 'disabled', 'scoped_execution');
    const others = must(await admin.from('financial_operation_controls').select('control_name, state').neq('control_name', 'transfer_finalise'), 'other controls');
    const bad = others.filter((c) => c.state !== 'disabled');
    if (bad.length) fail(`other controls not disabled: ${bad.map((c) => c.control_name).join(', ')}`);
    say({ step: 'armed', ceiling: AMOUNT, transfer_finalise: 'scoped_execution' });

    const res = await fetch(`${URL_.replace(/\/$/, '')}/functions/v1/scoped-stripe-transfers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SVC, Authorization: `Bearer ${SVC}`, 'x-billing-secret': BILLING },
      body: JSON.stringify({ run_id: runId, confirmation_token: token }),
    });
    let j = null; try { j = await res.json(); } catch { j = null; }
    invoked = { status: res.status, ok: j?.ok, state: j?.state, finalized_count: j?.finalized_count,
      reconciliation_count: j?.reconciliation_count, failed_count: j?.failed_count,
      skipped_count: j?.skipped_count, requested_count: j?.requested_count,
      already_executed: j?.already_executed, error: j?.error };
  } catch (e) {
    invokeErr = e?.message ?? String(e);
  } finally {
    // FINALLY: restore regardless of outcome; verify hard.
    try { await setControl(ops, null, 'disabled'); } catch (e) { console.error(`restore control error: ${e?.message}`); }
    try { await setCeiling(0); } catch (e) { console.error(`restore ceiling error: ${e?.message}`); }
    const ctl = must(await admin.from('financial_operation_controls').select('control_name, state'), 'controls final');
    const cfg = must(await admin.from('financial_operations_config').select('environment, provider_transfer_amount_ceiling_minor').single(), 'config final');
    const restored = ctl.every((c) => c.state === 'disabled') && cfg.provider_transfer_amount_ceiling_minor === 0 && cfg.environment === 'hosted_test';
    say({ step: 'restored', controls_all_disabled: ctl.every((c) => c.state === 'disabled'),
      ceiling: cfg.provider_transfer_amount_ceiling_minor, environment: cfg.environment });
    if (!restored) { console.error('RESTORATION FAILED — resolve manually before anything else.'); process.exitCode = 1; }
  }
  if (invokeErr) fail(`edge invocation error: ${invokeErr}`);
  say({ step: 'execution_result', ...invoked });

  // Safe post-read for Gate 9 (values are non-secret).
  const job = must(await admin.from('scoped_transfer_execution_jobs').select('state, provider_transfer_id, lookup_outcome').eq('earning_id', EARNING).maybeSingle(), 'job');
  const att = must(await admin.from('companion_transfer_attempts').select('state, stripe_transfer_id, amount_minor, currency, completed_at').eq('earning_id', EARNING).maybeSingle(), 'attempt');
  const earn = must(await admin.from('companion_earnings').select('state, transfer_state').eq('id', EARNING).single(), 'earning');
  say({ step: 'post_state', job, attempt: att, earning: earn, run_id: runId });
})().catch((e) => fail(e?.message ?? String(e)));
