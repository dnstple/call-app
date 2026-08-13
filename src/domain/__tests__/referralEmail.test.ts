import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  renderReferralInvitation, ReferralTemplateError,
  REFERRAL_TEMPLATE_KEY, REFERRAL_TEMPLATE_VERSION, REFERRAL_DEFAULT_SUBJECT,
  REFERRAL_PREVIEW_FIXTURE, type ReferralInvitationVars,
} from '../../../supabase/functions/_shared/email/referralInvitation.ts';

const base = (): ReferralInvitationVars => ({ ...REFERRAL_PREVIEW_FIXTURE });

describe('referral invitation template — identity', () => {
  it('has the required key + version', () => {
    expect(REFERRAL_TEMPLATE_KEY).toBe('coordinator_member_referral_invitation');
    expect(REFERRAL_TEMPLATE_VERSION).toBe('v1');
  });
});

describe('required variable validation', () => {
  it('renders with the full fixture', () => {
    const r = renderReferralInvitation(base());
    expect(r.subject).toBe(REFERRAL_DEFAULT_SUBJECT);
    expect(r.preheader).toContain('Coordinator or Member');
    expect(r.html).toContain('Grace');
    expect(r.html).toContain('GRACE24');
  });

  for (const key of ['recipient_first_name', 'referral_url', 'referral_code', 'support_email', 'unsubscribe_url', 'programme_limit'] as const) {
    it(`throws when required "${key}" is missing`, () => {
      const v = base(); delete (v as unknown as Record<string, unknown>)[key];
      expect(() => renderReferralInvitation(v)).toThrow(ReferralTemplateError);
    });
    it(`throws when required "${key}" is blank`, () => {
      const v = { ...base(), [key]: '   ' } as ReferralInvitationVars;
      expect(() => renderReferralInvitation(v)).toThrow(/Missing required variable/);
    });
  }
});

describe('URL safety', () => {
  it('rejects javascript:, data: and non-https app links', () => {
    expect(() => renderReferralInvitation({ ...base(), referral_url: 'javascript:alert(1)' })).toThrow(ReferralTemplateError);
    expect(() => renderReferralInvitation({ ...base(), referral_url: 'data:text/html,x' })).toThrow(ReferralTemplateError);
    expect(() => renderReferralInvitation({ ...base(), referral_url: 'http://apricoti.co.uk/join' })).toThrow(/https/);
  });
  it('rejects app links on unapproved domains', () => {
    expect(() => renderReferralInvitation({ ...base(), referral_url: 'https://evil.example.com/join?ref=X' })).toThrow(/approved Apricoti domain/);
    expect(() => renderReferralInvitation({ ...base(), privacy_url: 'https://phish.co.uk/privacy' })).toThrow(/approved Apricoti domain/);
  });
  it('accepts apricoti.co.uk subdomains', () => {
    expect(() => renderReferralInvitation({ ...base(), referral_url: 'https://go.apricoti.co.uk/join?ref=X' })).not.toThrow();
  });
  it('allows a provider-hosted https unsubscribe link (any host)', () => {
    expect(() => renderReferralInvitation({ ...base(), unsubscribe_url: 'https://email.resend.com/unsubscribe/abc' })).not.toThrow();
    expect(() => renderReferralInvitation({ ...base(), unsubscribe_url: 'http://insecure/unsub' })).toThrow(/https/);
  });
  it('rejects a malformed support email', () => {
    expect(() => renderReferralInvitation({ ...base(), support_email: 'not-an-email' })).toThrow(/support email/);
  });
});

describe('escaping and injection', () => {
  it('escapes hostile referral code and name — no raw HTML', () => {
    const r = renderReferralInvitation({ ...base(), referral_code: '<script>steal()</script>', recipient_first_name: 'A"><img src=x>' });
    expect(r.html).not.toContain('<script>steal()');
    expect(r.html).toContain('&lt;script&gt;steal()');
    expect(r.html).not.toContain('<img src=x>');
  });
  it('leaves no unrendered template syntax or undefined values', () => {
    const r = renderReferralInvitation(base());
    expect(r.html).not.toContain('{{');
    expect(r.html).not.toContain('}}');
    expect(r.html).not.toContain('undefined');
  });
});

describe('optional values drop cleanly', () => {
  it('carries no cash-bounty wording (introductions are about earning from calls)', () => {
    const r = renderReferralInvitation(base());
    expect(r.html).not.toContain('£5');
    expect(r.html).not.toContain('successful referral');
    expect(r.html).toContain('earn in the ordinary way');
  });
  it('omits optional preferences/office cleanly', () => {
    const v = base(); delete v.preferences_url; delete v.registered_office_address;
    const r = renderReferralInvitation(v);
    expect(r.html).not.toContain('Email preferences');
    expect(r.html).not.toContain(' · </'); // no dangling separator
  });
});

describe('robust content', () => {
  it('handles very long names and codes', () => {
    const r = renderReferralInvitation({ ...base(), recipient_first_name: 'A'.repeat(120), referral_code: 'Z'.repeat(64) });
    expect(r.html).toContain('Z'.repeat(64));
  });
  it('CTA is bulletproof (has an MSO VML fallback) and ~44px tall', () => {
    const r = renderReferralInvitation(base());
    expect(r.html).toContain('v:roundrect');
    expect(r.html).toMatch(/min-height:44px|height:48px/);
  });
  it('frames the value as earning from conversations, with no £5 bounty', () => {
    const r = renderReferralInvitation(base());
    expect(r.html).toContain('You earn every time');
    expect(r.html).toContain('earn from every conversation');
    expect(r.html).not.toContain('£5');
    expect(r.html).not.toContain('£10');
  });
});

describe('plain-text version is complete', () => {
  it('contains programme, both milestones, url, code, terms, support, unsubscribe', () => {
    const r = renderReferralInvitation(base());
    expect(r.text).toContain('You earn every time');
    expect(r.text).not.toContain('£5');
    expect(r.text).toContain('https://apricoti.co.uk/join?ref=GRACE24');
    expect(r.text).toContain('GRACE24');
    expect(r.text).toContain('https://apricoti.co.uk/referral-terms');
    expect(r.text).toContain('info@apricoti.co.uk');
    expect(r.text).toContain('Unsubscribe: https://apricoti.co.uk/unsubscribe?u=demo');
  });
});

describe('no PII leakage', () => {
  it('renders only the recipient/referrer’s own data — no member/coordinator fields exist to leak', () => {
    const r = renderReferralInvitation(base());
    // The template surface has no member/coordinator PII fields at all.
    for (const forbidden of ['member_email', 'member_name', 'coordinator_email', 'phone', 'address_line']) {
      expect(r.html.toLowerCase()).not.toContain(forbidden);
    }
  });
});

// Emit a preview artifact for manual/visual review (does NOT send anything).
describe('preview artifact', () => {
  it('writes the rendered HTML + text preview', () => {
    const r = renderReferralInvitation(REFERRAL_PREVIEW_FIXTURE);
    mkdirSync('marketing', { recursive: true });
    writeFileSync('marketing/referral-invitation-preview.html', r.html, 'utf8');
    writeFileSync('marketing/referral-invitation-preview.txt', r.text, 'utf8');
    expect(r.html.length).toBeGreaterThan(1000);
  });
});
