import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderCompanionRecruit, COMPANION_RECRUIT_SUBJECT } from '../../../supabase/functions/_shared/email/companionRecruit.ts';

const base = {
  firstName: 'Grace',
  appUrl: 'https://apricoti.co.uk',
  supportEmail: 'info@apricoti.co.uk',
  unsubscribeUrl: 'https://x.supabase.co/functions/v1/email-unsubscribe?a=1&c=companion_recruit&t=abc',
};

describe('companion recruitment email', () => {
  it('pitches earning from recruited people, with no £5 bounty', () => {
    const r = renderCompanionRecruit(base);
    expect(r.subject).toBe(COMPANION_RECRUIT_SUBJECT);
    expect(r.html).toContain('earn from every conversation');
    expect(r.html).not.toContain('£5');
    expect(r.text).toContain(base.unsubscribeUrl);
    expect(r.html).toContain('email-unsubscribe');
  });

  it('escapes the recipient name', () => {
    const r = renderCompanionRecruit({ ...base, firstName: '<b>x</b>' });
    expect(r.html).not.toContain('<b>x</b>');
    expect(r.html).toContain('&lt;b&gt;');
  });
});

const MIG = readFileSync('supabase/migrations/0158_companion_recruit_campaign.sql', 'utf8');

describe('companion recruit campaign migration (0158)', () => {
  it('turns off the £5 reward engine (drops trigger + no-op award)', () => {
    expect(MIG).toContain('drop trigger if exists referral_reward_on_earning on public.companion_earnings');
    expect(MIG).toContain('function app_private.maybe_award_referral_reward');
    expect(MIG).toMatch(/No new credit\/cash rewards are awarded[\s\S]*return;/);
  });

  it('recipient list is service-role only; in-app push is support-gated', () => {
    expect(MIG).toContain('grant execute on function public.support_active_companions() to service_role');
    expect(MIG).toContain('revoke all on function public.support_active_companions() from public, anon, authenticated');
    expect(MIG).toContain('function public.support_recruit_companions_inapp()');
    expect(MIG).toContain('is_support_admin()');
    expect(MIG).toContain("'companion_recruit_prompt'");
  });

  it('honours the companion_recruit unsubscribe list and adds a generic suppressor', () => {
    expect(MIG).toContain("s.category = 'companion_recruit'");
    expect(MIG).toContain('function public.suppress_email(p_account uuid, p_category text)');
  });
});
