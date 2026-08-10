import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SQL = readFileSync('supabase/migrations/0148_referral_reward_engine.sql', 'utf8');

describe('referral reward engine (0148)', () => {
  it('rewards £5 (500 minor) after the required paid calls', () => {
    expect(SQL).toContain('reward_minor integer not null default 500');
    expect(SQL).toContain('paid_calls_required integer not null default 4');
    expect(SQL).toContain('v_paid < v_cfg.paid_calls_required');
  });

  it('counts only completed, non-trial, non-reversed calls as "paid"', () => {
    expect(SQL).toContain("po.order_type <> 'trial'");
    expect(SQL).toContain("ce.state <> 'reversed'");
    expect(SQL).toContain('household_paid_calls');
  });

  it('is one reward per household and honours the pilot cap', () => {
    expect(SQL).toContain('household_account_id uuid not null unique');
    expect(SQL).toContain('household_cap integer not null default 25');
    expect(SQL).toContain('v_awarded >= v_cfg.household_cap');
    expect(SQL).toMatch(/if exists \(select 1 from public\.referral_rewards where household_account_id = p_household\)/);
  });

  it('attributes via referral_redemptions and blocks self-referral', () => {
    expect(SQL).toContain('from public.referral_redemptions where invitee_account_id = p_household');
    expect(SQL).toContain('v_referrer = p_household then return');
  });

  it('issues the reward as a referral_reward credit and notifies the referrer', () => {
    expect(SQL).toContain("'referral_reward'");
    expect(SQL).toContain('issue_account_credit');
    expect(SQL).toContain("'referral-reward-' || p_household::text");   // idempotent credit key
    expect(SQL).toContain("notify_account");
  });

  it('evaluates on new earnings but never blocks earning creation', () => {
    expect(SQL).toContain('after insert on public.companion_earnings');
    expect(SQL).toContain('maybe_award_referral_reward(new.payer_account_id)');
    expect(SQL).toMatch(/exception when others then\s*null;/);   // reward failure can't roll back the earning
  });
});
