#!/usr/bin/env node
/**
 * Stage 3D-B2 — repository-local inert stripe-billing probes.
 *
 * Lives in the repo so @supabase/supabase-js resolves from the project
 * dependency tree (the %TEMP% variant could not resolve modules). Four inert
 * checks only — no financial mutation, no real order, never the real billing
 * cron secret, no deliberate Stripe contact, no payment-intent involvement:
 *   1. charge_due without x-billing-secret            -> 401
 *   2. charge_due with a deliberately wrong secret    -> 401
 *   3. authenticated unknown action                   -> 400 unknown_action
 *   4. authenticated complete_period, random order_id -> 200 not_found
 * A single temporary confirmed low-privilege user is created for 3+4 and
 * deleted in `finally` (deleteUser.error inspected; cleanup failure counts as
 * a failed check). Secrets are read from env and never printed.
 */
import { createClient } from '@supabase/supabase-js';

const ORIGIN = 'http://localhost:5173';
for (const [k, v] of Object.entries(process.env)) {
  if (typeof v === 'string' && v.startsWith('sk_live_')) {
    console.error(`ABORT: live key material in env ${k}`);
    process.exit(1);
  }
}
const URL_ = process.env.SUPABASE_URL ?? '';
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!URL_ || !ANON || !SVC) {
  console.error('ABORT: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY required.');
  process.exit(1);
}
const FN = `${URL_.replace(/\/$/, '')}/functions/v1/stripe-billing`;
let failures = 0;
const post = (body, headers = {}) => fetch(FN, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: ANON, ...headers },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const check = (n, r, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${n} (status=${r.status} error=${r.body?.error ?? '-'})`);
  if (!ok) failures += 1;
};
const admin = createClient(URL_, SVC, { auth: { persistSession: false } });
let probeId = null;
try {
  let r = await post({ action: 'charge_due' });
  check('1 charge_due no secret -> 401', r, r.status === 401);
  r = await post({ action: 'charge_due' }, { 'x-billing-secret': 'wrong-secret-probe' });
  check('2 charge_due wrong secret -> 401', r, r.status === 401);
  const email = `3db2-billing-probe-${Date.now().toString(36)}@example.com`;
  const pw = `Px!${crypto.randomUUID()}`;
  const made = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (made.error || !made.data?.user?.id) {
    throw new Error(`Probe user creation failed: ${made.error?.message ?? 'no user returned'}`);
  }
  probeId = made.data.user.id;
  const u = createClient(URL_, ANON, { auth: { persistSession: false } });
  const si = await u.auth.signInWithPassword({ email, password: pw });
  if (si.error || !si.data?.session?.access_token) {
    throw new Error(`Probe sign-in failed: ${si.error?.message ?? 'no session returned'}`);
  }
  const jwt = si.data.session.access_token;
  r = await post({ action: 'definitely_not_an_action' }, { Authorization: `Bearer ${jwt}` });
  check('3 authed unknown action -> 400 unknown_action', r, r.status === 400 && r.body?.error === 'unknown_action');
  r = await post({ action: 'complete_period', order_id: crypto.randomUUID(), origin: ORIGIN },
    { Authorization: `Bearer ${jwt}` });
  check('4 authed complete_period random order -> neutral not_found', r,
    r.status === 200 && r.body?.error === 'not_found');
} catch (error) {
  console.log(`FAIL probe execution: ${error instanceof Error ? error.message : String(error)}`);
  failures += 1;
} finally {
  if (probeId) {
    const del = await admin.auth.admin.deleteUser(probeId);
    if (del.error) {
      console.log(`FAIL probe user cleanup: ${del.error.message}`);
      failures += 1;
    } else {
      console.log('probe user cleanup: deleted');
    }
  } else {
    console.log('probe user cleanup: no user created');
  }
}
console.log(`INERT PROBE RESULT pass=${4 - Math.min(failures, 4)} fail=${failures}`);
process.exitCode = failures ? 1 : 0;
