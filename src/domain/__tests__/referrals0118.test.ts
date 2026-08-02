/**
 * Referrals (migration 0118) — authority + safety contract.
 *
 * Runtime behaviour (mint, self-service pilot grant, cohort inheritance,
 * attribution, dual notifications, and every abuse guard) is proven against a
 * from-scratch schema in stage validation. These tests lock the guarantees the
 * source must keep: authorisation, one-per rules, and calm error copy.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { referralErrorMessage } from '../../repositories/referralRepository';

const ROOT = join(__dirname, '..', '..', '..');
const M = readFileSync(join(ROOT, 'supabase', 'migrations', '0118_referrals.sql'), 'utf-8');

describe('0118 referral schema + RLS', () => {
  it('keeps one live code per referrer and one redemption per invitee', () => {
    expect(M).toMatch(/create unique index[^;]*referral_codes_one_active[\s\S]*where not revoked/);
    expect(M).toContain('unique (invitee_account_id)');
  });
  it('exposes only own rows and writes only through RPCs', () => {
    expect(M).toContain('alter table public.referral_codes enable row level security');
    expect(M).toContain('referrer_account_id = auth.uid()');
    expect(M).not.toMatch(/for (insert|update|delete) to authenticated/); // no client writes
  });
});

describe('0118 minting + eligibility', () => {
  it('only pilot/full accounts may mint a code', () => {
    expect(M).toMatch(/access_level[\s\S]*not in \('pilot', 'full'\)[\s\S]*referral_not_eligible/);
    expect(M).toContain('grant execute on function public.my_referral_code() to authenticated');
  });
});

describe('0118 redemption authority + guards', () => {
  it('row-locks the code so it can never be over-redeemed', () => {
    expect(M).toContain('for update');
    expect(M).toMatch(/uses >= v_code\.max_uses[\s\S]*referral_exhausted/);
  });
  it('rejects self-referral, repeat redemption, blocked, and already-active accounts', () => {
    expect(M).toMatch(/referrer_account_id = v_uid[\s\S]*referral_self/);
    expect(M).toMatch(/invitee_account_id = v_uid[\s\S]*referral_already_used/);
    expect(M).toMatch(/v_level = 'blocked'[\s\S]*referral_unavailable/);
    expect(M).toMatch(/v_level in \('pilot', 'full'\)[\s\S]*referral_not_needed/);
  });
  it('grants pilot via the audited access spine and inherits the referrer cohort', () => {
    expect(M).toMatch(/update public\.account_access set[\s\S]*access_level = 'pilot'/);
    expect(M).toContain('cohort_id = coalesce(cohort_id,');
    expect(M).toContain("app_private.audit_access(v_uid, 'referral_redeemed'");
    expect(M).toContain("app_private.enqueue_access_event(v_uid, 'pilot_access_granted'");
    expect(M).toContain("'referral_accepted'"); // referrer thank-you notification
    expect(M).toContain('Your invite was accepted');
  });
  it('is authorised by the code, not support (no require_support in redemption)', () => {
    const redeem = M.slice(M.indexOf('function public.redeem_referral_code'));
    expect(redeem).not.toContain('require_support');
  });
});

describe('referral error copy', () => {
  it('maps server hints to calm, non-technical messages', () => {
    expect(referralErrorMessage({ hint: 'referral_invalid' })).toMatch(/isn.t valid/i);
    expect(referralErrorMessage({ hint: 'referral_self' })).toMatch(/your own/i);
    expect(referralErrorMessage({ hint: 'referral_exhausted' })).toMatch(/fully used/i);
    expect(referralErrorMessage({ hint: 'referral_not_eligible' })).toMatch(/pilot members/i);
    expect(referralErrorMessage({ message: 'weird' })).toMatch(/couldn.t apply/i);
  });
});
