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
 * Supabase SQL Editor). Order: --plan -> --execute-storage -> reset-pilot-data.sql.
 * This script NEVER touches storage.objects via SQL and NEVER deletes data
 * tables; it only reports, and purges Storage objects via the Storage API
 * (buckets are preserved).
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (never printed).
 */
import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';

export const EXPECT_PROJECT_REF = process.env.PILOT_EXPECT_PROJECT_REF ?? 'gwtunmoefapiiybwlelw';

// Runtime tables in the exact child->parent FK delete order proven on a scratch
// database (mirrors scripts/reset-pilot-data.sql). accounts + auth.users are
// cleared last by the SQL.
export const RUNTIME_TABLES = [
  'availability_exceptions', 'availability_rules', 'booking_status_history',
  'booking_time_proposals', 'call_attendance_evidence', 'call_attendance_segments',
  'call_participants', 'call_provider_events', 'call_token_audits',
  'companion_evidence_payout_review_events', 'companion_moderation_events',
  'companion_profiles', 'completion_confirmations', 'connected_accounts',
  'consent_acknowledgements', 'conversation_attendance', 'conversation_concerns',
  'conversation_read_state', 'conversation_reviews', 'coordinator_profiles',
  'credit_spend_allocations', 'dispute_deadline_alerts', 'dispute_manual_evidence',
  'dispute_notes', 'dispute_support_audit', 'email_outbox', 'favourites',
  'financial_operation_control_events', 'financial_operation_run_events',
  'financial_operation_run_items', 'financial_reconciliation_audit',
  'managed_relationships', 'member_profiles', 'messages', 'notification_preferences',
  'package_credit_ledger', 'payment_dispute_earnings', 'plan_generation_log',
  'plan_schedule_slots', 'post_conversation_run_audit', 'profile_access',
  'profile_interests', 'profile_private_details', 'ratings', 'reports',
  'scoped_transfer_execution_jobs', 'stripe_customers', 'stripe_webhook_events',
  'support_admins', 'transactions', 'transfer_destination_allowlist',
  'transfer_destination_allowlist_events', 'user_blocks',
  'companion_evidence_payout_reviews', 'credit_ledger', 'dispute_support_cases',
  'financial_operation_runs', 'financial_reconciliation_findings',
  'guest_call_invitations', 'notifications', 'settlement_adjustments',
  'call_sessions', 'companion_transfer_attempts', 'conversations',
  'financial_reconciliation_runs', 'payment_disputes', 'payment_refunds',
  'issue_resolutions', 'conversation_issues', 'companion_earnings',
  'plan_billing_periods', 'payment_orders', 'bookings', 'conversation_offers',
  'conversation_plans', 'package_purchases', 'package_offers', 'profiles',
];
export const PRESERVE = [
  'consent_policies', 'platform_commission_config', 'platform_service_fee_config',
  'platform_config', 'financial_operations_config', 'financial_operation_controls',
  'interests', 'call_config',
];

/* =========================================================================
 * Storage purge — pure + testable. `bucketApi` is a Supabase storage bucket
 * handle: { list(prefix, {limit, offset}), remove(paths[]) }.
 * ========================================================================= */

/**
 * List EVERY object path under a bucket (recursing folders), fully paginated.
 * Listing does not mutate, so offset advances correctly for every page — this
 * is the key fix: we never delete while paginating.
 */
export async function listAllFiles(bucketApi, prefix = '', batchSize = 100) {
  const files = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await bucketApi.list(prefix, { limit: batchSize, offset });
    if (error) throw new Error(`list("${prefix}") failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const o of data) {
      const path = prefix ? `${prefix}/${o.name}` : o.name;
      if (o.id) files.push(path);                                 // a real object
      else files.push(...await listAllFiles(bucketApi, path, batchSize)); // a folder
    }
    if (data.length < batchSize) break;
    offset += data.length;
  }
  return files;
}

/**
 * Delete every object in a bucket, in remove-batches. Throws on ANY list or
 * remove error (caller turns that into a non-zero exit). Idempotent: an
 * already-empty bucket removes 0 and succeeds. The bucket itself is never
 * deleted.
 */
export async function purgeBucket(bucketApi, { batchSize = 100, onProgress } = {}) {
  const files = await listAllFiles(bucketApi, '', batchSize);
  let removed = 0;
  for (let i = 0; i < files.length; i += batchSize) {
    const chunk = files.slice(i, i + batchSize);
    const { error } = await bucketApi.remove(chunk);
    if (error) {
      throw new Error(`remove batch failed after ${removed} deleted: ${error.message}`);
    }
    removed += chunk.length;
    if (onProgress) onProgress(removed, files.length);
  }
  // Verify empty (fail closed if anything remains, e.g. writes mid-purge).
  const leftover = await listAllFiles(bucketApi, '', batchSize);
  if (leftover.length > 0) {
    throw new Error(`bucket not empty after purge: ${leftover.length} object(s) remain`);
  }
  return removed;
}

/**
 * Purge all buckets' objects; buckets are preserved. `storage` is a Supabase
 * storage client: { listBuckets(), from(id) }.
 */
export async function purgeAllStorage(storage, { batchSize = 100, onProgress } = {}) {
  const { data: buckets, error } = await storage.listBuckets();
  if (error) throw new Error(`listBuckets failed: ${error.message}`);
  let total = 0;
  const perBucket = {};
  for (const b of buckets) {
    const n = await purgeBucket(storage.from(b.id), {
      batchSize,
      onProgress: onProgress ? (done, all) => onProgress(b.id, done, all) : undefined,
    });
    perBucket[b.id] = n;
    total += n;
  }
  return { total, perBucket, buckets: buckets.map((b) => b.id) };
}

/* ============================ CLI ============================ */

async function tableCount(db, t) {
  const { count, error } = await db.from(t).select('*', { count: 'exact', head: true });
  return error ? `err(${error.code || error.message})` : (count ?? 0);
}
async function authUserCount(db) {
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

async function plan(db) {
  console.log(`\n=== PILOT RESET PLAN (read-only)  project=${EXPECT_PROJECT_REF} ===\n`);
  console.log(`auth.users: ${await authUserCount(db)}`);
  console.log(`\n-- Runtime tables to CLEAR (${RUNTIME_TABLES.length}) + accounts + auth.users, in FK order --`);
  let nonzero = 0;
  for (const t of RUNTIME_TABLES) {
    const c = await tableCount(db, t);
    if (c !== 0) { nonzero++; console.log(`  ${String(c).padStart(8)}  ${t}`); }
  }
  console.log(`  ${String(await tableCount(db, 'accounts')).padStart(8)}  accounts`);
  console.log(`\n  (${nonzero} of ${RUNTIME_TABLES.length} runtime tables currently non-empty; empty ones omitted)`);
  console.log(`\n-- PRESERVED configuration (NOT cleared) --`);
  for (const t of PRESERVE) console.log(`  ${String(await tableCount(db, t)).padStart(8)}  ${t}`);
  console.log(`\n-- Storage (buckets preserved; objects purged via --execute-storage) --`);
  const { data: buckets, error } = await db.storage.listBuckets();
  if (error) console.log(`  (could not list buckets: ${error.message})`);
  else for (const b of buckets) {
    const all = await listAllFiles(db.storage.from(b.id)).catch((e) => e.message);
    console.log(`  ${b.id}: ${Array.isArray(all) ? all.length + ' object(s)' : all}`);
  }
  console.log(`\nNext: run --execute-storage, then reset-pilot-data.sql in the SQL Editor.`);
}

async function executeStorage(db, confirm) {
  if (confirm !== 'RESET-PILOT-STORAGE-DATA') {
    console.error('Refusing: pass  --confirm RESET-PILOT-STORAGE-DATA  to purge Storage objects.');
    process.exit(2);
  }
  const result = await purgeAllStorage(db.storage, {
    onProgress: (bucket, done, all) => process.stdout.write(`\r  ${bucket}: ${done}/${all} removed   `),
  });
  console.log(`\nDone. Removed ${result.total} object(s) across ${result.buckets.length} bucket(s): ${result.buckets.join(', ')} (buckets preserved).`);
}

async function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const URL = process.env.SUPABASE_URL ?? '';
  const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!URL || !SVC) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.'); process.exit(2); }
  if (!URL.includes(EXPECT_PROJECT_REF)) {
    console.error(`Refusing to run: SUPABASE_URL is not the pilot project (${EXPECT_PROJECT_REF}).`);
    process.exit(2);
  }
  const db = createClient(URL, SVC, { auth: { persistSession: false } });
  if (has('--execute-storage')) await executeStorage(db, val('--confirm'));
  else await plan(db);
}

// Only run the CLI when invoked directly (so tests can import the pure fns).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
