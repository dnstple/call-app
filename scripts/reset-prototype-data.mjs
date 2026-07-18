#!/usr/bin/env node
/**
 * DEVELOPMENT-ONLY prototype reset runner.
 *
 *   RESET_PROTOTYPE_DATA=true node scripts/reset-prototype-data.mjs [--mode app-data|full] [--yes]
 *
 * Safety model:
 *  * refuses to run unless RESET_PROTOTYPE_DATA=true;
 *  * requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment
 *    (server-side only — these must NEVER appear in frontend code);
 *  * ALWAYS prints a dry-run row count per table first;
 *  * requires interactive confirmation (or an explicit --yes);
 *  * "full" mode deletes ONLY auth users whose emails are listed in
 *    RESET_TEST_ACCOUNT_EMAILS (comma-separated) AND end in a
 *    non-deliverable test domain (@example.com/.test/.invalid) — it can
 *    never touch a real person's account;
 *  * mock mode is untouched: this script only talks to the linked
 *    Supabase project.
 */
import { createClient } from '@supabase/supabase-js';
import { createInterface } from 'node:readline/promises';

const TABLES = [
  'notifications', 'message_reads', 'messages', 'conversations',
  'guest_call_invitations', 'completion_confirmations', 'booking_history',
  'booking_proposals', 'booking_credits', 'bookings', 'plan_occurrences',
  'conversation_plans', 'package_purchases', 'ratings', 'favourites',
  'availability_exceptions', 'availability_rules', 'conversation_offers',
  'package_offers', 'profile_interests', 'profile_private_details',
  'companion_profiles', 'managed_relationships', 'reports', 'transactions',
  'profile_access', 'profiles', 'accounts',
];

const TEST_DOMAIN = /@(?:[a-z0-9-]+\.)?(example\.com|example\.org|test|invalid)$/i;

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

const mode = process.argv.includes('--mode')
  ? process.argv[process.argv.indexOf('--mode') + 1]
  : 'app-data';
if (!['app-data', 'full'].includes(mode)) fail(`Unknown mode: ${mode}`);

if (process.env.RESET_PROTOTYPE_DATA !== 'true') {
  fail('Refusing to run: set RESET_PROTOTYPE_DATA=true to acknowledge this deletes prototype data.');
}
const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) fail('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (server-side only).');

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

// ---------- dry run ----------
console.log(`\nPrototype reset (${mode}) — DRY RUN counts for ${url}:\n`);
let total = 0;
for (const table of TABLES) {
  const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true });
  if (error) {
    console.log(`  ${table.padEnd(28)} (skipped: ${error.code ?? error.message})`);
    continue;
  }
  console.log(`  ${table.padEnd(28)} ${count ?? 0}`);
  total += count ?? 0;
}
console.log(`\n  TOTAL rows that would be deleted: ${total}`);

let testAccounts = [];
if (mode === 'full') {
  const listed = (process.env.RESET_TEST_ACCOUNT_EMAILS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (listed.length === 0) {
    fail('full mode requires RESET_TEST_ACCOUNT_EMAILS (comma-separated explicit test emails).');
  }
  const unsafe = listed.filter((e) => !TEST_DOMAIN.test(e));
  if (unsafe.length > 0) {
    fail(`These emails are not on a recognised test domain and will NOT be deleted: ${unsafe.join(', ')}`);
  }
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  testAccounts = (data?.users ?? []).filter((u) => listed.includes(u.email ?? ''));
  console.log(`\n  Auth accounts that would be deleted (${testAccounts.length}):`);
  for (const u of testAccounts) console.log(`    ${u.email}`);
}

// ---------- confirmation ----------
if (!process.argv.includes('--yes')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `\nType exactly "reset ${mode}" to delete the rows above (anything else aborts): `,
  );
  rl.close();
  if (answer !== `reset ${mode}`) fail('Aborted — nothing was deleted.');
}

// ---------- deletion ----------
console.log('\nDeleting application data…');
for (const table of TABLES) {
  const { error } = await admin.from(table).delete().not('id', 'is', null);
  if (error && !/does not exist/.test(error.message ?? '')) {
    console.log(`  ${table}: ${error.message}`);
  } else {
    console.log(`  ${table}: cleared`);
  }
}

// Prototype avatars (storage), bucket retained.
try {
  const { data: objects } = await admin.storage.from('avatars').list('', { limit: 1000 });
  const names = (objects ?? []).map((o) => o.name).filter(Boolean);
  if (names.length > 0) {
    await admin.storage.from('avatars').remove(names);
    console.log(`  avatars bucket: removed ${names.length} object(s) (bucket kept)`);
  }
} catch {
  console.log('  avatars bucket: skipped');
}

if (mode === 'full') {
  console.log('\nDeleting listed test auth accounts…');
  for (const u of testAccounts) {
    const { error } = await admin.auth.admin.deleteUser(u.id);
    console.log(`  ${u.email}: ${error ? error.message : 'deleted'}`);
  }
}

console.log('\n✓ Reset complete. Supabase mode now starts genuinely empty.');
console.log('  Clean onboarding: register one Coordinator and one Companion');
console.log('  (test domains), complete both wizards, then browse Explore.');
