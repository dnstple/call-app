/**
 * Stage 3E-F — support payout queue overview contracts (migration 0086).
 * Functional counter proofs (7 states with exclusion cases) ran on scratch
 * Postgres. The issue/refund/reversal lifecycle itself pre-exists unchanged
 * (0034/0038/0052/0056/0063); 0086 only adds a consolidated read.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const M86 = readFileSync(join(ROOT, 'supabase', 'migrations', '0086_support_payout_queue_overview.sql'), 'utf-8');

describe('0086 support payout queue overview', () => {
  it('is additive and strictly read-only', () => {
    expect(M86).not.toMatch(/create table|insert into|update |delete from|drop /i);
    expect(M86).toContain('language plpgsql stable security definer');
  });
  it('is support-gated with the existing authorisation model', () => {
    expect(M86).toContain('if not app_private.is_support_admin() then');
    expect(M86).toContain("raise exception 'not_found: overview'");
    expect(M86).toContain('revoke all on function public.support_payout_queue_overview() from public, anon');
  });
  it('covers every queue state the Stage 3E specification names', () => {
    for (const key of ['payout_account_action_required', 'held_for_issue', 'evidence_review_active',
      'release_overdue', 'transfer_unknown', 'provider_local_mismatch', 'reversal_required']) {
      expect(M86).toContain(`'${key}'`);
    }
  });
  it('release_overdue excludes open issues, active reviews and recent bookings', () => {
    expect(M86).toMatch(/release_overdue[\s\S]{0,800}interval '24 hours'/);
    expect(M86).toMatch(/release_overdue[\s\S]{0,800}conversation_issues[\s\S]{0,200}in \('open', 'reviewing'\)/);
    expect(M86).toMatch(/release_overdue[\s\S]{0,1100}companion_evidence_payout_reviews/);
  });
  it('transfer_unknown means provider id present + processing + stale (money may have moved)', () => {
    expect(M86).toMatch(/transfer_unknown[\s\S]{0,400}stripe_transfer_id is not null[\s\S]{0,120}interval '30 minutes'/);
  });
  it('uses the CORRECT column names of the underlying tables (status vs state)', () => {
    expect(M86).toContain("f.status not in ('cleared', 'resolved', 'ignored')");
    expect(M86).toContain("a.state <> 'resolved'");
  });
});
