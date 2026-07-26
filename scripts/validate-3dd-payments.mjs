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
 * SAFETY: refuses any sk_live_ env value; STRIPE_SECRET_KEY is optional,
 * sk_test_-only, and read ONLY for --verify provider assertions and the
 * --plan-fixture Checkout URL;
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
import { loadStage3eIdentity, reconcileAttribution } from './stage3d-attribution.mjs';

const PROJECT_REF = 'gwtunmoefapiiybwlelw';
const PHRASE = 'VALIDATE-3DD-TEST-PAYMENTS';
const SNAP_FILE = '3dd-snapshot.local.json';
const STAGE3E_SNAP = '3e-snapshot.local.json';

const args = process.argv.slice(2);
const argOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const fail = (m) => { console.error(`ABORT: ${m}`); process.exit(1); };
const say = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));

for (const [k, v] of Object.entries(process.env)) {
  if (typeof v === 'string' && v.startsWith('sk_live_')) fail(`live key material in env ${k}`);
}
// STRIPE_SECRET_KEY is OPTIONAL and used ONLY by --verify (provider-side
// livemode/amount/metadata assertions) and --plan-fixture. TEST keys only.
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY ?? '';
if (STRIPE_KEY && !STRIPE_KEY.startsWith('sk_test_')) fail('STRIPE_SECRET_KEY must be sk_test_ (test mode only).');
if (argOf('--confirm') !== PHRASE) fail(`requires --confirm "${PHRASE}"`);
const URL_ = process.env.SUPABASE_URL ?? '';
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
if (!URL_ || !SVC || !ANON) fail('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY required.');
if (!URL_.includes(PROJECT_REF)) fail(`not project ${PROJECT_REF}`);
const admin = createClient(URL_, SVC, { auth: { persistSession: false } });
const must = (r, w) => { if (r.error) fail(`${w}: ${JSON.stringify(r.error)}`); return r.data; };

// STRICT UUID data-contract guard: every identifier handed to Supabase must
// be the actual UUID string — never an object, array, envelope or free text.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mustUuid = (value, label) => {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    fail(`${label} is not a UUID (got ${Array.isArray(value) ? 'array' : typeof value}${
      typeof value === 'string' ? `: ${value.slice(0, 40)}` : ''})`);
  }
  return value;
};

// Preflight creation ledger + on-disk checkpoint (safe test-fixture ids only;
// gitignored) so a mid-run failure is always recoverable and enumerable.
const CKPT_FILE = '3dd-preflight.checkpoint.local.json';
const ledger = [];
const checkpoint = (step, resource) => {
  ledger.push({ step, ...resource });
  writeFileSync(CKPT_FILE, JSON.stringify({ at: new Date().toISOString(), created: ledger }, null, 2));
};
const reportPartialAndFail = (step, err) => {
  console.error(`PREFLIGHT FAILED at step: ${step}`);
  console.error(`Resources created so far (also in ${CKPT_FILE}):`);
  console.error(JSON.stringify(ledger, null, 2));
  console.error('Recovery: node scripts/validate-3dd-payments.mjs --inspect-partial --confirm "VALIDATE-3DD-TEST-PAYMENTS"');
  fail(`${step}: ${err}`);
};

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
  let step = 'create coordinator user';
  try {
    const coord = await mkUser('coord', suffix);
    mustUuid(coord.id, 'coordinator account id');
    checkpoint(step, { type: 'auth_user+account', id: coord.id, email: coord.email });
    step = 'create companion user';
    const comp = await mkUser('comp', suffix);
    mustUuid(comp.id, 'companion account id');
    checkpoint(step, { type: 'auth_user+account', id: comp.id, email: comp.email });

    step = 'coordinator signup (member profile)';
    // complete_coordinator_signup returns a jsonb ENVELOPE with
    // member_profile_id (see hosted 2G2 suite).
    const wc = must(await coord.client.rpc('complete_coordinator_signup', {
      p_first_name: 'DdCoord', p_consent_confirmed: true, p_member_first_name: 'DdMember',
    }), 'coordinator signup');
    const memberProfile = mustUuid(wc?.member_profile_id, 'complete_coordinator_signup().member_profile_id');
    checkpoint(step, { type: 'member_profile', id: memberProfile });

    step = 'companion signup (companion profile)';
    // complete_companion_signup returns the full PROFILE ROW — the UUID is
    // row.id (the hosted suite reads companion.data.id). Gate-3DD regression:
    // never fall back to the whole object.
    const xc = must(await comp.client.rpc('complete_companion_signup', {
      p_first_name: 'DdCompanion', p_date_of_birth: '1980-01-01',
    }), 'companion signup');
    const companionProfile = mustUuid(xc?.id, 'complete_companion_signup().id');
    checkpoint(step, { type: 'companion_profile', id: companionProfile });

    step = 'create offers';
    const offers = must(await admin.from('conversation_offers').insert([
      { companion_profile_id: companionProfile, offer_type: 'trial', duration_minutes: 15, price_minor: 700 },
      { companion_profile_id: companionProfile, offer_type: 'single', duration_minutes: 30, price_minor: 1600 },
    ]).select('id, offer_type'), 'offers');
    for (const o of offers) mustUuid(o.id, `offer ${o.offer_type} id`);
    checkpoint(step, { type: 'conversation_offers', ids: offers.map((o) => o.id) });

    step = 'issue validation credit';
    must(await admin.rpc('issue_account_credit', {
      p_account: coord.id, p_amount: 2100, p_source_type: 'support_adjustment',
      p_source: null, p_reason: `3DD-${suffix} validation credit`, p_idempotency: `3dd-credit-${suffix}`,
    }), 'issue credit');
    checkpoint(step, { type: 'credit_ledger', idempotency_key: `3dd-credit-${suffix}` });

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
  } catch (e) {
    reportPartialAndFail(step, e?.message ?? String(e));
  }
}

/* ------------------- partial-run inspection and cleanup ------------------ */
// Candidates are matched ONLY by the strict Stage 3D-D fixture convention:
// auth email ^3dd-(coord|comp)-<base36>@example\.com$ within the recent
// window. Historical users, customers and financial rows can never match.
const FIXTURE_EMAIL_RE = /^3dd-(coord|comp)-([a-z0-9]+)@example\.com$/;

async function listFixtureUsers() {
  const users = [];
  let page = 1;
  for (;;) {
    const r = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (r.error) fail(`listUsers: ${r.error.message}`);
    users.push(...r.data.users.filter((u) => FIXTURE_EMAIL_RE.test(u.email ?? '')));
    if (r.data.users.length < 200) break;
    page += 1;
  }
  return users;
}

async function inspectPartial() {
  const snap = existsSync(SNAP_FILE) ? JSON.parse(readFileSync(SNAP_FILE, 'utf-8')) : null;
  const users = await listFixtureUsers();
  const out = [];
  for (const u of users) {
    const suffix = (u.email ?? '').match(FIXTURE_EMAIL_RE)?.[2] ?? '?';
    const orders = (await admin.from('payment_orders').select('id', { count: 'exact', head: true })
      .eq('coordinator_account_id', u.id)).count ?? 0;
    const credit = (await admin.from('credit_ledger').select('id', { count: 'exact', head: true })
      .eq('coordinator_account_id', u.id)).count ?? 0;
    out.push({
      auth_user_id: u.id, email: u.email, suffix, created_at: u.created_at,
      payment_orders: orders, credit_ledger_rows: credit,
      in_current_snapshot: Boolean(snap && (snap.coordinator.account_id === u.id || snap.companion.account_id === u.id)),
    });
  }
  say({ mode: 'inspect-partial (READ-ONLY)', candidates: out });
  say('A failed-preflight candidate has in_current_snapshot=false. Partial rows');
  say('are NON-FINANCIAL (users/profiles only — the failed run aborted before');
  say('credit); cleanup is optional. To remove one exact run:');
  say('  node scripts/validate-3dd-payments.mjs --cleanup-partial --suffix <suffix> --confirm-cleanup "CLEANUP-FAILED-3DD-PREFLIGHT" --confirm "VALIDATE-3DD-TEST-PAYMENTS"');
}

async function cleanupPartial() {
  if (argOf('--confirm-cleanup') !== 'CLEANUP-FAILED-3DD-PREFLIGHT') {
    fail('cleanup requires --confirm-cleanup "CLEANUP-FAILED-3DD-PREFLIGHT"');
  }
  const suffix = argOf('--suffix') ?? '';
  if (!/^[a-z0-9]{6,16}$/.test(suffix)) fail('--suffix <base36 run suffix> required (from --inspect-partial)');
  const snap = existsSync(SNAP_FILE) ? JSON.parse(readFileSync(SNAP_FILE, 'utf-8')) : null;
  if (snap && snap.suffix === suffix) fail('refusing to clean the CURRENT snapshot run');
  const users = (await listFixtureUsers()).filter(
    (u) => (u.email ?? '').match(FIXTURE_EMAIL_RE)?.[2] === suffix);
  if (users.length === 0) { say('nothing to clean for that suffix (idempotent no-op)'); return; }
  for (const u of users) {
    // Refuse anything with financial rows — those are not partial-preflight
    // artifacts and are NEVER deleted.
    const orders = (await admin.from('payment_orders').select('id', { count: 'exact', head: true })
      .eq('coordinator_account_id', u.id)).count ?? 0;
    const credit = (await admin.from('credit_ledger').select('id', { count: 'exact', head: true })
      .eq('coordinator_account_id', u.id)).count ?? 0;
    if (orders > 0 || credit > 0) fail(`refusing ${u.email}: has financial rows (orders=${orders} credit=${credit})`);
  }
  // Dependency order: offers -> profiles are left to FK-safe user deletion;
  // we delete offers explicitly first (they reference profiles).
  for (const u of users) {
    const profs = must(await admin.from('profile_access')
      .select('profile_id').eq('account_id', u.id), 'profile access') ?? [];
    for (const p of profs) {
      const del = await admin.from('conversation_offers').delete()
        .eq('companion_profile_id', p.profile_id).select('id');
      for (const row of del.data ?? []) say(`deleted conversation_offers ${row.id}`);
    }
  }
  for (const u of users) {
    const del = await admin.auth.admin.deleteUser(u.id);
    if (del.error) say(`NOTE: auth user ${u.email} not deletable (${del.error.message}) — retained as a non-financial fixture, consistent with suite convention`);
    else say(`deleted auth user ${u.email} (${u.id})`);
  }
  const remaining = (await listFixtureUsers()).filter(
    (u) => (u.email ?? '').match(FIXTURE_EMAIL_RE)?.[2] === suffix);
  say({ cleanup_complete: true, remaining_matching_users: remaining.length });
}

/* ------------------------------- mismatch ------------------------------ */
async function mismatch() {
  await assertSafeState();
  if (!existsSync(SNAP_FILE)) fail('run --preflight first');
  const S = JSON.parse(readFileSync(SNAP_FILE, 'utf-8'));
  const mk = async (key) => (must(await admin.from('payment_orders').insert({
    coordinator_account_id: mustUuid(S.coordinator.account_id, 'snapshot coordinator account_id'), order_type: 'one_off',
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

  // Attribution contract: every order/booking added since the 3D baseline must
  // belong to the EXACT Stage 3D fixture OR the EXACT recognised Stage 3E
  // fixture (by durable profile identity), with ZERO unexplained residual. The
  // Stage 3E fixture legitimately adds rows after the 3D baseline was captured;
  // it is attributed by its exact profile UUIDs, never a count/prefix/date.
  const s3dOrderIds = orders.map((o) => o.id);
  const s3dBookingIds = bookings; // already the fixture booking ids (deduped below)
  let s3eOrderIds = [], s3eBookingIds = [], s3eSuffix = null;
  const residualO = d.orders - new Set(s3dOrderIds).size;
  const residualB = d.bookings - new Set(s3dBookingIds).size;
  if (residualO !== 0 || residualB !== 0) {
    // Extra rows exist since baseline — they MUST resolve to the recognised
    // Stage 3E fixture. Fail CLOSED if that durable identity is unavailable.
    if (!existsSync(STAGE3E_SNAP)) {
      fail(`unexplained rows since baseline (orders +${residualO}, bookings +${residualB}) but ${STAGE3E_SNAP} is absent — cannot attribute; investigate before proceeding`);
    }
    let snapObj;
    try { snapObj = JSON.parse(readFileSync(STAGE3E_SNAP, 'utf-8')); }
    catch { fail(`${STAGE3E_SNAP} is malformed — cannot attribute Stage 3E fixture`); }
    let s3e;
    try { s3e = loadStage3eIdentity(snapObj); }
    catch (e) { fail(`Stage 3E fixture identity unresolved: ${e.message}`); }
    s3eSuffix = s3e.suffix;
    const eo = must(await admin.from('payment_orders').select('id, companion_profile_id, member_profile_id')
      .eq('companion_profile_id', mustUuid(s3e.companion_profile_id, '3E companion_profile_id'))
      .eq('member_profile_id', mustUuid(s3e.member_profile_id, '3E member_profile_id')), 'Stage 3E orders');
    const eb = must(await admin.from('bookings').select('id, companion_profile_id, member_profile_id')
      .eq('companion_profile_id', s3e.companion_profile_id)
      .eq('member_profile_id', s3e.member_profile_id), 'Stage 3E bookings');
    // Recognised rows belong ONLY to the isolated Stage 3E fixture (exact
    // profiles). Guaranteed by the exact-identity query; a hard fail-guard (NOT
    // a counted assertion, to keep verify() at exactly 18 checks) defends it.
    if (!eo.every((o) => o.companion_profile_id === s3e.companion_profile_id && o.member_profile_id === s3e.member_profile_id)
        || !eb.every((b) => b.companion_profile_id === s3e.companion_profile_id && b.member_profile_id === s3e.member_profile_id)) {
      fail('Stage 3E attribution query returned a non-3E row — refusing to attribute');
    }
    s3eOrderIds = eo.map((o) => o.id);
    s3eBookingIds = eb.map((b) => b.id);
  }
  const rec = reconcileAttribution({
    deltaOrders: d.orders, deltaBookings: d.bookings,
    stage3dOrderIds: s3dOrderIds, stage3dBookingIds: s3dBookingIds,
    stage3eOrderIds: s3eOrderIds, stage3eBookingIds: s3eBookingIds,
  });
  say({ attribution: {
    total_delta_orders: d.orders, stage3d_orders: new Set(s3dOrderIds).size, stage3e_orders: rec.stage3eOrders, unexplained_orders: rec.unexplainedOrders,
    total_delta_bookings: d.bookings, stage3d_bookings: new Set(s3dBookingIds).size, stage3e_bookings: rec.stage3eBookings, unexplained_bookings: rec.unexplainedBookings,
    stage3e_suffix: s3eSuffix,
  } });
  if (rec.unexplainedOrders !== 0 || rec.unexplainedBookings !== 0) {
    // Safe (UUID-only) diagnostics: current IDs not attributed to 3D or 3E.
    const allO = must(await admin.from('payment_orders').select('id'), 'all order ids (diag)');
    const allB = must(await admin.from('bookings').select('id'), 'all booking ids (diag)');
    say({ unexplained_candidates: {
      order_ids: allO.map((o) => o.id).filter((id) => !rec.attributedOrderIds.has(id)).slice(0, 25),
      booking_ids: allB.map((b) => b.id).filter((id) => !rec.attributedBookingIds.has(id)).slice(0, 25),
      note: 'candidates exclude the exact 3D + 3E fixtures; verify against the 3D baseline',
    } });
  }
  check('every order since baseline is the Stage 3D or recognised Stage 3E fixture (zero unexplained)', rec.unexplainedOrders === 0);
  check('every booking since baseline is the Stage 3D or recognised Stage 3E fixture (zero unexplained)', rec.unexplainedBookings === 0);
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

  // Provider-side assertions via the Stripe TEST API (sk_test_ enforced).
  if (STRIPE_KEY) {
    const withIntent = orders.filter((o) => o.stripe_payment_intent_id);
    let live = 0, amountBad = 0, metaBad = 0, currencyBad = 0;
    for (const o of withIntent) {
      const pi = await stripeGet(`payment_intents/${o.stripe_payment_intent_id}`);
      if (pi.livemode !== false) live += 1;
      if (pi.currency !== 'gbp') currencyBad += 1;
      if (pi.amount !== o.card_amount_minor) amountBad += 1;
      if ((pi.metadata?.payment_order_id ?? null) !== o.id) metaBad += 1;
    }
    check(`every fixture intent livemode=false (${withIntent.length} checked)`, live === 0);
    check('every fixture intent amount matches its order snapshot', amountBad === 0);
    check('every fixture intent currency is gbp', currencyBad === 0);
    check('every fixture intent metadata.payment_order_id matches', metaBad === 0);
  } else {
    console.log('NOTE: STRIPE_SECRET_KEY (sk_test_) not set — provider livemode/amount/metadata proven via Dashboard visual check instead.');
  }
  // Plan-period parity fixture assertions when present.
  if (S.plan_order_id) {
    const p = must(await admin.from('payment_orders')
      .select('status, local_finalisation_status, stripe_payment_intent_id, booking_id, order_type')
      .eq('id', S.plan_order_id).single(), 'plan order');
    check('M9 plan-period order finalised exactly once via deployed return path',
      p.order_type === 'plan_period' && p.status === 'succeeded'
      && p.local_finalisation_status === 'completed' && p.stripe_payment_intent_id !== null
      && p.booking_id === null);
  }
  console.log(`VERIFY RESULT pass=${pass} fail=${failCount}`);
  process.exit(failCount ? 1 : 0);
}

/* ---------------------- plan-period parity fixture --------------------- */
// Synthetic ISOLATED plan_period order (no real plan/period touched): proves
// the customer-facing complete_period -> hosted Checkout -> /payment/return
// -> webhook-finalise chain exactly once. finalise marks the order succeeded;
// with no linked billing period and no booking arm for plan_period orders,
// nothing else in the plan engine is affected.
async function planFixture() {
  await assertSafeState();
  if (!existsSync(SNAP_FILE)) fail('run --preflight first');
  const S = JSON.parse(readFileSync(SNAP_FILE, 'utf-8'));
  const order = must(await admin.from('payment_orders').insert({
    coordinator_account_id: mustUuid(S.coordinator.account_id, 'snapshot coordinator account_id'), order_type: 'plan_period',
    subtotal_minor: 900, total_minor: 900, credit_applied_minor: 0, card_amount_minor: 900,
    commission_rate_pct: 5, idempotency_key: `3dd-plan-${S.suffix}`, status: 'pending',
  }).select('id').single(), 'plan order');
  // Authenticated coordinator invoke of the DEPLOYED complete_period action.
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const si = await c.auth.signInWithPassword({ email: S.coordinator.email, password: S.coordinator.password });
  if (si.error) fail(`fixture sign-in: ${si.error.message}`);
  const { data, error } = await c.functions.invoke('stripe-billing', {
    body: { action: 'complete_period', order_id: order.id, origin: 'http://localhost:5173' },
  });
  if (error || !data?.url) fail(`complete_period: ${error?.message ?? JSON.stringify(data)}`);
  S.plan_order_id = order.id;
  writeFileSync(SNAP_FILE, JSON.stringify(S, null, 2));
  say({ step: 'plan_fixture_ready', plan_order_id: order.id });
  say('OPEN THIS hosted Checkout URL in the fixture-coordinator browser session,');
  say('pay with 4000 0025 0000 3155 (complete authentication), and confirm you');
  say(`land on /#/payment/return?order=${order.id}&outcome=success :`);
  say(data.url);
}

/* -------------------- provider-side (Stripe API) checks ----------------- */
async function stripeGet(path) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${STRIPE_KEY}` },
  });
  return r.json();
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
  if (args.includes('--inspect-partial')) return inspectPartial();
  if (args.includes('--cleanup-partial')) return cleanupPartial();
  if (args.includes('--plan-fixture')) return planFixture();
  if (args.includes('--report')) return report();
  fail('choose --preflight | --mismatch | --plan-fixture | --verify | --report | --inspect-partial | --cleanup-partial');
})().catch((e) => fail(e?.message ?? String(e)));
