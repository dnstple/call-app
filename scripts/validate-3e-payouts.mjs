#!/usr/bin/env node
/**
 * Stage 3E-H — guarded hosted Stripe TEST-MODE companion payout validation.
 *
 * Modes (every mutating mode requires --confirm "VALIDATE-3E-TEST-PAYOUTS"):
 *   --preflight            safety checks + baseline + isolated fixture users/
 *                          profiles/offers (idempotent; checkpointed).
 *   --inspect              read-only fixture/controls/queues dump.
 *   --verify-foundation    0084/0085/0086 objects + control defaults; creates
 *                          no Stripe object and mutates nothing.
 *   --prepare-connect      real Edge ensure_connect_account + onboarding link
 *                          for the fixture Companion (URL printed; secrets not).
 *   --verify-connect       real Edge refresh_connect_status + provider truth.
 *   --prepare-earnings     E3–E9 cases via the SAME sanctioned hosted-fixture
 *                          technique as Stage 3C (synthetic confirmed past
 *                          booking + succeeded order, then the Companion's
 *                          REAL submit_companion_attendance RPC as the
 *                          authoritative earning path; release via the REAL
 *                          public release/resolve functions — the production
 *                          eligibility functions are never weakened).
 *   --enable-isolated-transfers  allowlist ONLY the fixture destination +
 *                          raise per-transfer/daily ceilings to the matrix
 *                          minimum (phrase-gated; prints before/after).
 *   --run-transfer-cases   E5/E6/E10/E11 through the REAL scoped saga RPCs +
 *                          deployed scoped-stripe-transfers Edge Function.
 *   --verify               deterministic Stage 3E verifier (E2–E17 hosted
 *                          rows + provider objects) -> VERIFY RESULT line.
 *   --report               secrets-free closeout summary (3e-report.local.json).
 *   --restore-controls     allowlist entry deactivated; both ceilings 0;
 *                          controls disabled (asserts the resting state).
 *   --inspect-partial      read-only post-failure inspection.
 *   --cleanup              guarded fixture cleanup; REFUSES rows with
 *                          financial history (earnings/attempts/transfers).
 *
 * SAFETY: refuses sk_live_ anywhere in env; STRIPE_SECRET_KEY must be
 * sk_test_; project must be gwtunmoefapiiybwlelw; requires environment
 * hosted_test, every financial control disabled and BOTH ceilings 0 before
 * any mutation (except the explicit enable mode, which may only raise them
 * to the fixture minimum and only alongside the fixture allowlist entry);
 * touches ONLY rows carrying this run's generated suffix; never accepts an
 * operator-supplied amount, currency, destination or transfer id; never
 * prints keys, tokens, passwords or raw provider payloads. Credentials the
 * operator needs live only in 3e-snapshot.local.json (ignored).
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
 *      STRIPE_SECRET_KEY (sk_test_, required for connect/transfer/verify).
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PROJECT_REF = 'gwtunmoefapiiybwlelw';
const PHRASE = 'VALIDATE-3E-TEST-PAYOUTS';
const SNAP_FILE = '3e-snapshot.local.json';
const CKPT_FILE = '3e-checkpoint.local.json';
const REPORT_FILE = '3e-report.local.json';
const FIXTURE_EMAIL_RE = /^3e-(coord|member|comp|ops)-[a-z0-9]+@example\.com$/;

// Matrix economics (fixture-fixed; the operator can never override these).
const TRIAL_MINOR = 700;             // trial: 0% commission -> net 700
const REGULAR_MINOR = 1600;          // regular: 5% -> commission 80, net 1520
const REGULAR_COMMISSION = 80;
const REGULAR_NET = REGULAR_MINOR - REGULAR_COMMISSION;
const MATRIX_TRANSFERS = 2;          // E5 + E6 execute real test transfers
const PER_TRANSFER_CEILING = REGULAR_NET;                 // smallest sufficient
const DAILY_CEILING = REGULAR_NET * MATRIX_TRANSFERS;     // smallest sufficient

const args = process.argv.slice(2);
const argOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const fail = (m) => { console.error(`ABORT: ${m}`); process.exit(1); };
const say = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));

/* ----------------------------- env guards ------------------------------ */
for (const [k, v] of Object.entries(process.env)) {
  if (typeof v === 'string' && v.startsWith('sk_live_')) fail(`live key material in env ${k}`);
}
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY ?? '';
if (STRIPE_KEY && !STRIPE_KEY.startsWith('sk_test_')) fail('STRIPE_SECRET_KEY must be sk_test_ (test mode only).');
const URL_ = process.env.SUPABASE_URL ?? '';
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
if (!URL_ || !SVC || !ANON) fail('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY required.');
if (!URL_.includes(PROJECT_REF)) fail(`not project ${PROJECT_REF}`);

const MUTATING = ['--preflight', '--prepare-connect', '--prepare-earnings',
  '--enable-isolated-transfers', '--run-transfer-cases', '--restore-controls', '--cleanup'];
if (MUTATING.some((m) => args.includes(m)) && argOf('--confirm') !== PHRASE) {
  fail(`requires --confirm "${PHRASE}"`);
}

const admin = createClient(URL_, SVC, { auth: { persistSession: false } });
const must = (r, w) => { if (r.error) fail(`${w}: ${JSON.stringify(r.error)}`); return r.data; };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mustUuid = (v, label) => {
  if (typeof v !== 'string' || !UUID_RE.test(v)) fail(`${label} is not a UUID`);
  return v;
};
const safeCount = (r, w) => {
  if (r.error) fail(`${w}: ${JSON.stringify(r.error)}`);
  if (r.count === null || r.count === undefined) fail(`${w}: count unavailable`);
  return r.count;
};
const stripeGet = (p) => fetch(`https://api.stripe.com/v1/${p}`, { headers: { Authorization: `Bearer ${STRIPE_KEY}` } }).then((r) => r.json());

const ledger = [];
const checkpoint = (step, resource) => {
  ledger.push({ step, ...resource });
  writeFileSync(CKPT_FILE, JSON.stringify({ at: new Date().toISOString(), created: ledger }, null, 2));
};
let pass = 0, failCount = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { failCount += 1; console.log(`FAIL ${name} ${detail}`); }
};
const loadSnap = () => { if (!existsSync(SNAP_FILE)) fail('run --preflight first'); return JSON.parse(readFileSync(SNAP_FILE, 'utf-8')); };
const saveSnap = (s) => writeFileSync(SNAP_FILE, JSON.stringify(s, null, 2));

/* --------------------------- safe-state gates -------------------------- */
async function readControls() {
  const cfg = must(await admin.from('financial_operations_config')
    .select('environment, provider_transfer_amount_ceiling_minor, provider_transfer_daily_ceiling_minor').single(), 'config');
  const ctl = must(await admin.from('financial_operation_controls').select('control_name, state'), 'controls');
  return { cfg, ctl };
}
async function assertRestingState() {
  const { cfg, ctl } = await readControls();
  if (cfg.environment !== 'hosted_test') fail(`environment ${cfg.environment}`);
  if (cfg.provider_transfer_amount_ceiling_minor !== 0) fail('per-transfer ceiling not 0');
  if (cfg.provider_transfer_daily_ceiling_minor !== 0) fail('daily ceiling not 0');
  const bad = ctl.filter((c) => c.state !== 'disabled');
  if (bad.length) fail(`controls not disabled: ${bad.map((c) => c.control_name).join(',')}`);
  return cfg;
}

async function mkUser(tag, suffix) {
  const email = `3e-${tag}-${suffix}@example.com`;
  if (!FIXTURE_EMAIL_RE.test(email)) fail(`fixture email failed its own pattern: ${email}`);
  const pw = `Ep!${crypto.randomUUID()}`;
  const made = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (made.error) fail(`create ${tag}: ${made.error.message}`);
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const si = await c.auth.signInWithPassword({ email, password: pw });
  if (si.error) fail(`sign-in ${tag}: ${si.error.message}`);
  must(await c.rpc('ensure_current_account'), `ensure ${tag}`);
  return { client: c, id: made.data.user.id, email, pw, jwt: si.data.session.access_token };
}

/* ------------------------------ preflight ------------------------------ */
async function preflight() {
  await assertRestingState();
  if (existsSync(SNAP_FILE)) { say('snapshot exists — preflight is idempotent, reusing fixture.'); say(loadSnap().labels); return; }
  const suffix = Date.now().toString(36);
  const baseline = {
    earnings: safeCount(await admin.from('companion_earnings').select('id', { count: 'exact', head: true }), 'earnings'),
    attempts: safeCount(await admin.from('companion_transfer_attempts').select('id', { count: 'exact', head: true }), 'attempts'),
    adjustments: safeCount(await admin.from('settlement_adjustments').select('id', { count: 'exact', head: true }), 'adjustments'),
    findings: safeCount(await admin.from('financial_reconciliation_findings').select('id', { count: 'exact', head: true }), 'findings'),
  };
  let step = 'create users';
  try {
    const coord = await mkUser('coord', suffix);
    checkpoint(step, { type: 'auth_user', id: coord.id, email: coord.email });
    const memberOwner = await mkUser('member', suffix);
    checkpoint(step, { type: 'auth_user', id: memberOwner.id, email: memberOwner.email });
    const comp = await mkUser('comp', suffix);
    checkpoint(step, { type: 'auth_user', id: comp.id, email: comp.email });
    const ops = await mkUser('ops', suffix);
    checkpoint(step, { type: 'auth_user', id: ops.id, email: ops.email });
    must(await admin.from('support_admins').upsert({ account_id: ops.id }, { onConflict: 'account_id', ignoreDuplicates: true }), 'support admin');

    step = 'profiles + access';
    const compProfile = must(await admin.from('profiles').insert({ role: 'companion', first_name: `EComp${suffix}` }).select('id').single(), 'companion profile').id;
    must(await admin.from('profile_access').insert({ account_id: comp.id, profile_id: compProfile, access_role: 'owner', can_edit: true, can_book: true }), 'companion access');
    const memProfile = must(await admin.from('profiles').insert({ role: 'member', first_name: `EMem${suffix}` }).select('id').single(), 'member profile').id;
    must(await admin.from('profile_access').insert([
      { account_id: memberOwner.id, profile_id: memProfile, access_role: 'owner', can_edit: true, can_book: true },
      { account_id: coord.id, profile_id: memProfile, access_role: 'coordinator', can_edit: true, can_book: true },
    ]), 'member access');
    checkpoint(step, { type: 'profiles', companion: compProfile, member: memProfile });

    step = 'offers';
    const trialOffer = must(await admin.from('conversation_offers').insert({
      companion_profile_id: compProfile, offer_type: 'trial', duration_minutes: 30, price_minor: TRIAL_MINOR, supported_methods: ['in_app'],
    }).select('id').single(), 'trial offer').id;
    const singleOffer = must(await admin.from('conversation_offers').insert({
      companion_profile_id: compProfile, offer_type: 'single', duration_minutes: 30, price_minor: REGULAR_MINOR, supported_methods: ['in_app'],
    }).select('id').single(), 'single offer').id;
    checkpoint(step, { type: 'offers', trial: trialOffer, single: singleOffer });

    saveSnap({
      suffix, baseline,
      labels: { coordinator: '3e coordinator', member: '3e managed member', companion: '3e companion', ops: '3e support' },
      coordinator: { account_id: coord.id, email: coord.email, password: coord.pw },
      member_owner: { account_id: memberOwner.id, email: memberOwner.email, password: memberOwner.pw },
      companion: { account_id: comp.id, email: comp.email, password: comp.pw },
      ops: { account_id: ops.id, email: ops.email, password: ops.pw },
      companion_profile_id: compProfile, member_profile_id: memProfile,
      trial_offer_id: trialOffer, single_offer_id: singleOffer,
      cases: {}, transfers: {},
    });
    say({ preflight: 'ok', suffix, note: `credentials in ${SNAP_FILE} (gitignored)` });
  } catch (e) {
    console.error(`PREFLIGHT FAILED at: ${step}`); console.error(JSON.stringify(ledger, null, 2));
    fail(String(e?.message ?? e));
  }
}

/* ------------------------------- connect ------------------------------- */
async function edge(fn, jwt, body) {
  const r = await fetch(`${URL_.replace(/\/$/, '')}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function companionJwt(S) {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const si = await c.auth.signInWithPassword({ email: S.companion.email, password: S.companion.password });
  if (si.error) fail(`companion sign-in: ${si.error.message}`);
  return { jwt: si.data.session.access_token, client: c };
}

async function prepareConnect() {
  const S = loadSnap();
  const { jwt } = await companionJwt(S);
  let r = await edge('stripe-payments', jwt, { action: 'ensure_connect_account' });
  if (r.status !== 200) fail(`ensure_connect_account: ${r.status} ${JSON.stringify(r.body)}`);
  r = await edge('stripe-payments', jwt, { action: 'create_connect_onboarding_link', origin: 'http://localhost:5173' });
  if (r.status !== 200 || !r.body?.url) fail(`onboarding link: ${r.status} ${JSON.stringify(r.body)}`);
  const ca = must(await admin.from('connected_accounts').select('stripe_account_id, details_submitted, payouts_enabled').eq('account_id', S.companion.account_id).single(), 'connected account row');
  S.connected_account_id = ca.stripe_account_id; saveSnap(S);
  say({ connect: 'ready', destination_recorded: true, onboarding_url: r.body.url,
        note: 'Open the URL in the browser and complete Stripe test onboarding (E1).' });
}

async function verifyConnect() {
  const S = loadSnap();
  const { jwt } = await companionJwt(S);
  const r = await edge('stripe-payments', jwt, { action: 'refresh_connect_status' });
  if (r.status !== 200) fail(`refresh_connect_status: ${r.status}`);
  const ca = must(await admin.from('connected_accounts')
    .select('stripe_account_id, details_submitted, payouts_enabled, transfers_capability, requirements_past_due, disabled_reason, last_synced_at')
    .eq('account_id', S.companion.account_id).single(), 'connected account');
  check('connected account exists for fixture companion', !!ca.stripe_account_id);
  if (STRIPE_KEY) {
    const acct = await stripeGet(`accounts/${ca.stripe_account_id}`);
    check('provider account is TEST-mode express', acct.type === 'express' && acct.charges_enabled !== undefined);
    check('local projection matches provider payouts_enabled', Boolean(acct.payouts_enabled) === Boolean(ca.payouts_enabled));
  }
  say({ connect_status: { details_submitted: ca.details_submitted, payouts_enabled: ca.payouts_enabled,
    transfers_capability: ca.transfers_capability, past_due: ca.requirements_past_due?.length ?? 0,
    disabled_reason: ca.disabled_reason, last_synced_at: ca.last_synced_at } });
  console.log(`CONNECT RESULT pass=${pass} fail=${failCount}`);
  process.exitCode = failCount ? 1 : 0;
}

/* --------------------------- earnings fixtures ------------------------- */
// Sanctioned Stage 3C hosted-fixture technique: synthetic CONFIRMED past
// booking + SUCCEEDED order (service role; ordinary hosted-test records),
// then the Companion's REAL submit_companion_attendance RPC — the same
// authoritative path production uses — creates the earning. Release happens
// ONLY through the real public functions. No production eligibility rule is
// weakened; there is no test clock — bookings simply *are* in the past.
async function makeCase(S, comp, key, { offerId, orderType, subtotal, commission, credit, card, endedHoursAgo, planId = null, periodId = null }) {
  // Idempotent resume: if this case's order already exists (unique
  // idempotency key), reuse its booking/earning instead of recreating —
  // the companion no-overlap exclusion constraint makes duplicates impossible
  // anyway, and a resumed run must not fail on its own earlier progress.
  if (orderType !== 'plan_period_call') {
    const prior = must(await admin.from('payment_orders')
      .select('id, booking_id').eq('idempotency_key', `3efx-${key}-${S.suffix}`).maybeSingle(), `${key} prior order`);
    if (prior?.id) {
      const earning = must(await admin.from('companion_earnings')
        .select('id, state, basis_minor, commission_rate_pct, commission_minor, net_minor')
        .eq('booking_id', prior.booking_id).maybeSingle(), `${key} prior earning`);
      say(`${key}: reusing existing case (resume)`);
      return { bookingId: prior.booking_id, orderId: prior.id, earningId: earning?.id ?? null, earning };
    }
  }
  const start = new Date(Date.now() - (endedHoursAgo * 60 + 30) * 60_000);
  const end = new Date(start.getTime() + 30 * 60_000);
  const bookingIns = {
    member_profile_id: S.member_profile_id, companion_profile_id: S.companion_profile_id,
    booked_by_account_id: S.coordinator.account_id, offer_id: offerId,
    starts_at: start.toISOString(), ends_at: end.toISOString(), communication_method: 'in_app',
    status: 'confirmed', duration_minutes: 30, price_minor: subtotal, currency: 'GBP',
    platform_fee_rate: orderType === 'trial' ? 0 : 5, platform_fee_minor: commission,
    companion_amount_minor: subtotal - commission, is_trial: orderType === 'trial',
  };
  if (planId) bookingIns.plan_id = planId;
  const bookingId = must(await admin.from('bookings').insert(bookingIns).select('id').single(), `${key} booking`).id;
  let orderId = null;
  if (orderType !== 'plan_period_call') {
    orderId = must(await admin.from('payment_orders').insert({
      booking_id: bookingId, provider: 'stripe_test', coordinator_account_id: S.coordinator.account_id,
      member_profile_id: S.member_profile_id, companion_profile_id: S.companion_profile_id,
      order_type: orderType, status: 'succeeded', subtotal_minor: subtotal, discount_minor: 0,
      service_fee_minor: 0, credit_applied_minor: credit, card_amount_minor: card, total_minor: subtotal,
      commission_rate_pct: orderType === 'trial' ? 0 : 5, commission_minor: commission,
      idempotency_key: `3efx-${key}-${S.suffix}`,
    }).select('id').single(), `${key} order`).id;
  }
  // REAL authoritative earning path.
  must(await comp.client.rpc('submit_companion_attendance', { p_booking: bookingId, p_outcome: 'took_place', p_explanation: null }), `${key} attendance`);
  const earning = must(await admin.from('companion_earnings')
    .select('id, state, basis_minor, commission_rate_pct, commission_minor, net_minor')
    .eq('booking_id', bookingId).maybeSingle(), `${key} earning read`);
  checkpoint(`case ${key}`, { booking: bookingId, order: orderId, earning: earning?.id ?? null });
  return { bookingId, orderId, earningId: earning?.id ?? null, earning };
}

async function prepareEarnings() {
  const S = loadSnap();
  await assertRestingState();
  if (S.cases?.release_runs) { say('cases complete — prepare-earnings is idempotent.'); say(Object.keys(S.cases)); return; }
  const comp = await companionJwt(S);

  // Distinct, non-overlapping past windows: the companion no-overlap
  // exclusion constraint (production rule) forbids identical slots.
  const cases = S.cases ?? {};
  const done = async (k, v) => { cases[k] = v; S.cases = cases; saveSnap(S); return v; };
  await done('E3_trial', await makeCase(S, comp, 'e3', { offerId: S.trial_offer_id, orderType: 'trial', subtotal: TRIAL_MINOR, commission: 0, credit: 0, card: TRIAL_MINOR, endedHoursAgo: 26 }));
  await done('E4_regular_card', await makeCase(S, comp, 'e4', { offerId: S.single_offer_id, orderType: 'one_off', subtotal: REGULAR_MINOR, commission: REGULAR_COMMISSION, credit: 0, card: REGULAR_MINOR, endedHoursAgo: 28 }));
  await done('E5_credit_only', await makeCase(S, comp, 'e5', { offerId: S.single_offer_id, orderType: 'one_off', subtotal: REGULAR_MINOR, commission: REGULAR_COMMISSION, credit: REGULAR_MINOR, card: 0, endedHoursAgo: 30 }));
  await done('E6_mixed', await makeCase(S, comp, 'e6', { offerId: S.single_offer_id, orderType: 'one_off', subtotal: REGULAR_MINOR, commission: REGULAR_COMMISSION, credit: 1400, card: 200, endedHoursAgo: 32 }));

  // E7 plan-funded: real schema chain (package_offers -> package_purchases
  // allowance -> conversation_plans -> PAID plan_billing_periods) covering
  // exactly one completed call + one unused allowance (occurrences 2, one
  // booking only). The plan purchase itself must create NO earning.
  if (cases.E7_plan_call?.earningId) {
    say('e7: reusing existing case (resume)');
  } else {
  const planOrder = must(await admin.from('payment_orders').insert({
    coordinator_account_id: S.coordinator.account_id, member_profile_id: S.member_profile_id,
    companion_profile_id: S.companion_profile_id, order_type: 'plan_period', status: 'succeeded',
    subtotal_minor: REGULAR_MINOR * 2, discount_minor: 0, service_fee_minor: 0, credit_applied_minor: 0,
    card_amount_minor: REGULAR_MINOR * 2, total_minor: REGULAR_MINOR * 2, commission_rate_pct: 5,
    commission_minor: REGULAR_COMMISSION * 2, idempotency_key: `3efx-e7ord-${S.suffix}`,
  }).select('id').single(), 'e7 plan order').id;
  const pkgOffer = must(await admin.from('package_offers').insert({
    companion_id: S.companion_profile_id, kind: 'package', title: `3E plan allowance ${S.suffix}`,
    duration_mins: 30, call_count: 2, cadence: 'weekly', validity_days: 60,
    price_pence: REGULAR_MINOR * 2, active: false,
  }).select('id').single(), 'e7 package offer').id;
  const allowance = must(await admin.from('package_purchases').insert({
    buyer_id: S.member_profile_id, member_id: S.member_profile_id,
    companion_id: S.companion_profile_id, offer_id: pkgOffer, calls_total: 2, calls_used: 0,
    expires_at: new Date(Date.now() + 60 * 86_400_000).toISOString(), status: 'active',
    transaction_ref: `3efx-${S.suffix}`,
  }).select('id').single(), 'e7 allowance').id;
  const plan = must(await admin.from('conversation_plans').insert({
    member_profile_id: S.member_profile_id, companion_profile_id: S.companion_profile_id,
    created_by_account_id: S.coordinator.account_id, frequency_per_week: 2,
    duration_minutes: 30, communication_method: 'in_app',
    per_conversation_price_minor: REGULAR_MINOR, weekly_price_minor: REGULAR_MINOR * 2,
    status: 'active', allowance_purchase_id: allowance,
  }).select('id').single(), 'e7 plan').id;
  const monthStart = new Date(); monthStart.setUTCDate(1);
  const monthEnd = new Date(monthStart); monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
  const period = must(await admin.from('plan_billing_periods').insert({
    plan_id: plan, coordinator_account_id: S.coordinator.account_id,
    period_start: monthStart.toISOString().slice(0, 10), period_end: monthEnd.toISOString().slice(0, 10),
    status: 'paid', payment_order_id: planOrder, occurrences_count: 2,
    gross_minor: REGULAR_MINOR * 2, discount_minor: 0, net_minor: REGULAR_MINOR * 2,
    credit_applied_minor: 0, card_amount_minor: REGULAR_MINOR * 2,
  }).select('id').single(), 'e7 period').id;
  cases.E7_plan_call = await makeCase(S, comp, 'e7', { offerId: S.single_offer_id, orderType: 'plan_period_call', subtotal: REGULAR_MINOR, commission: REGULAR_COMMISSION, credit: 0, card: 0, endedHoursAgo: 34, planId: plan, periodId: period });
  cases.E7_plan_call.planId = plan; cases.E7_plan_call.periodId = period; cases.E7_plan_call.planOrderId = planOrder;
  S.cases = cases; saveSnap(S);
  }

  // E8 issue-held: completed call, then a REAL open issue from the coordinator.
  cases.E8_issue_held = await makeCase(S, comp, 'e8', { offerId: S.single_offer_id, orderType: 'one_off', subtotal: REGULAR_MINOR, commission: REGULAR_COMMISSION, credit: 0, card: REGULAR_MINOR, endedHoursAgo: 36 });
  S.cases = cases; saveSnap(S);
  const existingIssue = must(await admin.from('conversation_issues')
    .select('id').eq('booking_id', cases.E8_issue_held.bookingId).maybeSingle(), 'e8 issue check');
  if (existingIssue?.id) {
    cases.E8_issue_held.issue = existingIssue.id;
  } else {
    const coordClient = createClient(URL_, ANON, { auth: { persistSession: false } });
    const si = await coordClient.auth.signInWithPassword({ email: S.coordinator.email, password: S.coordinator.password });
    if (si.error) fail(`coordinator sign-in: ${si.error.message}`);
    const issue = must(await coordClient.rpc('report_conversation_issue', {
      p_booking: cases.E8_issue_held.bookingId, p_category: 'call_quality',
      p_description: 'Stage 3E validation: deliberate issue hold (E8).',
    }), 'e8 issue');
    cases.E8_issue_held.issue = issue?.id ?? issue;
  }

  // E9 release path: ended 26h ago -> the REAL scheduled function must
  // release it exactly once (run twice, idempotent).
  cases.E9_release = await makeCase(S, comp, 'e9', { offerId: S.single_offer_id, orderType: 'one_off', subtotal: REGULAR_MINOR, commission: REGULAR_COMMISSION, credit: 0, card: REGULAR_MINOR, endedHoursAgo: 38 });
  const rel1 = must(await admin.rpc('release_eligible_earnings'), 'release run 1');
  const rel2 = must(await admin.rpc('release_eligible_earnings'), 'release run 2');
  cases.release_runs = { first: rel1, second: rel2 };

  S.cases = cases; saveSnap(S);
  say({ prepared: Object.keys(cases), release_runs: cases.release_runs });
}

/* ---------------------- isolated transfer enablement ------------------- */
async function enableIsolatedTransfers() {
  const S = loadSnap();
  if (!S.connected_account_id) fail('run --prepare-connect and complete onboarding first');
  await assertRestingState(); // must start from resting; we raise from zero deliberately
  const ops = createClient(URL_, ANON, { auth: { persistSession: false } });
  const si = await ops.auth.signInWithPassword({ email: S.ops.email, password: S.ops.password });
  if (si.error) fail(`ops sign-in: ${si.error.message}`);
  // Allowlist ONLY the fixture destination (support-gated, audited RPC).
  must(await ops.rpc('support_set_transfer_destination_allowlist', {
    p_stripe_account_id: S.connected_account_id, p_active: true,
    p_reason: `Stage 3E hosted validation ${S.suffix}`,
  }), 'allowlist');
  // Raise ceilings to the fixture minimum (service-side config update).
  must(await admin.from('financial_operations_config').update({
    provider_transfer_amount_ceiling_minor: PER_TRANSFER_CEILING,
    provider_transfer_daily_ceiling_minor: DAILY_CEILING,
  }).eq('id', true).select('id'), 'ceilings');
  const { cfg } = await readControls();
  say({ enabled: true, destination: S.connected_account_id,
    per_transfer_ceiling: cfg.provider_transfer_amount_ceiling_minor,
    daily_ceiling: cfg.provider_transfer_daily_ceiling_minor,
    note: 'transfer_finalise remains DISABLED — each scoped run arms it itself.' });
}

/* -------------------------- restore controls --------------------------- */
async function restoreControls() {
  const S = existsSync(SNAP_FILE) ? loadSnap() : null;
  if (S?.connected_account_id) {
    const ops = createClient(URL_, ANON, { auth: { persistSession: false } });
    const si = await ops.auth.signInWithPassword({ email: S.ops.email, password: S.ops.password });
    if (!si.error) {
      await ops.rpc('support_set_transfer_destination_allowlist', {
        p_stripe_account_id: S.connected_account_id, p_active: false,
        p_reason: 'Stage 3E validation complete — restore resting state',
      });
    }
  }
  must(await admin.from('financial_operations_config').update({
    provider_transfer_amount_ceiling_minor: 0, provider_transfer_daily_ceiling_minor: 0,
  }).eq('id', true).select('id'), 'restore ceilings');
  await assertRestingState();
  say({ restored: true, resting_state: 'verified (env hosted_test, controls disabled, both ceilings 0, fixture allowlist deactivated)' });
}

/* ------------------------------ inspect -------------------------------- */
async function inspect(partial = false) {
  const S = existsSync(SNAP_FILE) ? JSON.parse(readFileSync(SNAP_FILE, 'utf-8')) : null;
  const { cfg, ctl } = await readControls();
  const out = { partial, controls: { environment: cfg.environment,
    per_transfer_ceiling: cfg.provider_transfer_amount_ceiling_minor,
    daily_ceiling: cfg.provider_transfer_daily_ceiling_minor,
    non_disabled: ctl.filter((c) => c.state !== 'disabled') } };
  if (S) {
    out.suffix = S.suffix;
    out.cases = Object.fromEntries(Object.entries(S.cases ?? {}).filter(([k]) => k.startsWith('E')).map(([k, v]) => [k, { booking: v.bookingId, earning: v.earningId }]));
    if (S.companion?.account_id) {
      const earnings = must(await admin.from('companion_earnings')
        .select('id, state, transfer_state, net_minor').eq('companion_account_id', S.companion.account_id), 'earnings');
      out.earnings = earnings;
      const attempts = must(await admin.from('companion_transfer_attempts')
        .select('id, earning_id, state, stripe_transfer_id, amount_minor').eq('companion_account_id', S.companion.account_id), 'attempts');
      out.attempts = attempts;
    }
  }
  if (existsSync(CKPT_FILE)) out.checkpoint = JSON.parse(readFileSync(CKPT_FILE, 'utf-8')).created.length;
  say(out);
}

/* -------------------------- verify foundation -------------------------- */
async function verifyFoundation() {
  const { cfg, ctl } = await readControls();
  check('environment hosted_test', cfg.environment === 'hosted_test');
  check('per-transfer ceiling column present + 0', cfg.provider_transfer_amount_ceiling_minor === 0);
  check('0084 daily ceiling column present + 0', cfg.provider_transfer_daily_ceiling_minor === 0);
  check('all financial controls disabled', ctl.every((c) => c.state === 'disabled'));
  const al = await admin.from('transfer_destination_allowlist').select('stripe_account_id', { count: 'exact', head: true });
  check('0084 allowlist table exists (RLS-forced; service read ok)', !al.error);
  // 0085 readers exist and are owner-scoped (anon call must fail closed).
  const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
  const sum = await anon.rpc('get_my_companion_earnings_summary');
  check('0085 summary refuses anonymous callers', !!sum.error);
  const q = await admin.rpc('support_payout_queue_overview');
  check('0086 queue overview exists (service caller not support -> refused OR support row)', !!q.error || !!q.data);
  console.log(`FOUNDATION RESULT pass=${pass} fail=${failCount}`);
  process.exitCode = failCount ? 1 : 0;
}

/* -------------------------- transfer execution ------------------------- */
// E5/E6: one real scoped transfer each. E10: repeat request for E5's earning
// (must be idempotent/no-second). E11: replay probe on the completed run.
// Uses the REAL support run RPCs + deployed scoped-stripe-transfers Edge.
async function runTransferCases() {
  const S = loadSnap();
  if (!S.cases?.E5_credit_only?.earningId) fail('run --prepare-earnings first');
  const ops = createClient(URL_, ANON, { auth: { persistSession: false } });
  const si = await ops.auth.signInWithPassword({ email: S.ops.email, password: S.ops.password });
  if (si.error) fail(`ops sign-in: ${si.error.message}`);
  const opsJwt = si.data.session.access_token;

  // The PROVEN 3C sequence: request (returns run_id + confirmation_token,
  // token stays in process memory) -> preview -> confirm -> ONE invocation
  // of the deployed scoped-stripe-transfers Edge Function. transfer_finalise
  // is armed to scoped_execution ONLY around execution and hard-restored in
  // finally, exactly like execute-c3-transfer.mjs.
  const setControl = async (from, to) => must(await ops.rpc('support_set_financial_control', {
    p_control: 'transfer_finalise', p_expected_state: from, p_new_state: to,
    p_reason: `Stage 3E matrix ${to}`, p_expires_at: null, p_confirmation: null,
  }), `control ${from}->${to}`);

  S.transfers = S.transfers ?? {};
  try {
    await setControl('disabled', 'scoped_execution');
    for (const key of ['E5_credit_only', 'E6_mixed']) {
      if (S.transfers[key]?.completed) { say(`${key} already transferred — skipping (idempotent).`); continue; }
      const earningId = mustUuid(S.cases[key].earningId, `${key} earning`);
      const rq = must(await ops.rpc('support_request_operation_run', {
        p_operation_type: 'transfer_finalise', p_execution_mode: 'execute', p_scope_type: 'record_ids',
        p_scoped_ids: [earningId], p_batch_limit: null, p_reason: `Stage 3E ${key}`,
      }), `${key} run request`);
      const runId = mustUuid(rq.run_id, `${key} run id`);
      const token = rq.confirmation_token; // memory only — never persisted/printed
      must(await ops.rpc('support_preview_operation_run', { p_run_id: runId }), `${key} preview`);
      must(await ops.rpc('support_confirm_operation_run', { p_run_id: runId, p_confirmation_token: token }), `${key} confirm`);
      const r = await edge('scoped-stripe-transfers', opsJwt, { run_id: runId, confirmation_token: token });
      if (r.status !== 200) fail(`${key} edge execution: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      S.transfers[key] = { runId, completed: true, summary: r.body?.summary ?? null };
      saveSnap(S);
      say({ [key]: { runId, completed: true } });
    }

    // E10: a SECOND run scoped to the already-transferred E5 earning must
    // show ZERO eligible records (no second transfer is even preparable).
    const e5 = mustUuid(S.cases.E5_credit_only.earningId, 'E5 earning');
    const rq2 = must(await ops.rpc('support_request_operation_run', {
      p_operation_type: 'transfer_finalise', p_execution_mode: 'execute', p_scope_type: 'record_ids',
      p_scoped_ids: [e5], p_batch_limit: null, p_reason: 'Stage 3E E10 duplicate-request probe',
    }), 'E10 run request');
    const run2 = mustUuid(rq2.run_id, 'E10 run id');
    const prev2 = must(await ops.rpc('support_preview_operation_run', { p_run_id: run2 }), 'E10 preview');
    must(await ops.rpc('support_cancel_operation_run', { p_run_id: run2, p_reason: 'E10 probe complete' }), 'E10 cancel');
    S.transfers.E10_duplicate_probe = { runId: run2, preview: prev2 };
    saveSnap(S);
    say({ E10_duplicate_probe: prev2 });
  } finally {
    await setControl('scoped_execution', 'disabled'); // hard restore even on failure
  }
  say('transfer cases complete — run --restore-controls, then --verify.');
}

/* -------------------------------- verify ------------------------------- */
async function verify() {
  const S = loadSnap();
  const C = S.cases ?? {};
  const byKey = async (k) => C[k]?.earningId
    ? must(await admin.from('companion_earnings').select('*').eq('id', C[k].earningId).single(), k) : null;

  // E3 trial economics.
  const e3 = await byKey('E3_trial');
  check('E3 trial earning exists exactly once with 0% commission',
    !!e3 && Number(e3.commission_rate_pct) === 0 && e3.commission_minor === 0 && e3.net_minor === TRIAL_MINOR, JSON.stringify(e3));
  // E4 regular snapshot economics.
  const e4 = await byKey('E4_regular_card');
  check('E4 regular earning uses the 5% snapshot',
    !!e4 && Number(e4.commission_rate_pct) === 5 && e4.commission_minor === REGULAR_COMMISSION && e4.net_minor === REGULAR_NET);
  // E5/E6 funding-mix equivalence.
  const e5 = await byKey('E5_credit_only'); const e6 = await byKey('E6_mixed');
  check('E5/E6 credit-only and mixed produce the SAME earning as card (funding-mix independent)',
    !!e5 && !!e6 && e5.net_minor === REGULAR_NET && e6.net_minor === REGULAR_NET && e4.net_minor === e5.net_minor);
  // E7 package/plan: exactly one earning for the completed call; the plan
  // purchase itself created none; the unused allowance created none.
  const e7 = await byKey('E7_plan_call');
  const planEarnings = safeCount(await admin.from('companion_earnings')
    .select('id', { count: 'exact', head: true }).eq('plan_id', C.E7_plan_call?.planId ?? '00000000-0000-4000-8000-000000000000'), 'plan earnings');
  check('E7 one completed plan call -> exactly one earning; unused allowance -> none',
    !!e7 && planEarnings === 1 && e7.net_minor === REGULAR_NET);
  // E8 issue hold, no transfer.
  const e8 = await byKey('E8_issue_held');
  const e8Attempts = safeCount(await admin.from('companion_transfer_attempts')
    .select('id', { count: 'exact', head: true }).eq('earning_id', C.E8_issue_held?.earningId ?? e5.id), 'e8 attempts');
  check('E8 open issue holds the earning and no transfer exists',
    !!e8 && e8.state !== 'payable' && e8.transfer_state === 'not_ready' && e8Attempts === 0, `state=${e8?.state}`);
  // E9 released exactly once by the REAL scheduled function.
  const e9 = await byKey('E9_release');
  check('E9 12h/no-issue earning became payable via release_eligible_earnings (idempotent runs)',
    !!e9 && e9.state === 'payable');
  // E5/E6 exactly-once transfers + provider truth.
  for (const key of ['E5_credit_only', 'E6_mixed']) {
    const earning = key === 'E5_credit_only' ? e5 : e6;
    const attempts = must(await admin.from('companion_transfer_attempts')
      .select('id, state, stripe_transfer_id, amount_minor, currency, connected_account_id, idempotency_key')
      .eq('earning_id', earning.id), `${key} attempts`);
    check(`${key} exactly one attempt, succeeded, one provider id`,
      attempts.length === 1 && attempts[0].state === 'succeeded' && !!attempts[0].stripe_transfer_id);
    const t = attempts[0];
    check(`${key} amount/currency/destination match the immutable earning`,
      t.amount_minor === earning.net_minor && t.currency === 'GBP' && t.connected_account_id === S.connected_account_id);
    if (STRIPE_KEY && t.stripe_transfer_id) {
      const pt = await stripeGet(`transfers/${t.stripe_transfer_id}`);
      check(`${key} provider transfer livemode=false, amount + destination agree`,
        pt.livemode === false && pt.amount === t.amount_minor && pt.destination === S.connected_account_id);
    }
    const post = must(await admin.from('companion_earnings').select('transfer_state').eq('id', earning.id).single(), `${key} post`);
    check(`${key} earning projected transferred`, post.transfer_state === 'transferred');
  }
  // E10: duplicate probe created no second transfer.
  const e5Attempts = safeCount(await admin.from('companion_transfer_attempts')
    .select('id', { count: 'exact', head: true }).eq('earning_id', e5.id), 'e5 attempts');
  check('E10 duplicate run request created NO second transfer', e5Attempts === 1);
  // E16 controls: verify runs AFTER --restore-controls in the closeout order.
  const { cfg, ctl } = await readControls();
  check('E16 resting state: both ceilings 0 and all controls disabled',
    cfg.provider_transfer_amount_ceiling_minor === 0 && cfg.provider_transfer_daily_ceiling_minor === 0
    && ctl.every((c) => c.state === 'disabled'));
  // E17 projections agree with durable rows.
  const compC = await companionJwt(S);
  const summary = must(await compC.client.rpc('get_my_companion_earnings_summary'), 'summary');
  const transferredRow = (summary ?? []).find((r) => r.bucket === 'transferred');
  check('E17 companion projection matches durable state (2 transferred earnings)',
    Number(transferredRow?.earnings_count ?? 0) === 2 && Number(transferredRow?.net_minor ?? 0) === REGULAR_NET * 2,
    JSON.stringify(summary));
  // Stage 3C sentinels untouched.
  const sentinel = must(await admin.from('companion_earnings')
    .select('state, transfer_state, net_minor').eq('id', '71ecc62b-cfd5-4e46-9fd1-ae00223dc2a2').single(), 'sentinel');
  check('Stage 3C protected sentinel unchanged',
    sentinel.state === 'payable' && sentinel.transfer_state === 'failed' && sentinel.net_minor === 950);
  // Baseline deltas: every new earning/attempt belongs to this fixture.
  const totalEarnings = safeCount(await admin.from('companion_earnings').select('id', { count: 'exact', head: true }), 'earnings now');
  const fixtureEarnings = safeCount(await admin.from('companion_earnings')
    .select('id', { count: 'exact', head: true }).eq('companion_account_id', S.companion.account_id), 'fixture earnings');
  check('earning delta fully explained by this fixture',
    totalEarnings - S.baseline.earnings === fixtureEarnings, `delta=${totalEarnings - S.baseline.earnings} fixture=${fixtureEarnings}`);
  console.log(`VERIFY RESULT pass=${pass} fail=${failCount}`);
  process.exitCode = failCount ? 1 : 0;
}

/* -------------------------------- report ------------------------------- */
async function report() {
  const S = loadSnap();
  const { cfg, ctl } = await readControls();
  const attempts = must(await admin.from('companion_transfer_attempts')
    .select('id, earning_id, state, stripe_transfer_id, amount_minor')
    .eq('companion_account_id', S.companion.account_id), 'attempts');
  const out = {
    fixture_suffix: S.suffix,
    labels: S.labels,
    migrations: ['0084_transfer_rollout_controls_hardening', '0085_companion_earnings_projection', '0086_support_payout_queue_overview'],
    cases: Object.fromEntries(Object.entries(S.cases ?? {}).filter(([k]) => k.startsWith('E'))
      .map(([k, v]) => [k, { booking_id: v.bookingId, earning_id: v.earningId }])),
    transfers: attempts.map((a) => ({ attempt_id: a.id, earning_id: a.earning_id, state: a.state,
      stripe_transfer_id: a.stripe_transfer_id, amount_minor: a.amount_minor })),
    controls_now: { environment: cfg.environment,
      per_transfer_ceiling: cfg.provider_transfer_amount_ceiling_minor,
      daily_ceiling: cfg.provider_transfer_daily_ceiling_minor,
      non_disabled: ctl.filter((c) => c.state !== 'disabled').map((c) => c.control_name) },
    production_blocker: 'APP_ORIGINS still targets the local development origin; replace with the exact production origin before launch.',
    generated_at: new Date().toISOString(),
  };
  writeFileSync(REPORT_FILE, JSON.stringify(out, null, 2));
  say(out);
  say(`written to ${REPORT_FILE} (secrets-free)`);
}

/* -------------------------------- cleanup ------------------------------ */
async function cleanup() {
  if (argOf('--confirm-cleanup') !== 'CLEANUP-3E-FIXTURE') {
    fail('cleanup additionally requires --confirm-cleanup "CLEANUP-3E-FIXTURE"');
  }
  const S = loadSnap();
  // REFUSE where financial history exists: earnings/attempts/transfers are
  // immutable history and must be retained (consistent with every prior stage).
  const earnings = safeCount(await admin.from('companion_earnings')
    .select('id', { count: 'exact', head: true }).eq('companion_account_id', S.companion.account_id), 'earnings');
  const attempts = safeCount(await admin.from('companion_transfer_attempts')
    .select('id', { count: 'exact', head: true }).eq('companion_account_id', S.companion.account_id), 'attempts');
  if (earnings > 0 || attempts > 0) {
    fail(`fixture has financial history (earnings=${earnings}, attempts=${attempts}) — retained by policy; nothing deleted`);
  }
  say('no financial history — only auth users/profiles would be removable; leaving hosted-test records in place (consistent with prior stages). Nothing deleted.');
}

/* --------------------------------- main -------------------------------- */
(async () => {
  if (args.includes('--preflight')) return preflight();
  if (args.includes('--inspect')) return inspect(false);
  if (args.includes('--inspect-partial')) return inspect(true);
  if (args.includes('--verify-foundation')) return verifyFoundation();
  if (args.includes('--prepare-connect')) return prepareConnect();
  if (args.includes('--verify-connect')) return verifyConnect();
  if (args.includes('--prepare-earnings')) return prepareEarnings();
  if (args.includes('--enable-isolated-transfers')) return enableIsolatedTransfers();
  if (args.includes('--run-transfer-cases')) return runTransferCases();
  if (args.includes('--verify')) return verify();
  if (args.includes('--report')) return report();
  if (args.includes('--restore-controls')) return restoreControls();
  if (args.includes('--cleanup')) return cleanup();
  fail('choose a mode: --preflight | --inspect | --verify-foundation | --prepare-connect | --verify-connect | --prepare-earnings | --enable-isolated-transfers | --run-transfer-cases | --verify | --report | --restore-controls | --inspect-partial | --cleanup');
})();
