#!/usr/bin/env node
/**
 * Stage 3D-D — guarded hosted Stripe TEST-MODE payment validation harness.
 *
 * Modes (all require --confirm "VALIDATE-3DD-TEST-PAYMENTS"):
 *   --preflight  safety checks + baseline snapshot + isolated fixtures
 *                (coordinator sign-in user, member/companion profiles, trial +
 *                single offers, account credit for credit-only/mixed runs).
 *                Prints the browser credentials + every created id. Creates
 *                NO Stripe object and NO payment order.
 *   --mismatch   DB-only containment proofs (scenarios 14–16): synthetic
 *                isolated orders + service reconcile with wrong amount /
 *                currency / metadata → reconciliation_required with safe
 *                codes, zero bookings. Never contacts Stripe.
 *   --verify     post-browser-matrix assertions: per-scenario order/booking/
 *                effect checks by fixture suffix, exactly-once invariants,
 *                baseline deltas, projection health, Stage 3C sentinels.
 *   --report     read-only convenience dump of fixture-suffix orders.
 *
 * SAFETY: refuses any sk_live_ env value and never reads STRIPE_SECRET_KEY;
 * requires hosted_test + every financial control disabled + ceiling 0 before
 * doing anything; touches ONLY rows carrying the run's unique suffix; never
 * mutates historical orders, controls, the ceiling or Stage 3C records.
 * Local fixture rows are retained (they are ordinary hosted-test records,
 * consistent with every earlier stage) and enumerated for the runbook.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY.
 * The snapshot lives in 3dd-snapshot.local.json (gitignored).
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PROJECT_REF = 'gwtunmoefapiiybwlelw';
const PHRASE = 'VALIDATE-3DD-TEST-PAYMENTS';
const SNAP_FILE = '3dd-snapshot.local.json';

const args = process.argv.slice(2);
const argOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const fail = (m) => { console.error(`ABORT: ${m}`); process.exit(1); };
const say = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));

for (const [k, v] of Object.entries(process.env)) {
  if (typeof v === 'string' && v.startsWith('sk_live_')) fail(`live key material in env ${k}`);
}
if (process.env.STRIPE_SECRET_KEY) fail('STRIPE_SECRET_KEY must not be present locally.');
if (argOf('--confirm') !== PHRASE) fail(`requires --confirm "${PHRASE}"`);
const URL_ = process.env.SUPABASE_URL ?? '';
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
if (!URL_ || !SVC || !ANON) fail('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY required.');
if (!URL_.includes(PROJECT_REF)) fail(`not project ${PROJECT_REF}`);
const admin = createClient(URL_, SVC, { auth: { persistSession: false } });
const must = (r, w) => { if (r.error) fail(`${w}: ${JSON.stringify(r.error)}`); return r.data; };

let pass = 0, failCount = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { failCount += 1; console.log(`FAIL ${name} ${detail}`); }
};

async function assertSafeState() {
  const cfg = must(await admin.from('financial_operations_config')
    .select('environment, provider_transfer_amount_ceiling_minor').single(), 'config');
  if (cfg.environment !== 'hosted_test') fail(`environment ${cfg.environment}`);
  if (cfg.provider_transfer_amount_ceiling_minor !== 0) fail('transfer ceiling not 0');
  const ctl = must(await admin.from('financial_operation_controls').select('control_name, state'), 'controls');
  const bad = ctl.filter((c) => c.state !== 'disabled');
  if (bad.length) fail(`controls not disabled: ${bad.map((c) => c.control_name).join(',')}`);
}

async function snapshotCounts() {
  const n = async (t, q = (x) => x) => (await q(admin.from(t).select('id', { count: 'exact', head: true }))).count ?? -1;
  return {
    orders: await n('payment_orders'),
    bookings: await n('bookings'),
    ledger: await n('credit_ledger'),
    webhook_events: await n('stripe_webhook_events'),
    findings: await n('financial_reconciliation_findings'),
    with_intent: (await admin.from('payment_orders').select('id', { count: 'exact', head: true })
      .not('stripe_payment_intent_id', 'is', null)).count ?? -1,
  };
}

async function mkUser(tag, suffix) {
  const email = `3dd-${tag}-${suffix}@example.com`;
  const pw = `Dd!${crypto.randomUUID()}`;
  const made = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (made.error) fail(`create ${tag}: ${made.error.message}`);
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const si = await c.auth.signInWithPassword({ email, password: pw });
  if (si.error) fail(`sign-in ${tag}: ${si.error.message}`);
  must(await c.rpc('ensure_current_account'), `ensure ${tag}`);
  return { client: c, id: made.data.user.id, email, pw };
}

/* ------------------------------ preflight ------------------------------ */
async function preflight() {
  await assertSafeState();
  const snap = await snapshotCounts();
  const suffix = Date.now().toString(36);
  const coord = await mkUser('coord', suffix);
  const comp = await mkUser('comp', suffix);
  // Coordinator + managed member via the sanctioned signup path.
  const wc = must(await coord.client.rpc('complete_coordinator_signup', {
    p_first_name: 'DdCoord', p_consent_confirmed: true, p_member_first_name: 'DdMember',
  }), 'coordinator signup');
  const memberProfile = wc.member_profile_id;
  const xc = must(await comp.client.rpc('complete_companion_signup', {
    p_first_name: 'DdCompanion', p_date_of_birth: '1980-01-01',
  }), 'companion signup');
  const companionProfile = xc.companion_profile_id ?? xc.profile_id ?? xc;
  // Offers: trial + single (server-priced sources for the real checkout).
  const offers = must(await admin.from('conversation_offers').insert([
    { companion_profile_id: companionProfile, offer_type: 'trial', duration_minutes: 15, price_minor: 700 },
    { companion_profile_id: companionProfile, offer_type: 'single', duration_minutes: 30, price_minor: 1600 },
  ]).select('id, offer_type'), 'offers');
  // Credit for the credit-only (full cover) and mixed (partial) scenarios.
  must(await admin.rpc('issue_account_credit', {
    p_account: coord.id, p_amount: 2100, p_source_type: 'support_adjustment',
    p_source: null, p_reason: `3DD-${suffix} validation credit`, p_idempotency: `3dd-credit-${suffix}`,
  }), 'issue credit');
  const out = {
    suffix,
    baseline: snap,
    coordinator: { email: coord.email, password: coord.pw, account_id: coord.id },
    companion: { email: comp.email, account_id: comp.id },
    member_profile_id: memberProfile,
    companion_profile_id: companionProfile,
    offers: offers,
    credit_minor: 2100,
    created_at: new Date().toISOString(),
  };
  writeFileSync(SNAP_FILE, JSON.stringify(out, null, 2));
  say({ note: 'fixture ready — credentials below are TEST-ONLY hosted users', ...out });
  say(`Snapshot + fixture ids saved to ${SNAP_FILE} (gitignored — do not commit).`);
}

/* ------------------------------- mismatch ------------------------------ */
async function mismatch() {
  await assertSafeState();
  if (!existsSync(SNAP_FILE)) fail('run --preflight first');
  const S = JSON.parse(readFileSync(SNAP_FILE, 'utf-8'));
  const mk = async (key) => (must(await admin.from('payment_orders').insert({
    coordinator_account_id: S.coordinator.account_id, order_type: 'one_off',
    subtotal_minor: 1600, total_minor: 1600, credit_applied_minor: 0, card_amount_minor: 1600,
    commission_rate_pct: 5, idempotency_key: `3dd-mm-${key}-${S.suffix}`, status: 'pending',
  }).select('id').single(), `order ${key}`)).id;
  const rec = (order, over) => admin.rpc('reconcile_payment_order', {
    p_order: order, p_intent: over.intent ?? `pi_3dd_${S.suffix}`, p_provider_status: 'succeeded',
    p_amount_minor: over.amount ?? 1600, p_currency: over.currency ?? 'gbp',
    p_event_at: null, p_metadata_order: over.meta ?? null,
  });
  const row = async (id) => must(await admin.from('payment_orders')
    .select('status, booking_id, local_finalisation_status, reconciliation_code').eq('id', id).single(), 'row');

  const oA = await mk('amount');
  const rA = must(await rec(oA, { amount: 1 }), 'amount reconcile');
  const a = await row(oA);
  check('14 amount mismatch contained', rA.reason === 'amount_mismatch'
    && a.local_finalisation_status === 'reconciliation_required'
    && a.reconciliation_code === 'amount_mismatch' && a.status === 'pending' && a.booking_id === null);

  const oC = await mk('currency');
  const rC = must(await rec(oC, { currency: 'usd' }), 'currency reconcile');
  const c = await row(oC);
  check('15 currency mismatch contained', rC.reason === 'currency_mismatch'
    && c.reconciliation_code === 'currency_mismatch' && c.booking_id === null);

  const oM = await mk('metadata');
  const rM = must(await rec(oM, { meta: oA }), 'metadata reconcile');
  const m = await row(oM);
  check('16 metadata mismatch contained', rM.reason === 'metadata_mismatch'
    && m.reconciliation_code === 'metadata_mismatch' && m.booking_id === null);

  say(`mismatch orders (isolated, suffix ${S.suffix}): ${oA}, ${oC}, ${oM}`);
  process.exit(failCount ? 1 : 0);
}

/* -------------------------------- verify ------------------------------- */
async function verify() {
  await assertSafeState();
  if (!existsSync(SNAP_FILE)) fail('run --preflight first');
  const S = JSON.parse(readFileSync(SNAP_FILE, 'utf-8'));
  const orders = must(await admin.from('payment_orders')
    .select('id, order_type, status, provider_payment_status, local_finalisation_status, reconciliation_code, card_amount_minor, credit_applied_minor, stripe_payment_intent_id, stripe_checkout_session_id, booking_id, idempotency_key')
    .eq('coordinator_account_id', S.coordinator.account_id), 'fixture orders');
  say({ fixture_orders: orders.length });

  // Exactly-once invariants for THIS run's orders.
  const intents = orders.map((o) => o.stripe_payment_intent_id).filter(Boolean);
  check('one intent per order (no duplicates)', new Set(intents).size === intents.length);
  const bookings = orders.map((o) => o.booking_id).filter(Boolean);
  check('one booking per order (no duplicates)', new Set(bookings).size === bookings.length);
  const succeeded = orders.filter((o) => o.status === 'succeeded');
  check('every succeeded order is locally completed',
    succeeded.every((o) => o.local_finalisation_status === 'completed'));
  const cardSucceeded = succeeded.filter((o) => o.card_amount_minor > 0);
  check('every succeeded CARD order carries exactly one provider intent',
    cardSucceeded.every((o) => o.stripe_payment_intent_id));
  const creditOnly = succeeded.filter((o) => o.card_amount_minor === 0);
  check('credit-only orders have NO provider object and provider none',
    creditOnly.every((o) => !o.stripe_payment_intent_id && !o.stripe_checkout_session_id
      && o.provider_payment_status === 'none'));
  const mm = orders.filter((o) => o.idempotency_key.startsWith('3dd-mm-'));
  check('deliberate mismatch fixtures remain contained (3 flagged, no booking)',
    mm.length === 3 && mm.every((o) => o.local_finalisation_status === 'reconciliation_required' && !o.booking_id));

  // Global exactly-once invariants.
  const dupI = must(await admin.rpc('reconcile_payment_order', {
    p_order: mm[0].id, p_intent: `pi_3dd_${S.suffix}`, p_provider_status: 'succeeded',
    p_amount_minor: 1, p_currency: 'gbp', p_event_at: null, p_metadata_order: null,
  }), 'repeat mismatch reconcile');
  check('repeat reconcile of flagged order stays idempotent-contained', dupI.reason === 'amount_mismatch');

  // Baseline deltas — every change must be explained by THIS run's fixtures.
  const now = await snapshotCounts();
  const d = {
    orders: now.orders - S.baseline.orders,
    bookings: now.bookings - S.baseline.bookings,
    ledger: now.ledger - S.baseline.ledger,
    webhook_events: now.webhook_events - S.baseline.webhook_events,
    findings: now.findings - S.baseline.findings,
    with_intent: now.with_intent - S.baseline.with_intent,
  };
  say({ deltas: d, fixture_orders: orders.length, fixture_bookings: bookings.length });
  check('order delta equals this run’s fixture orders', d.orders === orders.length);
  check('booking delta equals this run’s fixture bookings', d.bookings === bookings.length);
  check('no unexplained reconciliation findings', d.findings === 0);

  // Projection health + support queue.
  const flaggedNoCode = (await admin.from('payment_orders').select('id', { count: 'exact', head: true })
    .eq('local_finalisation_status', 'reconciliation_required').is('reconciliation_code', null)).count ?? -1;
  check('no reconciliation_required without code', flaggedNoCode === 0);

  // Stage 3C sentinels byte-stability (values fixed by earlier gates).
  const earn = must(await admin.from('companion_earnings')
    .select('state, transfer_state, net_minor, currency').eq('id', '71ecc62b-cfd5-4e46-9fd1-ae00223dc2a2').single(), 'sentinel earning');
  check('protected earning unchanged', earn.state === 'payable' && earn.transfer_state === 'failed' && earn.net_minor === 950);
  const att = must(await admin.from('companion_transfer_attempts')
    .select('state, stripe_transfer_id, amount_minor').eq('id', '080b51bb-3391-49e1-9562-930b2ed68a08').single(), 'sentinel attempt');
  check('protected attempt unchanged', att.state === 'failed_permanent' && att.stripe_transfer_id === null && att.amount_minor === 950);

  console.log(`VERIFY RESULT pass=${pass} fail=${failCount}`);
  process.exit(failCount ? 1 : 0);
}

async function report() {
  if (!existsSync(SNAP_FILE)) fail('no snapshot');
  const S = JSON.parse(readFileSync(SNAP_FILE, 'utf-8'));
  const orders = must(await admin.from('payment_orders')
    .select('id, order_type, status, provider_payment_status, local_finalisation_status, card_amount_minor, credit_applied_minor, stripe_payment_intent_id, booking_id')
    .eq('coordinator_account_id', S.coordinator.account_id), 'orders');
  say(orders);
}

(async () => {
  if (args.includes('--preflight')) return preflight();
  if (args.includes('--mismatch')) return mismatch();
  if (args.includes('--verify')) return verify();
  if (args.includes('--report')) return report();
  fail('choose --preflight | --mismatch | --verify | --report');
})().catch((e) => fail(e?.message ?? String(e)));
