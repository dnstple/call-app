#!/usr/bin/env node
/**
 * Stage 3C2-C3 — guarded invoker for the scoped-stripe-transfers Edge Function.
 *
 * SAFETY DESIGN
 *  - Secrets come ONLY from environment variables; nothing is ever printed,
 *    logged or written to disk. This file contains no credentials.
 *  - Refuses to run when STRIPE-key material looks live (sk_live is banned;
 *    the Edge Function additionally verifies sk_test_ + livemode=false).
 *  - Verifies the Supabase project ref is exactly gwtunmoefapiiybwlelw.
 *  - Verifies financial_operations_config.environment = 'hosted_test'.
 *  - DEFAULTS TO INERT SMOKE-TEST MODE: without --execute plus the explicit
 *    confirmation phrase it only runs the Gate-5 negative security probes,
 *    which must all be REJECTED and must create no job/attempt/transfer.
 *  - Executes at most ONE run (one run_id, ≤5 earnings enforced server-side;
 *    the C3 rollout uses exactly one earning).
 *
 * USAGE
 *  Inert security probes (Gate 5):
 *    SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... BILLING_WORKER_SECRET=... \
 *      node scripts/scoped-transfer-rollout.mjs --smoke
 *
 *  Controlled single-run execution (Gate 8; operator runbook only):
 *    ...same env... RUN_ID=<uuid> CONFIRMATION_TOKEN=<token> \
 *      node scripts/scoped-transfer-rollout.mjs --execute \
 *        --confirm "EXECUTE-ONE-TEST-MODE-TRANSFER"
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BILLING_WORKER_SECRET.
 * Optional env for --execute: RUN_ID, CONFIRMATION_TOKEN.
 * STRIPE_SECRET_KEY must NEVER be given to this script — it is configured only
 * in the Supabase secret manager for the Edge Function itself. If present in
 * the local environment the script refuses to run at all.
 */

const PROJECT_REF = 'gwtunmoefapiiybwlelw';
const CONFIRM_PHRASE = 'EXECUTE-ONE-TEST-MODE-TRANSFER';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const argOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

function fail(msg) { console.error(`ABORT: ${msg}`); process.exit(1); }

// ---- hard safety preconditions -------------------------------------------
if (process.env.STRIPE_SECRET_KEY) {
  fail('STRIPE_SECRET_KEY must not be present in the local environment — it belongs only in the Supabase secret manager.');
}
for (const [k, v] of Object.entries(process.env)) {
  if (typeof v === 'string' && v.startsWith('sk_live_')) fail(`live Stripe key material detected in env var ${k}; refusing to run.`);
}
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const BILLING_SECRET = process.env.BILLING_WORKER_SECRET ?? '';
if (!SUPABASE_URL || !SERVICE_KEY || !BILLING_SECRET) fail('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and BILLING_WORKER_SECRET are required (env only).');
if (!SUPABASE_URL.includes(PROJECT_REF)) fail(`SUPABASE_URL does not reference project ${PROJECT_REF}; refusing to run against any other project.`);

const FN_URL = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/scoped-stripe-transfers`;
const REST = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;

async function rest(path) {
  const res = await fetch(`${REST}${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) fail(`REST ${path} -> ${res.status}`);
  return res.json();
}
async function invoke(body, headers = {}) {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

// ---- environment sentinels ------------------------------------------------
async function assertSafeState() {
  const cfg = await rest('/financial_operations_config?select=environment,provider_transfer_amount_ceiling_minor');
  if (cfg[0]?.environment !== 'hosted_test') fail(`environment is ${cfg[0]?.environment}, not hosted_test.`);
  const controls = await rest('/financial_operation_controls?select=control_name,state');
  const enabled = controls.filter((c) => c.state === 'enabled');
  if (enabled.length > 0) fail(`controls in 'enabled' state: ${enabled.map((c) => c.control_name).join(', ')}`);
  console.log(`state: environment=hosted_test ceiling=${cfg[0].provider_transfer_amount_ceiling_minor} controls_enabled=0`);
  return cfg[0];
}

// ---- Gate 5: inert security probes (must ALL be rejected) -----------------
async function smoke() {
  const probes = [];
  const p = async (name, promise, okWhen) => {
    const r = await promise;
    const ok = okWhen(r);
    probes.push({ name, ok, status: r.status, code: r.json?.error ?? r.json?.code ?? null });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (status=${r.status} code=${r.json?.error ?? r.json?.code ?? '-'})`);
  };
  const ghost = '00000000-0000-0000-0000-00000000dead';
  await p('no billing secret rejected', invoke({ run_id: ghost, confirmation_token: 'x' }), (r) => r.status === 403);
  await p('wrong billing secret rejected', invoke({ run_id: ghost, confirmation_token: 'x' }, { 'x-billing-secret': 'wrong' }), (r) => r.status === 403);
  await p('malformed body rejected', invoke('not-json{{', { 'x-billing-secret': BILLING_SECRET }), (r) => r.status === 400);
  await p('missing credentials rejected', invoke({}, { 'x-billing-secret': BILLING_SECRET }), (r) => r.status === 400);
  await p('random run UUID rejected', invoke({ run_id: ghost, confirmation_token: 'nope' }, { 'x-billing-secret': BILLING_SECRET }), (r) => r.status === 409);
  const jobs = await rest('/scoped_transfer_execution_jobs?select=id&limit=1000');
  console.log(`post-probe scoped job count visible to service role: ${jobs.length} (compare with the Gate-0 snapshot; probes must add none)`);
  if (probes.some((x) => !x.ok)) fail('one or more security probes did not reject as required.');
  console.log('SMOKE OK — every unauthorised/invalid request was rejected.');
}

// ---- Gate 8: controlled single execution ----------------------------------
async function execute() {
  if (argOf('--confirm') !== CONFIRM_PHRASE) fail(`--execute requires --confirm "${CONFIRM_PHRASE}"`);
  const runId = process.env.RUN_ID; const token = process.env.CONFIRMATION_TOKEN;
  if (!runId || !token) fail('RUN_ID and CONFIRMATION_TOKEN env vars are required for --execute.');
  const cfg = await assertSafeState();
  if (!(cfg.provider_transfer_amount_ceiling_minor > 0)) {
    fail('ceiling is 0 — set it to the exact fixture amount (runbook Gate 8) before executing.');
  }
  console.log(`invoking scoped-stripe-transfers once for run ${runId} ...`);
  const r = await invoke({ run_id: runId, confirmation_token: token }, { 'x-billing-secret': BILLING_SECRET });
  // SAFE fields only — never log secrets/destination/idempotency values.
  console.log(`result: status=${r.status} body=${JSON.stringify({
    ok: r.json?.ok, state: r.json?.state, finalized_count: r.json?.finalized_count,
    reconciliation_count: r.json?.reconciliation_count, failed_count: r.json?.failed_count,
    skipped_count: r.json?.skipped_count, requested_count: r.json?.requested_count,
    already_executed: r.json?.already_executed, error: r.json?.error,
  })}`);
}

(async () => {
  await assertSafeState();
  if (flag('--execute')) await execute();
  else await smoke();
})().catch((e) => fail(e?.message ?? String(e)));
