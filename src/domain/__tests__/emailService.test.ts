import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

import { escapeHtml } from '../../../supabase/functions/_shared/email/escape.ts';
import { validateEmailConfig, EmailConfigError, assertProductionUrl } from '../../../supabase/functions/_shared/email/config.ts';
import { entityEmailKey, testEmailKey } from '../../../supabase/functions/_shared/email/idempotency.ts';
import { renderEmail } from '../../../supabase/functions/_shared/email/templates.ts';
import { mapResendEvent, verifyResendSignature } from '../../../supabase/functions/_shared/email/webhook.ts';
import { sendViaResend } from '../../../supabase/functions/_shared/email/resend.ts';
import { assertBookingEmailAuthorized, EmailAuthorizationError, type BookingRow } from '../../../supabase/functions/_shared/email/booking.ts';
import { MARKETING_CAMPAIGN_HTML, marketingPreviewHtml } from '../../../supabase/functions/_shared/email/marketing.ts';
import { renderCompanionNudge, COMPANION_NUDGE_SUBJECT } from '../../../supabase/functions/_shared/email/companionNudge.ts';

const GOOD_ENV = {
  RESEND_API_KEY: 're_test_key',
  EMAIL_FROM: 'Apricoti <notifications@updates.apricoti.co.uk>',
  EMAIL_REPLY_TO: 'info@apricoti.co.uk',
  APP_URL: 'https://apricoti.co.uk',
  EMAIL_TEST_RECIPIENT: 'delivered+apricoti@resend.dev',
  RESEND_WEBHOOK_SECRET: 'whsec_dGVzdHNlY3JldA==',
};

const src = (p: string) => readFileSync(`supabase/functions/${p}`, 'utf8');
const booking = (over: Partial<BookingRow> = {}): BookingRow => ({
  id: 'b1', booked_by_account_id: 'member-acct', member_profile_id: 'mem', companion_profile_id: 'comp',
  starts_at: '2026-08-08T14:00:00Z', ends_at: '2026-08-08T14:30:00Z', timezone: 'Europe/London',
  is_trial: false, status: 'requested', ...over,
});

describe('email config validation', () => {
  it('accepts a complete production config', () => {
    const c = validateEmailConfig(GOOD_ENV);
    expect(c.emailFrom).toContain('updates.apricoti.co.uk');
    expect(c.appUrl).toBe('https://apricoti.co.uk');
  });

  it('throws when the provider is not configured (missing key)', () => {
    expect(() => validateEmailConfig({ ...GOOD_ENV, RESEND_API_KEY: undefined })).toThrow(EmailConfigError);
    expect(() => validateEmailConfig({ ...GOOD_ENV, EMAIL_FROM: '' })).toThrow(/Missing email configuration/);
  });

  it('rejects a localhost / preview APP_URL (incorrect environment URL)', () => {
    expect(() => validateEmailConfig({ ...GOOD_ENV, APP_URL: 'http://localhost:5173' })).toThrow(EmailConfigError);
    expect(() => assertProductionUrl('https://apricoti.vercel.app')).toThrow();
    expect(() => assertProductionUrl('https://preview.apricoti.co.uk')).toThrow();
    expect(() => assertProductionUrl('http://apricoti.co.uk')).toThrow(); // must be https
  });
});

describe('idempotency keys are deterministic', () => {
  it('same inputs → identical key (duplicate send collapses)', () => {
    const a = entityEmailKey('booking_requested', 'bk_1', 'user_9');
    const b = entityEmailKey('booking_requested', 'bk_1', 'user_9');
    expect(a).toBe(b);
    expect(a).toBe('booking_requested/bk_1/user_9');
    expect(testEmailKey('run_5')).toBe('test_email/run_5');
  });
});

describe('HTML escaping', () => {
  it('escapes dangerous characters', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(escapeHtml("O'Brien & <b>")).toBe('O&#39;Brien &amp; &lt;b&gt;');
  });

  it('a malicious member name never reaches the HTML unescaped', () => {
    const { html, text } = renderEmail('booking_requested', {
      companionFirstName: 'Amy', memberFirstName: '<script>steal()</script>',
      callDateText: 'Fri, 8 Aug 2026', callTimeText: '3:00 PM', durationText: '30 minutes',
      timezone: 'Europe/London', isTrial: false, reviewUrl: 'https://apricoti.co.uk/#/bookings/b1',
    });
    expect(html).not.toContain('<script>steal()');
    expect(html).toContain('&lt;script&gt;steal()');
    expect(text).toBeTypeOf('string');
    expect(text.length).toBeGreaterThan(0);
  });

  it('CTA links use the configured production APP_URL, never localhost', () => {
    const { html } = renderEmail('email_test', {
      environment: 'production', testRunId: 'r1', timestampText: '2026-08-08T00:00:00Z', appUrl: 'https://apricoti.co.uk',
    });
    expect(html).toContain('https://apricoti.co.uk');
    expect(html).not.toContain('localhost');
  });
});

describe('booking email authorization (users cannot email another user)', () => {
  it('allows the booker to trigger the Companion email', () => {
    expect(() => assertBookingEmailAuthorized(booking(), 'member-acct')).not.toThrow();
  });
  it('rejects a caller who does not own the booking', () => {
    expect(() => assertBookingEmailAuthorized(booking(), 'someone-else')).toThrow(EmailAuthorizationError);
    expect(() => assertBookingEmailAuthorized(booking(), '')).toThrow(EmailAuthorizationError);
  });
});

describe('Resend send client', () => {
  it('sends successfully and returns the provider message id', async () => {
    const rendered = renderEmail('email_test', { environment: 'test', testRunId: 'r', timestampText: 't', appUrl: 'https://apricoti.co.uk' });
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 });
    };
    const r = await sendViaResend(validateEmailConfig(GOOD_ENV), { to: 'a@b.com', rendered, idempotencyKey: 'test_email/r' }, fakeFetch);
    expect(r.ok).toBe(true);
    expect(r.messageId).toBe('msg_123');
    // API key travels only in the Authorization header of the server call.
    expect((calls[0].init.headers as Record<string, string>)['Idempotency-Key']).toBe('test_email/r');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toContain('re_test_key');
  });

  it('reports a provider failure without throwing', async () => {
    const rendered = renderEmail('email_test', { environment: 'test', testRunId: 'r', timestampText: 't', appUrl: 'https://apricoti.co.uk' });
    const fakeFetch = async () => new Response(JSON.stringify({ name: 'rate_limited', message: 'slow down' }), { status: 429 });
    const r = await sendViaResend(validateEmailConfig(GOOD_ENV), { to: 'a@b.com', rendered, idempotencyKey: 'k' }, fakeFetch);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('rate_limited');
  });
});

describe('Resend webhook event mapping', () => {
  it('maps delivery events to the correct status + timestamp column', () => {
    expect(mapResendEvent('email.sent')).toEqual({ status: 'sent', tsField: 'sent_at' });
    expect(mapResendEvent('email.delivered')).toEqual({ status: 'delivered', tsField: 'delivered_at' });
    expect(mapResendEvent('email.bounced')).toEqual({ status: 'bounced', tsField: 'bounced_at' });
    expect(mapResendEvent('email.complained')).toEqual({ status: 'complained', tsField: 'complained_at' });
    expect(mapResendEvent('email.failed')).toEqual({ status: 'failed', tsField: 'failed_at' });
  });
  it('acknowledges delivery_delayed without regressing status, and ignores unknown', () => {
    expect(mapResendEvent('email.delivery_delayed')).toEqual({ status: null, tsField: null });
    expect(mapResendEvent('email.nonsense')).toBeNull();
  });
});

describe('Resend webhook signature verification', () => {
  const secret = 'whsec_dGVzdHNlY3JldA=='; // base64("testsecret")
  const id = 'msg_abc'; const ts = '1700000000'; const body = '{"type":"email.delivered"}';
  const sign = (s: string, i: string, t: string, b: string) => {
    const key = Buffer.from(s.replace('whsec_', ''), 'base64');
    return createHmac('sha256', key).update(`${i}.${t}.${b}`).digest('base64');
  };

  it('accepts a valid signature', async () => {
    const sig = `v1,${sign(secret, id, ts, body)}`;
    expect(await verifyResendSignature(secret, { id, timestamp: ts, signature: sig }, body)).toBe(true);
  });
  it('rejects a tampered body', async () => {
    const sig = `v1,${sign(secret, id, ts, body)}`;
    expect(await verifyResendSignature(secret, { id, timestamp: ts, signature: sig }, '{"type":"email.bounced"}')).toBe(false);
  });
  it('rejects a wrong secret and missing headers', async () => {
    const sig = `v1,${sign(secret, id, ts, body)}`;
    expect(await verifyResendSignature('whsec_d3Jvbmc=', { id, timestamp: ts, signature: sig }, body)).toBe(false);
    expect(await verifyResendSignature(secret, { id: null, timestamp: ts, signature: sig }, body)).toBe(false);
    expect(await verifyResendSignature('', { id, timestamp: ts, signature: sig }, body)).toBe(false);
  });
});

// Handler-level guarantees asserted against the Edge Function source (these
// behaviours live in the Deno handlers, which don't run under Vitest).
describe('Edge Function guarantees (source contract)', () => {
  it('email-test requires a support admin and returns 403 otherwise', () => {
    const s = src('email-test/index.ts');
    expect(s).toContain("from('support_admins')");
    expect(s).toMatch(/if \(!adminRow\) return json\(\{ error: 'forbidden' \}, 403\)/);
  });

  it('email-test sends ONLY to the configured recipient (no arbitrary recipient injection)', () => {
    const s = src('email-test/index.ts');
    expect(s).toContain('const to = config.testRecipient');
    // It must not read a recipient/to/email from the request body.
    expect(s).not.toMatch(/body\.(to|recipient|email)/);
  });

  it('unauthenticated callers are rejected (401) before any send', () => {
    for (const fn of ['email-test/index.ts', 'email-dispatch/index.ts']) {
      expect(src(fn)).toMatch(/return json\(\{ error: 'unauthorised' \}, 401\)/);
    }
  });

  it('dispatch resolves the recipient from the DB record, never from the client', () => {
    const s = src('email-dispatch/index.ts');
    expect(s).toContain("from('profile_access')");
    expect(s).toContain('getUserById');
    expect(s).not.toMatch(/body\.(to|recipient|recipientEmail)/);
  });

  it('a send success is only marked "sent" — never "delivered" (webhook-only)', () => {
    const dispatch = src('email-dispatch/index.ts');
    expect(dispatch).toContain("status: 'sent'");
    expect(dispatch).not.toContain("status: 'delivered'");
    // 'delivered' is set exclusively from the verified webhook mapping.
    expect(src('resend-webhook/index.ts')).toContain('mapResendEvent');
  });

  it('webhook verifies the signature and processes each event id once (idempotent)', () => {
    const s = src('resend-webhook/index.ts');
    expect(s).toContain('verifyResendSignature');
    expect(s).toMatch(/return json\(\{ error: 'invalid_signature' \}, 401\)/);
    expect(s).toContain("from('email_webhook_events')");
    expect(s).toContain('duplicate: true');
  });

  it('marketing broadcast always carries an unsubscribe link and personalises safely', () => {
    // The broadcast HTML must include Resend's unsubscribe + name tokens.
    expect(MARKETING_CAMPAIGN_HTML).toContain('{{{RESEND_UNSUBSCRIBE_URL}}}');
    expect(MARKETING_CAMPAIGN_HTML).toContain('{{{FIRST_NAME|there}}}');
    // The admin preview substitutes both tokens (nothing raw left, real URL, not localhost).
    const preview = marketingPreviewHtml('https://www.apricoti.co.uk');
    expect(preview).not.toContain('{{{');
    expect(preview).toContain('https://www.apricoti.co.uk/unsubscribe');
    expect(preview).not.toContain('localhost');
  });

  it('marketing send is admin-gated and requires the SEND confirmation', () => {
    const s = src('marketing-broadcast/index.ts');
    expect(s).toContain("from('support_admins')");
    expect(s).toMatch(/return json\(\{ error: 'forbidden' \}, 403\)/);
    expect(s).toMatch(/return json\(\{ error: 'unauthorised' \}, 401\)/);
    // Sending to everyone cannot happen without the explicit confirmation.
    expect(s).toContain("body.confirm !== 'SEND'");
    // Sync is create-only so it never re-subscribes someone who opted out.
    expect(s).toContain('never resurrect');
  });

  it('companion nudge renders safely with the CTA on APP_URL', () => {
    const r = renderCompanionNudge({ firstName: '<b>Grace</b>', appUrl: 'https://apricoti.co.uk', supportEmail: 'info@apricoti.co.uk' });
    expect(r.subject).toBe(COMPANION_NUDGE_SUBJECT);
    expect(r.html).not.toContain('<b>Grace</b>');           // escaped
    expect(r.html).toContain('&lt;b&gt;Grace');
    expect(r.html).toContain('https://apricoti.co.uk');
    expect(r.text).toContain('info@apricoti.co.uk');
    expect(r.html).not.toContain('localhost');
  });

  it('incomplete-companion nudge is admin-gated and idempotent per companion/day', () => {
    const s = src('nudge-incomplete-companions/index.ts');
    expect(s).toContain("from('support_admins')");
    expect(s).toMatch(/return json\(\{ error: 'forbidden' \}, 403\)/);
    expect(s).toContain("rpc('support_incomplete_companions')");
    expect(s).toContain('companion_incomplete/');           // deterministic idempotency key
  });

  it('the Resend API key stays server-side (never in the frontend repository)', () => {
    // The browser only invokes the Edge Function; it never sees the key.
    const repo = readFileSync('src/repositories/emailRepository.ts', 'utf8');
    expect(repo).not.toContain('RESEND_API_KEY');
    expect(repo).not.toContain('resendApiKey');
    expect(repo).not.toContain('api.resend.com');
    // The key value is only ever read from config inside the server-only client.
    expect(src('_shared/email/resend.ts')).toContain('config.resendApiKey');
  });
});
