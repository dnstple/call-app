/**
 * Stage 3C2-C3 operator-script contracts. Regression for the Gate-10 defect:
 * supabase-js HEAD/count queries return { data: null, count } — reading .data
 * (or .count off the null data) crashed the replay REPORT after a safe
 * idempotent execution. The scripts must use the safeCount pattern with a
 * hard abort on a null count, and the replay must stay strictly idempotent
 * (fixed key, no --new-key path, no control/ceiling mutation).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const EXEC = readFileSync(join(ROOT, 'scripts', 'execute-c3-transfer.mjs'), 'utf-8');

// Extract the actual safeCount implementation from the script and run it
// against mocked supabase HEAD-query responses (behavioural reproduction).
function extractSafeCount(): (r: unknown, w: string) => number {
  const start = EXEC.indexOf('const safeCount = ');
  const end = EXEC.indexOf('};', start) + 2;
  const src = EXEC.slice(start, end);
  const failCalls: string[] = [];
  const fail = (m: string) => { failCalls.push(m); throw new Error(`ABORT:${m}`); };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('fail', `${src}; return safeCount;`)(fail) as (r: unknown, w: string) => number;
  return fn;
}

describe('Gate-10 replay count handling (null-data HEAD responses)', () => {
  const safeCount = extractSafeCount();
  it('returns the top-level count when data is null (the real HEAD response shape)', () => {
    expect(safeCount({ data: null, count: 7, error: null }, 'events')).toBe(7);
    expect(safeCount({ data: null, count: 0, error: null }, 'events')).toBe(0);
  });
  it('HARD-aborts (never treats as zero) when count is null/undefined', () => {
    expect(() => safeCount({ data: null, count: null, error: null }, 'events')).toThrow(/count unavailable/);
    expect(() => safeCount({ data: null, error: null }, 'events')).toThrow(/count unavailable/);
  });
  it('aborts on query errors before reading anything', () => {
    expect(() => safeCount({ data: null, count: 3, error: { message: 'boom' } }, 'events')).toThrow(/boom/);
  });
  it('the script never reads .count off a must() result and routes every HEAD query through safeCount', () => {
    // Every count:'exact' query must be wrapped by safeCount, none by must().
    const headQueries = EXEC.match(/(must|safeCount)\(await [^;]*count: 'exact'/g) ?? [];
    expect(headQueries.length).toBeGreaterThan(0);
    for (const q of headQueries) expect(q.startsWith('safeCount(')).toBe(true);
    expect(EXEC).not.toMatch(/\bev(Before|After)\.count\b/);
  });
});

describe('Gate-10 replay safety contract', () => {
  it('replay uses the SAME fixed idempotency key, asserts the idempotent run, and has no --new-key path', () => {
    const replay = EXEC.slice(EXEC.indexOf('async function replay()'), EXEC.indexOf('(async () => {'));
    expect(replay).toContain('`c3-exec-${EARNING}`');
    expect(replay).toContain("if (rq.idempotent !== true) fail");
    expect(replay).not.toContain('--new-key');
    expect(replay).not.toContain('Date.now().toString(36)}`');   // no fresh-key minting in replay
  });
  it('replay never arms anything: no control or ceiling mutation, resting-state asserted first', () => {
    const replay = EXEC.slice(EXEC.indexOf('async function replay()'), EXEC.indexOf('(async () => {'));
    expect(replay).toContain('await assertBaseline()');
    expect(replay).not.toContain('setCeiling(');
    expect(replay).not.toContain('setControl(');
    expect(replay).not.toContain('support_set_financial_control');
  });
  it('replay verifies stability: one attempt, one job, stable provider id, event delta, already_executed required', () => {
    const replay = EXEC.slice(EXEC.indexOf('async function replay()'), EXEC.indexOf('(async () => {'));
    expect(replay).toContain("already_executed === true");
    expect(replay).toContain('provider_id_stable');
    expect(replay).toContain('event_count_delta');
    expect(replay).toContain("replay changed attempt/job counts");
    expect(replay).toContain("provider id changed");
  });
  it('the scripts contain no secrets and refuse live-key material', () => {
    for (const file of ['execute-c3-transfer.mjs', 'scoped-transfer-rollout.mjs', 'prepare-c3-transfer-run.mjs', 'create-c3-fixture.mjs']) {
      const src = readFileSync(join(ROOT, 'scripts', file), 'utf-8');
      expect(src, file).not.toMatch(/sk_live_[A-Za-z0-9]/);
      expect(src, file).not.toMatch(/sk_test_[A-Za-z0-9]{8,}/);   // no embedded real keys
      expect(src, file).toContain("startsWith('sk_live_')");
    }
  });
});

describe('Stage 3D operator tooling contracts (post-failure repairs)', () => {
  const DD = readFileSync(join(ROOT, 'scripts', 'validate-3dd-payments.mjs'), 'utf-8');
  const INERT = readFileSync(join(ROOT, 'scripts', 'validate-3db2-billing-inert.mjs'), 'utf-8');

  function extractMustUuid(): (v: unknown, l: string) => string {
    const start = DD.indexOf('const mustUuid = ');
    const end = DD.indexOf('};', start) + 2;
    const fail = (m: string) => { throw new Error(`ABORT:${m}`); };
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function('fail', 'UUID_RE', `${DD.slice(start, end)}; return mustUuid;`)(fail, UUID_RE);
  }

  it('mustUuid rejects objects, arrays, null, undefined, text and malformed uuids', () => {
    const mustUuid = extractMustUuid();
    const good = '11111111-2222-4333-8444-555555555555';
    expect(mustUuid(good, 'x')).toBe(good);
    for (const bad of [{ id: good }, [good], null, undefined, 'DdCompanion', 'not-a-uuid', 123, '11111111']) {
      expect(() => mustUuid(bad as never, 'x'), JSON.stringify(bad)).toThrow(/not a UUID/);
    }
  });

  it('REGRESSION: companion signup returns a full profile ROW — preflight extracts .id exactly once, never the object', () => {
    // The 22P02 failure came from `xc.companion_profile_id ?? xc.profile_id ?? xc`
    // serialising the whole profile row into a uuid column.
    expect(DD).toContain("mustUuid(xc?.id, 'complete_companion_signup().id')");
    expect(DD).not.toContain('?? xc;');
    expect(DD).not.toContain('xc.companion_profile_id');
    // Coordinator signup DOES return an envelope — the envelope field is used.
    expect(DD).toContain("mustUuid(wc?.member_profile_id, 'complete_coordinator_signup().member_profile_id')");
    // Every critical fixture identifier passes the guard.
    expect(DD).toContain("mustUuid(coord.id, 'coordinator account id')");
    expect(DD).toContain("mustUuid(o.id, `offer ${o.offer_type} id`)");
    expect(DD).toContain("mustUuid(S.coordinator.account_id, 'snapshot coordinator account_id')");
  });

  it('preflight keeps a creation ledger + checkpoint and prints recovery on failure', () => {
    expect(DD).toContain("const CKPT_FILE = '3dd-preflight.checkpoint.local.json'");
    expect(DD).toContain('reportPartialAndFail(step');
    expect(DD).toContain('Resources created so far');
    expect(DD).toContain('--inspect-partial');
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('3dd-preflight.checkpoint.local.json');
    expect(gitignore).toContain('3dd-snapshot.local.json');
  });

  it('partial-run recovery: inspect is read-only; cleanup is phrase-gated, suffix-scoped and refuses financial rows', () => {
    const insp = DD.slice(DD.indexOf('async function inspectPartial'), DD.indexOf('async function cleanupPartial'));
    expect(insp).not.toMatch(/\.delete\(|\.insert\(|\.update\(|deleteUser/);
    const cl = DD.slice(DD.indexOf('async function cleanupPartial'), DD.indexOf('/* -------- '));
    expect(cl).toContain('CLEANUP-FAILED-3DD-PREFLIGHT');
    expect(cl).toContain("argOf('--suffix')");
    expect(cl).toContain('refusing to clean the CURRENT snapshot run');
    expect(cl).toContain('has financial rows');
    expect(cl).toContain('nothing to clean for that suffix (idempotent no-op)');
    expect(DD).toContain('FIXTURE_EMAIL_RE');
  });

  it('repo-local inert probe: module resolution, four contracts, finally cleanup, exit code', () => {
    // Repo dependency tree (not a temp-dir copy).
    expect(INERT).toContain("import { createClient } from '@supabase/supabase-js'");
    expect(INERT).toContain("'1 charge_due no secret -> 401'");
    expect(INERT).toContain("'2 charge_due wrong secret -> 401'");
    expect(INERT).toContain("'3 authed unknown action -> 400 unknown_action'");
    expect(INERT).toContain("'4 authed complete_period random order -> neutral not_found'");
    expect(INERT).toContain('order_id: crypto.randomUUID()');
    expect(INERT).not.toContain('orderId:');
    expect(INERT).not.toContain('BILLING_CRON_SECRET');
    expect(INERT).toContain('} finally {');
    expect(INERT).toContain('deleteUser(probeId)');
    expect(INERT).toContain('del.error');
    expect(INERT).toContain('process.exitCode = failures ? 1 : 0');
    expect(INERT).toContain("startsWith('sk_live_')");
    expect(INERT).not.toMatch(/sk_test_[A-Za-z0-9]{8,}|sk_live_[A-Za-z0-9]/);
    expect(INERT).not.toMatch(/paymentIntents|checkout\.sessions/);
  });
});
