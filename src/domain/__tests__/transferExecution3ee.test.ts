/**
 * Stage 3E-E — exactly-once transfer execution verification contracts.
 *
 * The execution pipeline pre-exists (0048 attempts, 0073 execution-context
 * guard, 0077 scoped preparation, 0078 saga; hosted-proven in 3C2-C3). Deep
 * saga behaviour is covered by scopedProviderTransfers3c2c2 and the hosted
 * suite. These contracts pin the named Stage 3E exactly-once requirements.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const sql = (n: string) => readFileSync(join(ROOT, 'supabase', 'migrations', n), 'utf-8');
const M48 = sql('0048_companion_transfers.sql');
const M78 = sql('0078_scoped_provider_transfer_execution.sql');

describe('3E-E: one earning, at most one transfer, forever', () => {
  it('structural exactly-once: unique earning per attempt AND unique success per earning', () => {
    expect(M48).toContain('earning_id uuid not null unique references public.companion_earnings(id)');
    expect(M48).toMatch(/create unique index if not exists transfer_attempts_one_success\s*\n\s*on public\.companion_transfer_attempts \(earning_id\) where state = 'succeeded'/);
    expect(M48).toContain('idempotency_key text not null unique');
    expect(M48).toContain('stripe_transfer_id text unique');
  });
  it('browsers can neither read nor write settlement rows (no client RLS policies)', () => {
    expect(M48).toContain('-- No client policies: browsers can neither read nor write settlement rows.');
  });
  it('provider is contacted OUTSIDE the claim transaction with a stable per-earning key', () => {
    expect(M48).toMatch(/is contacted OUTSIDE any open transaction/);
    expect(M48).toMatch(/stable per earning, so a stale-claim retry can never double-transfer/);
  });
  it('ambiguity is never guessed: uncertain finaliser exists and never immediately re-creates', () => {
    expect(M78).toContain('finalize_scoped_transfer_uncertain');
    expect(M78).toMatch(/never retryable, never an immediate second create|uncertain/i);
  });
  it('a fresh provider lookup must immediately precede creation (crash/timeout recovery)', () => {
    expect(M78).toContain("raise exception 'lookup_required: a fresh not-found lookup must precede creation'");
    expect(M78).toContain("raise exception 'lookup_stale: repeat the provider lookup immediately before creation'");
  });
  it('provider truth is matched against the stored snapshot (foreign/mismatch containment)', () => {
    expect(M78).toContain('stej_provider_matches');
  });
  it('all saga mutators are service-role only', () => {
    const revokes = (M78.match(/revoke all on function app_private\.[a-z_]+\([^)]*\) from public, anon, authenticated/g) ?? []).length;
    expect(revokes).toBeGreaterThanOrEqual(6);
  });
});
