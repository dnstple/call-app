import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderVerifyPhone, VERIFY_PHONE_SUBJECT } from '../../../supabase/functions/_shared/email/verifyPhone.ts';

const base = {
  firstName: 'Grace',
  appUrl: 'https://apricoti.co.uk',
  supportEmail: 'info@apricoti.co.uk',
  unsubscribeUrl: 'https://x.supabase.co/functions/v1/email-unsubscribe?a=1&c=verify_phone&t=abc',
};

describe('verify-phone reminder email', () => {
  it('deep-links to the in-app verify screen (hash route) and includes unsubscribe', () => {
    const r = renderVerifyPhone(base);
    expect(r.subject).toBe(VERIFY_PHONE_SUBJECT);
    expect(r.html).toContain('https://apricoti.co.uk/#/verify-phone');
    expect(r.text).toContain('https://apricoti.co.uk/#/verify-phone');
    expect(r.text).toContain(base.unsubscribeUrl);
    expect(r.html).toContain('email-unsubscribe');
  });

  it('supports a subject override and greets by first name', () => {
    const r = renderVerifyPhone({ ...base, subject: 'Quick step: verify your number' });
    expect(r.subject).toBe('Quick step: verify your number');
    expect(r.html).toContain('Hi Grace,');
  });

  it('escapes the recipient name', () => {
    const r = renderVerifyPhone({ ...base, firstName: '<b>x</b>' });
    expect(r.html).not.toContain('<b>x</b>');
    expect(r.html).toContain('&lt;b&gt;');
  });

  it('falls back to a friendly greeting when no name is known', () => {
    const r = renderVerifyPhone({ ...base, firstName: '' });
    expect(r.html).toContain('Hi there,');
  });
});

const MIG = readFileSync('supabase/migrations/0173_verify_phone_campaign.sql', 'utf8');

describe('verify-phone campaign migration (0173)', () => {
  it('recipient list is service-role only (emails can’t be harvested)', () => {
    expect(MIG).toContain('grant execute on function public.support_unverified_accounts() to service_role');
    expect(MIG).toContain('revoke all on function public.support_unverified_accounts() from public, anon, authenticated');
  });

  it('targets only unverified, active, confirmed accounts and honours the opt-out', () => {
    expect(MIG).toContain('coalesce(a.phone_verified, false) = false');
    expect(MIG).toContain("a.status = 'active'");
    expect(MIG).toContain('u.email_confirmed_at is not null');
    expect(MIG).toContain("s.category = 'verify_phone'");
  });
});
