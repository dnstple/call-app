/**
 * Stage 3E-D — release-eligibility verification contracts.
 *
 * The single authoritative eligibility path pre-exists (0034/0067/0068
 * make_earning_payable + release_eligible_earnings; 0072 evidence holds;
 * 0075 scoped release executor with the shared evaluator). Deep behaviour is
 * covered by scopedEarningRelease3c2a / evidencePayoutHolds3b2 /
 * completionInvariant0067 and the hosted RLS suite. These contracts pin the
 * REQUIREMENTS THE STAGE 3E SPECIFICATION NAMES EXPLICITLY so no future edit
 * can weaken them silently.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const sql = (n: string) => readFileSync(join(ROOT, 'supabase', 'migrations', n), 'utf-8');
const M34 = sql('0034_completion_reviews_earnings.sql');
const M68 = sql('0068_restore_completion_earning_semantics.sql');
const M72 = sql('0072_evidence_informed_payout_holds.sql');

describe('3E-D: release eligibility is server-owned and complete', () => {
  it('make_earning_payable is never callable by a browser role', () => {
    expect(M34).toContain('revoke all on function app_private.make_earning_payable(uuid) from public, anon, authenticated');
  });
  it('the 12-hour no-issue rule is expressed in the release paths', () => {
    const twelves = (M34.match(/interval '12 hours'/g) ?? []).length;
    expect(twelves).toBeGreaterThanOrEqual(2); // completion path + scheduled release
  });
  it('an open conversation issue blocks release (held_for_issue, never auto-released)', () => {
    expect(M34).toContain('held_for_issue is NEVER auto-released');
    expect(M34).toContain("state text not null default 'open' check (state in ('open', 'reviewing', 'resolved'))");
    expect(M34).toContain('create unique index if not exists conversation_issues_one_active');
  });
  it('earning creation requires a SUCCEEDED order (one-off/trial) or a PAID billing period (plan)', () => {
    expect(M68).toContain("status = 'succeeded'");
    expect(M68).toMatch(/plan_billing_periods[\s\S]{0,200}status = 'paid'/);
    expect(M68).toContain('occurrences_count < 1');
  });
  it('commercial values come ONLY from immutable snapshots, never the client', () => {
    expect(M68).toContain('v_basis      := v_b.price_minor');
    expect(M68).toContain('v_net        := v_b.companion_amount_minor');
    expect(M68).toMatch(/never client-supplied/);
    expect(M68).toContain('on conflict (booking_id) do nothing'); // exactly one earning
  });
  it('evidence-review holds gate the payable transition orthogonally (0072)', () => {
    expect(M72).toMatch(/make_earning_payable|payable/);
    expect(M72).toContain("state text not null default 'active'");
  });
});
