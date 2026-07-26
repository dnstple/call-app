#!/usr/bin/env node
/**
 * Block 4 — v1 pilot validation CLI (hosted TEST mode).
 *
 * Thin wiring: parses argv, builds a real `deps` object (service-role client,
 * livekit-token Edge caller, Stage 3D/3E verifier runner) and delegates to
 * scripts/v1-harness-core.mjs. All logic + guards live in the core so they are
 * unit-tested without hosted access. Prints/writes NO secrets; mutating modes
 * require the phrase VALIDATE-V1-PILOT-TEST.
 *
 * Modes: --preflight --inspect --verify-foundation --prepare-fixture
 *        --verify-trust --verify-notifications --verify-calls --verify-financial
 *        --verify --report --inspect-partial --restore-controls --cleanup
 */
import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as core from './v1-harness-core.mjs';

const MODE = process.argv.find((a) => a.startsWith('--')) ?? '--preflight';
const CONFIRMED = process.argv.includes(core.CONFIRM);
const env = {
  url: process.env.SUPABASE_URL ?? '', svc: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  anon: process.env.SUPABASE_ANON_KEY ?? '', stripeKey: process.env.STRIPE_SECRET_KEY ?? '',
  expectProject: process.env.V1_EXPECT_PROJECT_REF ?? 'gwtunmoefapiiybwlelw',
  suffix: process.env.V1_SUFFIX ?? '',
};
const CK = 'v1-checkpoint.local.json';
const EV = 'v1-terminal-evidence.local.txt';
const REPORT = 'v1-report.local.json';
const BROWSER = 'v1-browser-evidence.local.txt';

function ev(line) { const s = core.scrubSecrets(line); writeFileSync(EV, s + '\n', { flag: 'a' }); console.log(s); }
function die(m) { console.error('FATAL: ' + core.scrubSecrets(m)); process.exit(2); }

/* -------- checkpoint (resumable) -------- */
function loadCk() {
  const base = existsSync(CK) ? JSON.parse(readFileSync(CK, 'utf-8')) : { suffix: env.suffix, done: [], results: [], snap: null };
  return {
    ...base,
    save() { writeFileSync(CK, JSON.stringify({ suffix: this.suffix, done: this.done, results: this.results, snap: this.snap }, null, 2)); },
    record(name, pass, detail) { this.results = this.results.filter((r) => r.name !== name); this.results.push({ name, pass: !!pass, detail: detail ?? null }); this.save(); ev(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); },
    async phase(name, fn) { if (this.done.includes(name)) { ev(`skip phase ${name} (checkpoint)`); return; } await fn(); this.done.push(name); this.save(); ev(`phase ${name} done`); },
  };
}

/* -------- real deps -------- */
function realDeps(admin, ck) {
  const one = async (t, m) => (await admin.from(t).select('*').match(m).maybeSingle()).data ?? null;
  const many = async (t, m) => (await admin.from(t).select('*').match(m)).data ?? [];
  return {
    ck,
    emailAdapterName: 'test', emailProviderConfigured: !!process.env.EMAIL_PROVIDER_API_KEY,
    getOne: one, getMany: many,
    count: async (t, m) => (await admin.from(t).select('id', { count: 'exact', head: true }).match(m)).count ?? 0,
    insert: async (t, row) => { const q = await admin.from(t).insert(row).select().maybeSingle?.() ?? await admin.from(t).insert(row).select(); if (q.error) throw new Error(`${t} insert: ${q.error.message}`); return Array.isArray(row) ? q.data : (q.data?.[0] ?? q.data); },
    upsert: async (t, row, onConflict) => { const q = await admin.from(t).upsert(row, { onConflict, ignoreDuplicates: false }).select(); if (q.error) throw new Error(`${t} upsert: ${q.error.message}`); return q.data?.[0] ?? null; },
    rpc: async (name, args) => { const q = await admin.rpc(name, args); if (q.error) throw new Error(`rpc ${name}: ${q.error.message}`); return q.data; },
    update: async (t, matchObj, patch) => { const q = await admin.from(t).update(patch).match(matchObj).select(); if (q.error) throw new Error(`${t} update: ${q.error.message}`); return q.data; },
    createUser: async (email) => {
      core.requireV1Email(email);
      const password = `V1!${randomUUID()}`;
      let id;
      const made = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (made.error) {
        if (!/already|registered|exists/i.test(made.error.message)) throw new Error(`createUser: ${made.error.message}`);
        // Idempotent re-run: reset the existing user's password so we can sign in.
        const list = await admin.auth.admin.listUsers();
        id = list.data.users.find((u) => u.email === email)?.id;
        if (!id) throw new Error(`createUser: user exists but id not found for ${email.split('@')[0]}`);
        const upd = await admin.auth.admin.updateUserById(id, { password, email_confirm: true });
        if (upd.error) throw new Error(`reset password: ${upd.error.message}`);
      } else {
        id = made.data.user.id;
      }
      // Provision the accounts row via the app RPC (same path as Stage 3E mkUser).
      const c = createClient(env.url, env.anon, { auth: { persistSession: false } });
      const si = await c.auth.signInWithPassword({ email, password });
      if (si.error) throw new Error(`sign-in ${email.split('@')[0]}: ${si.error.message}`);
      const ens = await c.rpc('ensure_current_account');
      if (ens.error) throw new Error(`ensure_current_account: ${ens.error.message}`);
      ck.snap = ck.snap ?? { suffix: env.suffix };
      ck.snap._creds = { ...(ck.snap._creds ?? {}), [email]: password };
      ck.save();
      return { id, email };
    },
    callToken: async (bookingId, account) => {
      // Sign in as the given fixture account and invoke the real livekit-token
      // Edge fn; decode the JWT video grant. A non-participant receives no token.
      const creds = ck.snap?._creds ?? {};
      const cli = createClient(env.url, env.anon, { auth: { persistSession: false } });
      const si = await cli.auth.signInWithPassword({ email: account.email, password: creds[account.email] });
      if (si.error) throw new Error(`sign-in ${account.email.split('@')[0]}: ${si.error.message}`);
      const fn = await cli.functions.invoke('livekit-token', { body: { bookingId } });
      const jwt = fn.data?.token;
      if (!jwt) return { video: null, error: fn.data?.error ?? 'no_token' };
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
      return payload;
    },
    runVerifier: (name) => {
      const script = name === '3d' ? 'scripts/validate-3dd-payments.mjs' : 'scripts/validate-3e-payouts.mjs';
      const arg = name === '3d' ? '--verify' : '--report';
      const out = spawnSync('node', [script, arg], { encoding: 'utf-8', env: process.env });
      return (out.stdout ?? '') + (out.stderr ?? '');
    },
  };
}

async function main() {
  if (MODE === '--inspect-partial') { console.log(core.scrubSecrets(existsSync(CK) ? readFileSync(CK, 'utf-8') : '{}')); return; }
  if (MODE === '--report') {
    const ck = loadCk();
    const browser = existsSync(BROWSER) ? readFileSync(BROWSER, 'utf-8') : '';
    const rep = core.buildReport(ck.results, {
      requiredSections: ['trust:', 'notif:', 'call:', 'financial:'], browserEvidence: browser,
    });
    writeFileSync(REPORT, JSON.stringify(rep, null, 2));
    console.log(rep.line);
    process.exit(rep.fail === 0 ? 0 : 1);
  }

  core.assertSafe({ ...env, mode: MODE, confirmed: CONFIRMED });
  const admin = createClient(env.url, env.svc, { auth: { persistSession: false } });
  const ck = loadCk();
  const deps = realDeps(admin, ck);

  switch (MODE) {
    case '--preflight': ev(`preflight ok: project=${env.expectProject} suffix=${env.suffix} mode=${MODE}`); break;
    case '--inspect':
      for (const t of ['bookings', 'payment_orders', 'companion_earnings', 'email_outbox', 'consent_acknowledgements', 'user_blocks', 'conversation_concerns']) {
        ev(`baseline ${t} = ${await deps.count(t, {})}`);
      } break;
    case '--verify-foundation': {
      for (const [name, t] of [['consent_policies', 'consent_policies'], ['user_blocks', 'user_blocks'], ['email_outbox', 'email_outbox'], ['notification_preferences', 'notification_preferences']]) {
        try { await deps.count(t, {}); ck.record('foundation:' + name + ' present', true); }
        catch (e) { ck.record('foundation:' + name + ' present', false, e.message); }
      }
      break;
    }
    case '--prepare-fixture': await core.prepareFixture(deps, env.suffix); ev('fixture prepared (ids in checkpoint; creds ignored-file only)'); break;
    case '--verify-trust': (await core.verifyTrust(deps, ck.snap)).forEach((r) => ck.record(r.name, r.pass, r.detail)); break;
    case '--verify-notifications': (await core.verifyNotifications(deps, ck.snap)).forEach((r) => ck.record(r.name, r.pass, r.detail)); break;
    case '--verify-calls': (await core.verifyCalls(deps, ck.snap)).forEach((r) => ck.record(r.name, r.pass, r.detail)); break;
    case '--verify-financial': (await core.verifyFinancial(deps)).forEach((r) => ck.record(r.name, r.pass, r.detail)); break;
    case '--verify':
      await core.withRestore(deps, async () => {
        if (!ck.snap) await core.prepareFixture(deps, env.suffix);
        for (const fn of [core.verifyTrust, core.verifyNotifications, core.verifyCalls]) {
          (await fn(deps, ck.snap)).forEach((r) => ck.record(r.name, r.pass, r.detail));
        }
        (await core.verifyFinancial(deps)).forEach((r) => ck.record(r.name, r.pass, r.detail));
      });
      break;
    case '--restore-controls': await core.restoreControls(deps); break;
    case '--cleanup': { const res = await core.cleanup(deps, ck.snap); ev(`cleanup: ${JSON.stringify(res)}`); break; }
    default: ev(`unknown mode ${MODE}`);
  }
}
main().catch(die);
