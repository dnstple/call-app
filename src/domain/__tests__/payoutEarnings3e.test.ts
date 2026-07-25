/**
 * Stage 3E-C — Companion earnings projection contracts (migration 0085 +
 * earningsRepository). Functional bucket proofs ran on scratch Postgres
 * (7 buckets + foreign-companion exclusion); these pin structure and mapping.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const M85 = readFileSync(join(ROOT, 'supabase', 'migrations', '0085_companion_earnings_projection.sql'), 'utf-8');
const REPO = readFileSync(join(ROOT, 'src', 'repositories', 'earningsRepository.ts'), 'utf-8');

describe('0085 is additive and read-only', () => {
  it('creates no tables, alters no state machines, deletes nothing', () => {
    expect(M85).not.toMatch(/create table/i);
    expect(M85).not.toMatch(/drop\s+table|drop\s+column|delete\s+from|truncate/i);
    expect(M85).not.toMatch(/update public\.companion_earnings/i);
    expect(M85).not.toMatch(/insert into/i);
  });
  it('both readers are STABLE (no mutation possible) and owner-scoped to auth.uid()', () => {
    const stableCount = (M85.match(/language plpgsql stable security definer/g) ?? []).length;
    expect(stableCount).toBe(3); // bucket classifier + 2 readers
    const scopes = M85.match(/companion_account_id = auth\.uid\(\)/g) ?? [];
    expect(scopes.length).toBe(2); // summary + list
    expect(M85).toMatch(/if auth\.uid\(\) is null then raise exception 'Not authenticated'/);
  });
  it('exposes NO provider identifiers or payer/account internals', () => {
    for (const banned of ['stripe_transfer_id', 'connected_account_id', 'idempotency_key',
      'payer_account_id', 'stripe_account_id', 'failure_message']) {
      // may appear in comments only — assert not in the returned column lists
      const returns = M85.match(/returns table \([\s\S]*?\)/g)?.join('\n') ?? '';
      expect(returns).not.toContain(banned);
    }
  });
  it('bucket classifier is the single authority and is not client-executable', () => {
    expect(M85).toContain('create or replace function app_private.companion_earning_bucket');
    expect(M85).toContain('revoke all on function app_private.companion_earning_bucket(public.companion_earnings)\n  from public, anon, authenticated');
  });
  it('respects the 0072 evidence-review hold when classifying payable earnings', () => {
    expect(M85).toMatch(/companion_evidence_payout_reviews r[\s\S]{0,200}in \('active', 'claimed'\)/);
  });
  it('list is bounded (limit clamped to 200)', () => {
    expect(M85).toContain('limit greatest(1, least(coalesce(p_limit, 50), 200))');
  });
});

describe('earningsRepository mapping', () => {
  it('is read-only: never calls any mutating supabase surface', () => {
    expect(REPO).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    const rpcs = REPO.match(/rpc\('([a-z_]+)'/g) ?? [];
    expect(rpcs.sort()).toEqual([
      "rpc('get_my_companion_earnings_summary'",
      "rpc('list_my_companion_earnings'",
    ]);
  });
  it('never re-derives financial state client-side (bucket comes from the server)', () => {
    expect(REPO).not.toMatch(/state === 'payable'|transfer_state ===/);
    expect(REPO).toContain("BUCKETS.includes(r.bucket as EarningBucket)");
  });
  it('mock mode returns empty structures, never fabricated money', () => {
    expect(REPO).toMatch(/if \(!isSupabaseMode\(\)\) return emptySummary\(\)/);
    expect(REPO).toMatch(/if \(!isSupabaseMode\(\)\) return \[\]/);
  });
  it('bucket copy never claims payment before transfer and keeps holds neutral', () => {
    expect(REPO).toMatch(/available:\s*\{ label: 'Available'/);
    // 'Paid' wording is reserved for the transferred bucket alone.
    const paidUses = REPO.match(/label: 'Paid'/g) ?? [];
    expect(paidUses.length).toBe(1);
    expect(REPO).toMatch(/transferred: \{ label: 'Paid'/);
    expect(REPO).toMatch(/on_hold: \{ label: 'On hold', hint: '[^']*No action needed/);
  });
});
