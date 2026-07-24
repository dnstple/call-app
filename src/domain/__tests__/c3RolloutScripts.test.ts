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
