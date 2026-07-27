#!/usr/bin/env node
/**
 * Pilot user management — operator-run, service-role.
 *
 * Two jobs:
 *   1. Explain why a Companion is / isn't discoverable in Explore.
 *   2. Declutter test accounts safely.
 *
 * This runs on YOUR machine with the pilot service-role key (never in the app
 * bundle). It talks straight to the hosted DB via the Supabase admin client.
 *
 * Env (PowerShell): set the same vars the validation harness uses —
 *   $env:SUPABASE_URL, $env:SUPABASE_SERVICE_ROLE_KEY, $env:SUPABASE_ANON_KEY
 *
 * Modes:
 *   node scripts/manage-pilot-users.mjs --audit            # READ ONLY (default)
 *   node scripts/manage-pilot-users.mjs --audit --email danpinchen@outlook.com
 *   node scripts/manage-pilot-users.mjs --approve a@x.com,b@y.com   # flip moderation → approved
 *   node scripts/manage-pilot-users.mjs --delete --dry-run --email a@x.com,b@y.com
 *   node scripts/manage-pilot-users.mjs --delete --confirm DELETE-PILOT-USERS --email a@x.com
 *
 * Deletion is DESTRUCTIVE and guarded: it never runs without --confirm
 * DELETE-PILOT-USERS AND an explicit --email list, refuses support admins unless
 * --include-admins, and prints the full blast radius first. Always run --audit
 * (and --delete --dry-run) before a real delete.
 */
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const emails = (val('--email') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const EXPECT_PROJECT_REF = process.env.PILOT_EXPECT_PROJECT_REF ?? 'gwtunmoefapiiybwlelw';
const URL = process.env.SUPABASE_URL ?? '';
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!URL || !SVC) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the environment.');
  process.exit(2);
}
if (!URL.includes(EXPECT_PROJECT_REF)) {
  console.error(`Refusing to run: SUPABASE_URL (${URL}) is not the expected pilot project (${EXPECT_PROJECT_REF}).`);
  console.error('Set PILOT_EXPECT_PROJECT_REF if you intend a different project.');
  process.exit(2);
}

const db = createClient(URL, SVC, { auth: { persistSession: false } });

const MIN_BIO = 120;
// Heuristic: which emails look like throwaway test accounts.
const TEST_RE = /(v1pilot|stage3|3dd|3e-|fixture|example\.(com|test)|@example\.|\.test$|companion\.v1|member\.v1|coordinator\.v1|support\.v1)/i;

async function fetchAll(table, columns = '*') {
  const out = [];
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await db.from(table).select(columns).range(from, from + page - 1);
    if (error) { console.warn(`  (warning) could not read ${table}: ${error.message}`); return out; }
    out.push(...(data ?? []));
    if (!data || data.length < page) break;
    from += page;
  }
  return out;
}

async function listAuthUsers() {
  const out = [];
  let page = 1;
  for (;;) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    out.push(...data.users);
    if (data.users.length < 200) break;
    page += 1;
  }
  return out;
}

async function loadModel() {
  const [users, accounts, access, profiles, companions, policies, acks, admins] = await Promise.all([
    listAuthUsers(),
    fetchAll('accounts'),
    fetchAll('profile_access'),
    fetchAll('profiles'),
    fetchAll('companion_profiles'),
    fetchAll('consent_policies'),
    fetchAll('consent_acknowledgements'),
    fetchAll('support_admins'),
  ]);

  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const companionByProfile = new Map(companions.map((c) => [c.profile_id, c]));
  const accessByAccount = new Map();
  for (const a of access) {
    if (!accessByAccount.has(a.account_id)) accessByAccount.set(a.account_id, []);
    accessByAccount.get(a.account_id).push(a);
  }
  const companionPilotVersion = policies.find((p) => p.consent_type === 'companion_pilot')?.current_version ?? null;
  const ackKey = (pid, type) => `${pid}::${type}`;
  const currentAcks = new Set(
    acks
      .filter((a) => (a.revoked_at == null) && (companionPilotVersion == null || a.policy_version === companionPilotVersion))
      .map((a) => ackKey(a.subject_profile_id, a.consent_type)),
  );
  const adminAccountIds = new Set(admins.map((a) => a.account_id ?? a.id).filter(Boolean));

  return { users, accounts, accountById: new Map(accounts.map((a) => [a.id, a])),
    accessByAccount, profileById, companionByProfile, companionPilotVersion, currentAcks, ackKey, adminAccountIds };
}

function companionGates(profile, companion, m) {
  const avatar = Boolean(profile.avatar_path || profile.photo_url);
  const bioLen = (profile.bio ?? '').trim().length;
  return {
    active: profile.profile_status === 'active',
    public: profile.visibility === 'public',
    avatar,
    bio120: bioLen >= MIN_BIO,
    approved: (companion?.moderation_status ?? 'pending') === 'approved',
    consent: m.currentAcks.has(m.ackKey(profile.id, 'companion_pilot')),
    _bioLen: bioLen,
    _moderation: companion?.moderation_status ?? '(no companion_profiles row)',
  };
}

function gateSummary(g) {
  const fails = [];
  if (!g.active) fails.push(`profile_status≠active`);
  if (!g.public) fails.push(`visibility≠public`);
  if (!g.avatar) fails.push('no avatar/photo');
  if (!g.bio120) fails.push(`bio ${g._bioLen}/120 chars`);
  if (!g.approved) fails.push(`moderation=${g._moderation}`);
  if (!g.consent) fails.push('consent not current');
  return fails;
}

function accountOwnerProfiles(accountId, m) {
  const list = m.accessByAccount.get(accountId) ?? [];
  return list
    .filter((a) => a.access_role === 'owner')
    .map((a) => m.profileById.get(a.profile_id))
    .filter(Boolean);
}

async function audit(m) {
  console.log(`\n=== PILOT USER AUDIT (${URL}) ===`);
  console.log(`auth users: ${m.users.length} · accounts: ${m.accounts.length} · companion_profiles: ${m.companionByProfile.size} · companion_pilot consent version: ${m.companionPilotVersion ?? 'n/a'}\n`);

  const rows = m.users.map((u) => {
    const email = (u.email ?? '').toLowerCase();
    const acct = m.accountById.get(u.id);
    const owners = acct ? accountOwnerProfiles(u.id, m) : [];
    const companionProfiles = owners.filter((p) => p.role === 'companion');
    const isAdmin = m.adminAccountIds.has(u.id);
    return { u, email, acct, owners, companionProfiles, isAdmin, isTest: TEST_RE.test(email) };
  });

  // Focused view if --email given.
  const focus = emails.length ? rows.filter((r) => emails.includes(r.email)) : null;
  if (focus) {
    console.log('--- requested emails ---');
    for (const r of focus.length ? focus : emails.map((e) => ({ email: e, missing: true }))) {
      if (r.missing) { console.log(`  ${r.email}: NO auth user with this email`); continue; }
      reportUser(r, m, true);
    }
    console.log('');
  }

  console.log('--- companions: discoverability ---');
  const companionRows = rows.filter((r) => r.companionProfiles.length > 0);
  if (companionRows.length === 0) console.log('  (no companion owner-profiles found)');
  for (const r of companionRows) {
    for (const p of r.companionProfiles) {
      const g = companionGates(p, m.companionByProfile.get(p.id), m);
      const fails = gateSummary(g);
      const status = fails.length === 0 ? '✓ DISCOVERABLE' : `✗ hidden — ${fails.join(', ')}`;
      console.log(`  ${r.email}  [${p.first_name} ${p.last_name}]  ${status}`);
    }
  }

  console.log('\n--- likely TEST accounts (email heuristic) ---');
  const tests = rows.filter((r) => r.isTest);
  for (const r of tests) {
    const roles = r.owners.map((p) => p.role).join('/') || (r.acct ? 'account, no profile' : 'auth only, no account');
    console.log(`  ${r.email}  · ${roles}${r.isAdmin ? ' · SUPPORT ADMIN' : ''}`);
  }
  console.log(`\n  ${tests.length} likely-test / ${rows.length} total auth users.`);
  console.log('  (Heuristic only — review before deleting. Run --delete --dry-run --email … to see blast radius.)\n');
}

function reportUser(r, m, verbose) {
  const roles = r.owners.map((p) => `${p.role}`).join(', ') || (r.acct ? 'account but no owned profile' : 'auth user, no account row (never onboarded)');
  console.log(`  ${r.email}  · id ${r.u.id}`);
  console.log(`      account: ${r.acct ? `onboarding_complete=${r.acct.onboarding_complete}, status=${r.acct.status}` : 'NONE'}${r.isAdmin ? ' · SUPPORT ADMIN' : ''}`);
  console.log(`      owned profiles: ${roles}`);
  if (verbose) {
    for (const p of r.owners.filter((p) => p.role === 'companion')) {
      const g = companionGates(p, m.companionByProfile.get(p.id), m);
      const fails = gateSummary(g);
      console.log(`      companion "${p.first_name} ${p.last_name}": ${fails.length ? 'HIDDEN — ' + fails.join(', ') : 'discoverable'}`);
    }
  }
}

async function approve(m) {
  if (emails.length === 0 && !has('--all-pending')) {
    console.error('--approve needs --email a@x.com,b@y.com  (or --all-pending).');
    process.exit(2);
  }
  const targets = [];
  for (const r of m.users.map((u) => ({ u, email: (u.email ?? '').toLowerCase() }))) {
    if (emails.length && !emails.includes(r.email)) continue;
    for (const p of accountOwnerProfiles(r.u.id, m).filter((p) => p.role === 'companion')) {
      const c = m.companionByProfile.get(p.id);
      if (has('--all-pending') && (c?.moderation_status ?? 'pending') === 'approved') continue;
      targets.push({ email: r.email, profile: p });
    }
  }
  if (targets.length === 0) { console.log('No matching companion profiles to approve.'); return; }
  console.log(`Approving ${targets.length} companion profile(s):`);
  for (const t of targets) {
    const { error } = await db.from('companion_profiles')
      .update({ moderation_status: 'approved', moderated_at: new Date().toISOString() })
      .eq('profile_id', t.profile.id);
    console.log(`  ${error ? '✗ ' + error.message : '✓ approved'}  ${t.email} [${t.profile.first_name} ${t.profile.last_name}]`);
  }
  console.log('\nNote: approval alone only helps if the profile is also active, public, has an avatar, a 120+ char bio and current consent. Re-run --audit to confirm.');
}

async function main() {
  const m = await loadModel();
  if (has('--approve')) return approve(m);
  if (has('--delete')) {
    console.error('Delete is intentionally not wired yet in this build. Run --audit first and share the output;');
    console.error('the delete step will be added with a --dry-run blast-radius report and per-table cascade handling.');
    process.exit(2);
  }
  return audit(m); // default
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
