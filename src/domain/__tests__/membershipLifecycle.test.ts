import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const MIG = readFileSync('supabase/migrations/0161_membership_lifecycle.sql', 'utf8');
const CHECKOUT = readFileSync('supabase/functions/create-membership-checkout/index.ts', 'utf8');
const WEBHOOK = readFileSync('supabase/functions/stripe-membership-webhook/index.ts', 'utf8');

describe('membership lifecycle (0161, Phase 3)', () => {
  it('starter pays 3 credits once and sets a 7-day anchor', () => {
    expect(MIG).toContain('function public.record_membership_starter_paid');
    expect(MIG).toContain("now() + interval '7 days'");
    expect(MIG).toContain("public.issue_call_credit(m.member_profile_id, p_membership, 'starter', 3)");
    expect(MIG).toContain('starter_credit_issued = true');
  });

  it('weekly accrual releases 3 credits per 7-day boundary while paid, catch-up safe', () => {
    expect(MIG).toContain('function public.accrue_weekly_credits');
    expect(MIG).toContain("'weekly', 3");
    expect(MIG).toContain("v_due + interval '7 days'");
    expect(MIG).toContain('v_guard < 8');
    expect(MIG).toContain("cron.schedule('accrue-weekly-credits'");
  });

  it('lifecycle functions are service-role only', () => {
    for (const fn of ['upsert_membership', 'record_membership_starter_paid', 'record_membership_invoice_paid', 'record_membership_status', 'accrue_weekly_credits', 'grant_extra_credits']) {
      expect(MIG).toContain(`grant execute on function public.${fn}`);
    }
    expect(MIG).not.toMatch(/grant execute on function public\.(record_membership_starter_paid|accrue_weekly_credits)[^;]*to authenticated/);
  });
});

describe('membership edge functions (Phase 3)', () => {
  it('checkout charges the £25 starter and is act-for-member gated', () => {
    expect(CHECKOUT).toContain('STARTER_MINOR = 2500');
    expect(CHECKOUT).toContain("kind: 'membership_starter'");
    expect(CHECKOUT).toContain("from('profile_access')");
    expect(CHECKOUT).toContain('already_member');
  });

  it('webhook creates the subscription 7 days out and drives credit issuance', () => {
    expect(WEBHOOK).toContain('constructEventAsync');
    expect(WEBHOOK).toContain('7 * 24 * 60 * 60');
    expect(WEBHOOK).toContain("rpc('upsert_membership'");
    expect(WEBHOOK).toContain("rpc('record_membership_starter_paid'");
    expect(WEBHOOK).toContain("rpc('accrue_weekly_credits'");
    expect(WEBHOOK).toContain("rpc('record_membership_status'");
  });
});
