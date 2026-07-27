#!/usr/bin/env node
/**
 * Pilot full-reset operator tool — READ-ONLY plan + Storage-object purge.
 *
 * Runs on YOUR machine with the pilot service-role key. Guarded to the pilot
 * project. Two modes:
 *   node scripts/pilot-reset.mjs --plan               # read-only report (default)
 *   node scripts/pilot-reset.mjs --execute-storage --confirm RESET-PILOT-STORAGE-DATA
 *
 * The SQL data reset is separate: scripts/reset-pilot-data.sql (run in the
 * Supabase SQL Editor). Order of operations: --plan  ->  --execute-storage  ->
 * reset-pilot-data.sql. This script NEVER touches storage.objects via SQL and
 * NEVER deletes data tables; it only reports, and purges Storage objects via the
 * Storage API (buckets are preserved).
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (never printed).
 */
import { createClient } from '@supabase/supabase-js';

const EXPECT = process.env.PILOT_EXPECT_PROJECT_REF ?? 'gwtunmoefapiiybwlelw';
const URL = process.env.SUPABASE_URL ?? '';
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

if (!URL || !SVC) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.'); process.exit(2); }
if (!URL.includes(EXPECT)) {
  console.error(`Refusing to run: SUPABASE_URL is not the pilot project (${EXPECT}).`);
  process.exit(2);
}
const db = createClient(URL, SVC, { auth: { persistSession: false } });

// Runtime tables in the exact child->parent FK delete order proven on a scratch
// database (mirrors scripts/reset-pilot-data.sql). accounts + auth.users are
// cleared last by the SQL (accounts, then auth.users).
const RUNTIME_TABLES = [
  'availability_exceptions',
  'availability_rules',
  'booking_status_history',
  'booking_time_proposals',
  'call_attendance_evidence',
  'call_attendance_segments',
  'call_participants',
  'call_provider_events',
  'call_token_audits',
  'companion_evidence_payout_review_events',
  'companion_moderation_events',
  'companion_profiles',
  'completion_confirmations',
  'connected_accounts',
  'consent_acknowledgements',
  'conversation_attendance',
  'conversation_concerns',
  'conversation_read_state',
  'conversation_reviews',
  'coordinator_profiles',
  'credit_spend_allocations',
  'dispute_deadline_alerts',
  'dispute_manual_evidence',
  'dispute_notes',
  'dispute_support_audit',
  'email_outbox',
  'favourites',
  'financial_operation_control_events',
  'financial_operation_run_events',
  'financial_operation_run_items',
  'financial_reconciliation_audit',
  'managed_relationships',
  'member_profiles',
  'messages',
  'notification_preferences',
  'package_credit_ledger',
  'payment_dispute_earnings',
  'plan_generation_log',
  'plan_schedule_slots',
  'post_conversation_run_audit',
  'profile_access',
  'profile_interests',
  'profile_private_details',
  'ratings',
  'reports',
  'scoped_transfer_execution_jobs',
  'stripe_customers',
  'stripe_webhook_events',
  'support_admins',
  'transactions',
  'transfer_destination_allowlist',
  'transfer_destination_allowlist_events',
  'user_blocks',
  'companion_evidence_payout_reviews',
  'credit_ledger',
  'dispute_support_cases',
  'financial_operation_runs',
  'financial_reconciliation_findings',
  'guest_call_invitations',
  'notifications',
  'settlement_adjustments',
  'call_sessions',
  'companion_transfer_attempts',
  'conversations',
  'financial_reconciliation_runs',
  'payment_disputes',
  'payment_refunds',
  'issue_resolutions',
  'conversation_issues',
  'companion_earnings',
  'plan_billing_periods',
  'payment_orders',
  'bookings',
  'conversation_offers',
  'conversation_plans',
  'package_purchases',
  'package_offers',
  'profiles'
];
const PRESERVE = ['consent_policies', 'platform_commission_config', 'platform_service_fee_config', 'platform_config', 'financial_operations_config', 'financial_operation_controls', 'interests', 'call_config'];

async function tableCount(t) {
  const { count, error } = await db.from(t).select('*', { count: 'exact', head: true });
  return error ? `err(${error.code||error.message})` : (count ?? 0);
}
async function authUserCount() {
  let n = 0, page = 1;
  for (;;) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return `err(${error.message})`;
    n += data.users.length;
    if (data.users.length < 1000) break;
    page += 1;
  }
  return n;
}
async function storageReport() {
  const { data: buckets, error } = await db.storage.listBuckets();
  if (error) return { error: error.message };
  const out = [];
  for (const b of buckets) {
    let total = 0;
    // shallow top-level listing count (report only; purge walks fully)
    const { data, error: le } = await db.storage.from(b.id).list('', { limit: 1000 });
    if (!le && data) total = data.length + (data.length === 1000 ? '+' : '');
    out.push({ bucket: b.id, public: b.public, topLevelObjects: total });
  }
  return { buckets: out };
}

async function plan() {
  console.log(`\n=== PILOT RESET PLAN (read-only)  project=${EXPECT} ===\n`);
  const authN = await authUserCount();
  console.log(`auth.users: ${authN}`);
  console.log(`\n-- Runtime tables to CLEAR (${RUNTIME_TABLES.length}) + accounts + auth.users, in FK order --`);
  let nonzero = 0;
  for (const t of RUNTIME_TABLES) {
    const c = await tableCount(t);
    if (c !== 0) { nonzero++; console.log(`  ${String(c).padStart(8)}  ${t}`); }
  }
  const acct = await tableCount('accounts');
  console.log(`  ${String(acct).padStart(8)}  accounts`);
  console.log(`\n  (${nonzero} of ${RUNTIME_TABLES.length} runtime tables currently non-empty; empty ones omitted)`);
  console.log(`\n-- PRESERVED configuration (NOT cleared) --`);
  for (const t of PRESERVE) console.log(`  ${String(await tableCount(t)).padStart(8)}  ${t}`);
  console.log(`\n-- Storage (buckets preserved; objects purged via --execute-storage) --`);
  console.log(JSON.stringify(await storageReport(), null, 2));
  console.log(`\n-- FK delete ordering: children first, parents last; full ordered list is`);
  console.log(`   embedded above and in scripts/reset-pilot-data.sql (78 tables) --`);
  console.log(`\nNext: run --execute-storage, then reset-pilot-data.sql in the SQL Editor.`);
}

async function executeStorage() {
  if (val('--confirm') !== 'RESET-PILOT-STORAGE-DATA') {
    console.error('Refusing: pass  --confirm RESET-PILOT-STORAGE-DATA  to purge Storage objects.');
    process.exit(2);
  }
  const { data: buckets, error } = await db.storage.listBuckets();
  if (error) { console.error('listBuckets: ' + error.message); process.exit(1); }
  let removed = 0;
  for (const b of buckets) {
    console.log(`Bucket ${b.id}: purging objects (bucket preserved)…`);
    // Recursively walk folders; remove in batches of 100 (Storage API supported).
    const walk = async (prefix) => {
      let offset = 0;
      for (;;) {
        const { data, error: le } = await db.storage.from(b.id).list(prefix, { limit: 100, offset });
        if (le) { console.error(`  list ${prefix}: ${le.message}`); return; }
        if (!data || data.length === 0) break;
        const files = data.filter((o) => o.id).map((o) => (prefix ? prefix + '/' : '') + o.name);
        const folders = data.filter((o) => !o.id).map((o) => (prefix ? prefix + '/' : '') + o.name);
        if (files.length) {
          const { error: re } = await db.storage.from(b.id).remove(files);
          if (re) console.error(`  remove: ${re.message}`); else { removed += files.length; console.log(`  removed ${files.length} (running total ${removed})`); }
        }
        for (const f of folders) await walk(f);
        if (data.length < 100) break;
        offset += 100;
      }
    };
    await walk('');
  }
  console.log(`\nDone. Removed ${removed} object(s). Buckets left intact:`, buckets.map((b) => b.id).join(', '));
}

const mode = has('--execute-storage') ? executeStorage : plan;
mode().catch((e) => { console.error(e.message ?? e); process.exit(1); });
