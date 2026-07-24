#!/usr/bin/env node
/**
 * Stage 3C2-C3 Gate 6 — create ONE fresh hosted-test payout fixture.
 *
 * Mirrors the audited Stage 3C2-C hosted fixture family (fresh auth users,
 * profiles, access, offer, confirmed ended booking, succeeded order,
 * took_place declaration -> ONE payable 950-minor GBP earning) plus the fresh
 * connected-account mapping for the approved TEST destination. Uses ONLY the
 * sanctioned paths: auth admin createUser, ensure_current_account,
 * submit_companion_attendance (the authoritative earning path), admin table
 * inserts identical to the hosted suites, and the support preview RPCs.
 *
 * It does NOT: enable any control, change the ceiling, create a run in
 * execute mode, create an attempt or scoped job, or contact Stripe.
 *
 * Run ONCE. Env (never printed): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * SUPABASE_ANON_KEY, DESTINATION_ACCT (the approved acct_... id).
 * Optional: FIXTURE_EMAIL_DOMAIN (default example.com).
 */
import { createClient } from '@supabase/supabase-js';

const PROJECT_REF = 'gwtunmoefapiiybwlelw';
const fail = (m) => { console.error(`ABORT: ${m}`); process.exit(1); };

for (const [k, v] of Object.entries(process.env)) {
  if (typeof v === 'string' && v.startsWith('sk_live_')) fail(`live Stripe key material in env ${k}`);
}
const URL_ = process.env.SUPABASE_URL ?? '';
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
const DEST = process.env.DESTINATION_ACCT ?? '';
const DOMAIN = process.env.FIXTURE_EMAIL_DOMAIN ?? 'example.com';
if (!URL_ || !SVC || !ANON) fail('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required.');
if (!URL_.includes(PROJECT_REF)) fail(`SUPABASE_URL is not project ${PROJECT_REF}.`);
if (!/^acct_[A-Za-z0-9]+$/.test(DEST)) fail('DESTINATION_ACCT must be the approved test acct_... id.');
if (DEST === 'acct_1Tuhb4DLUvn4PHJ4') fail('protected destination refused.');

const admin = createClient(URL_, SVC, { auth: { persistSession: false } });
const suffix = `c3fx${Date.now().toString(36)}`;
const pw = `Fx!${crypto.randomUUID()}`;

async function newUser(tag) {
  const email = `${tag}-${suffix}@${DOMAIN}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (error) fail(`createUser ${tag}: ${error.message}`);
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  const s = await client.auth.signInWithPassword({ email, password: pw });
  if (s.error) fail(`signIn ${tag}: ${s.error.message}`);
  const e = await client.rpc('ensure_current_account');
  if (e.error) fail(`ensure_current_account ${tag}: ${e.error.message}`);
  return { id: data.user.id, client, email };
}
const must = (r, what) => { if (r.error) fail(`${what}: ${JSON.stringify(r.error)}`); return r.data; };

(async () => {
  // Pre-flight sentinels: environment + controls + ceiling untouched.
  const cfg = must(await admin.from('financial_operations_config')
    .select('environment, provider_transfer_amount_ceiling_minor').single(), 'config');
  if (cfg.environment !== 'hosted_test') fail(`environment ${cfg.environment}`);
  if (cfg.provider_transfer_amount_ceiling_minor !== 0) fail('ceiling not 0');
  const ctl = must(await admin.from('financial_operation_controls').select('control_name, state'), 'controls');
  if (!ctl.every((c) => c.state === 'disabled')) fail('a control is not disabled');
  // Destination must still be unmapped + clean.
  const mapped = must(await admin.from('connected_accounts').select('account_id').eq('stripe_account_id', DEST), 'map check');
  if (mapped.length > 0) fail('destination already mapped — investigate before creating a fixture.');

  console.log(`creating fixture (suffix ${suffix}) ...`);
  const coord = await newUser('c3-coord');
  const memberOwner = await newUser('c3-member');
  const companion = await newUser('c3-comp');
  const ops = await newUser('c3-ops');
  must(await admin.from('support_admins').upsert({ account_id: ops.id }, { onConflict: 'account_id', ignoreDuplicates: true }), 'support admin');

  // Fresh connected-account mapping for the approved TEST destination.
  must(await admin.from('connected_accounts').insert({
    account_id: companion.id, stripe_account_id: DEST, payouts_enabled: true,
    details_submitted: true, transfers_capability: 'active', default_currency: 'gbp',
  }).select('account_id'), 'connected_accounts');

  const compProfile = must(await admin.from('profiles').insert({ role: 'companion', first_name: 'C3Comp' }).select('id').single(), 'companion profile').id;
  must(await admin.from('profile_access').insert({ account_id: companion.id, profile_id: compProfile, access_role: 'owner', can_edit: true, can_book: true }), 'companion access');
  const offerId = must(await admin.from('conversation_offers').insert({
    companion_profile_id: compProfile, offer_type: 'single', duration_minutes: 30, price_minor: 1000, supported_methods: ['in_app'],
  }).select('id').single(), 'offer').id;
  const memProfile = must(await admin.from('profiles').insert({ role: 'member', first_name: 'C3Mem' }).select('id').single(), 'member profile').id;
  must(await admin.from('profile_access').insert([
    { account_id: memberOwner.id, profile_id: memProfile, access_role: 'owner', can_edit: true, can_book: true },
    { account_id: coord.id, profile_id: memProfile, access_role: 'coordinator', can_edit: true, can_book: true },
  ]), 'member access');

  const start = new Date(Date.now() - 70 * 60_000);
  const end = new Date(start.getTime() + 30 * 60_000);
  const bookingId = must(await admin.from('bookings').insert({
    member_profile_id: memProfile, companion_profile_id: compProfile, booked_by_account_id: coord.id,
    offer_id: offerId, starts_at: start.toISOString(), ends_at: end.toISOString(),
    communication_method: 'in_app', status: 'confirmed', duration_minutes: 30,
    price_minor: 1000, platform_fee_rate: 5, platform_fee_minor: 50, companion_amount_minor: 950,
  }).select('id').single(), 'booking').id;
  const orderId = must(await admin.from('payment_orders').insert({
    booking_id: bookingId, provider: 'stripe_test', coordinator_account_id: coord.id,
    member_profile_id: memProfile, companion_profile_id: compProfile, order_type: 'one_off',
    status: 'succeeded', subtotal_minor: 1000, discount_minor: 0, service_fee_minor: 0,
    credit_applied_minor: 0, card_amount_minor: 1000, total_minor: 1000,
    commission_rate_pct: 5, commission_minor: 50, idempotency_key: `c3fx-ord-${bookingId}`,
  }).select('id').single(), 'order').id;

  // AUTHORITATIVE earning path: the Companion declares took_place.
  must(await companion.client.rpc('submit_companion_attendance', { p_booking: bookingId, p_outcome: 'took_place', p_explanation: null }), 'attendance');
  const earning = must(await admin.from('companion_earnings')
    .select('id, state, transfer_state, net_minor, currency').eq('booking_id', bookingId).single(), 'earning');
  must(await admin.from('companion_earnings')
    .update({ payment_order_id: orderId, state: 'payable', payable_at: new Date().toISOString() })
    .eq('id', earning.id).select('id'), 'make payable');

  // ---- read-only verification ----
  const after = must(await admin.from('companion_earnings')
    .select('id, state, transfer_state, net_minor, currency').eq('id', earning.id).single(), 'earning verify');
  const attempts = must(await admin.from('companion_transfer_attempts').select('id').eq('earning_id', earning.id), 'attempts');
  const jobs = must(await admin.from('scoped_transfer_execution_jobs').select('id').eq('earning_id', earning.id), 'jobs');
  const findings = must(await admin.from('financial_reconciliation_findings').select('id').eq('primary_entity_id', earning.id), 'findings');
  const issues = must(await admin.from('conversation_issues').select('id').eq('booking_id', bookingId), 'issues');
  const holds = must(await admin.from('companion_evidence_payout_reviews').select('id').eq('booking_id', bookingId), 'holds');
  const ca = must(await admin.from('connected_accounts')
    .select('stripe_account_id, details_submitted, payouts_enabled, transfers_capability, default_currency, disabled_reason, requirements_past_due')
    .eq('account_id', companion.id).single(), 'mapping verify');

  // transfer_finalise PREVIEW via the support surface (preview-mode run; no mutation).
  const req = must(await ops.client.rpc('support_request_operation_run', {
    p_operation_type: 'transfer_finalise', p_execution_mode: 'preview', p_scope_type: 'record_ids',
    p_scoped_ids: [earning.id], p_batch_limit: null, p_reason: 'C3 Gate 6 preview',
  }), 'preview request');
  const prev = must(await ops.client.rpc('support_preview_operation_run', { p_run_id: req.run_id }), 'preview');
  const row = (prev.rows ?? [])[0] ?? {};

  const cfg2 = must(await admin.from('financial_operations_config')
    .select('environment, provider_transfer_amount_ceiling_minor').single(), 'config after');
  const ctl2 = must(await admin.from('financial_operation_controls').select('state'), 'controls after');

  console.log(JSON.stringify({
    fixture: {
      coordinator_account: coord.id, member_owner_account: memberOwner.id,
      companion_account: companion.id, ops_account: ops.id,
      companion_profile: compProfile, member_profile: memProfile,
      offer_id: offerId, booking_id: bookingId, order_id: orderId,
      earning_id: earning.id, preview_run_id: req.run_id,
    },
    earning: after,
    connected_account: { ...ca, past_due: (ca.requirements_past_due ?? []).length },
    clean: { attempts: attempts.length, scoped_jobs: jobs.length, findings: findings.length, issues: issues.length, evidence_holds: holds.length },
    preview_row: {
      id: row.id, found: row.found, outcome: row.outcome, eligible: row.eligible,
      amount_minor: row.amount_minor, currency: row.currency,
      provider_lookup_required: row.provider_lookup_required, destination_ready: row.destination_ready,
    },
    state_after: { environment: cfg2.environment, ceiling: cfg2.provider_transfer_amount_ceiling_minor,
      controls_all_disabled: ctl2.every((c) => c.state === 'disabled') },
  }, null, 2));
})().catch((e) => fail(e?.message ?? String(e)));
