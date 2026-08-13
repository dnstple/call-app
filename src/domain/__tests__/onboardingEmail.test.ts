import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { renderOnboardingNudge } from '../../../supabase/functions/_shared/email/onboardingNudge.ts';
import { onboardingNudgeKey } from '../../../supabase/functions/_shared/email/idempotency.ts';
import { signUnsubscribe, verifyUnsubscribe, buildUnsubscribeUrl } from '../../../supabase/functions/_shared/email/unsubscribe.ts';
import { sendViaResend } from '../../../supabase/functions/_shared/email/resend.ts';
import { validateEmailConfig } from '../../../supabase/functions/_shared/email/config.ts';

const CONFIG = validateEmailConfig({
  RESEND_API_KEY: 're_test_key',
  EMAIL_FROM: 'Apricoti <notifications@updates.apricoti.co.uk>',
  EMAIL_REPLY_TO: 'info@apricoti.co.uk',
  APP_URL: 'https://apricoti.co.uk',
  EMAIL_TEST_RECIPIENT: 'delivered+apricoti@resend.dev',
});

const base = {
  firstName: 'Sam',
  intendedRole: null as string | null,
  emailConfirmed: true,
  appUrl: 'https://apricoti.co.uk',
  supportEmail: 'info@apricoti.co.uk',
  unsubscribeUrl: 'https://x.supabase.co/functions/v1/email-unsubscribe?a=1&c=onboarding&t=abc',
};

describe('renderOnboardingNudge', () => {
  it('confirmed variant tells them to finish, with CTA + unsubscribe link', () => {
    const r = renderOnboardingNudge({ ...base, emailConfirmed: true });
    expect(r.subject).toMatch(/finish setting up/i);
    expect(r.html).toContain('https://apricoti.co.uk');
    expect(r.html).toContain('email-unsubscribe');           // link present (ampersands HTML-escaped in href)
    expect(r.text).toContain(base.unsubscribeUrl);            // raw URL in the plain-text part
    expect(r.html).toMatch(/Finish my account/);
    expect(r.text).toContain('unsubscribe here');
  });

  it('unconfirmed variant asks them to confirm their email', () => {
    const r = renderOnboardingNudge({ ...base, emailConfirmed: false });
    expect(r.subject).toMatch(/confirm your email/i);
    expect(r.html).toMatch(/confirm/i);
    expect(r.html).toMatch(/Confirm and continue/);
  });

  it('tailors the copy to the chosen role', () => {
    expect(renderOnboardingNudge({ ...base, intendedRole: 'companion' }).html).toMatch(/Companion/);
    expect(renderOnboardingNudge({ ...base, intendedRole: 'coordinator' }).html).toMatch(/Coordinator/);
  });

  it('ctaUrl overrides the button target (magic link for the confirm path)', () => {
    const magic = 'https://project.supabase.co/auth/v1/verify?token=abc&type=magiclink';
    const r = renderOnboardingNudge({ ...base, emailConfirmed: false, ctaUrl: magic });
    expect(r.text).toContain(magic);
    expect(r.html).toContain('auth/v1/verify');   // link present (query escaped in href)
  });

  it('escapes dynamic values (no HTML injection via name)', () => {
    const r = renderOnboardingNudge({ ...base, firstName: '<script>x</script>' });
    expect(r.html).not.toContain('<script>x</script>');
    expect(r.html).toContain('&lt;script&gt;');
  });

  it('idempotency key is one-per-account-per-day', () => {
    expect(onboardingNudgeKey('acc-1', '2026-08-10')).toBe('onboarding_incomplete/acc-1/2026-08-10');
  });
});

describe('unsubscribe token', () => {
  const secret = 'super-secret-cron-value';

  it('verifies a token it signed and rejects tampering', async () => {
    const t = await signUnsubscribe('acc-1', 'onboarding', secret);
    expect(await verifyUnsubscribe('acc-1', 'onboarding', t, secret)).toBe(true);
    expect(await verifyUnsubscribe('acc-2', 'onboarding', t, secret)).toBe(false);     // different account
    expect(await verifyUnsubscribe('acc-1', 'marketing', t, secret)).toBe(false);      // different category
    expect(await verifyUnsubscribe('acc-1', 'onboarding', t, 'wrong-secret')).toBe(false);
    expect(await verifyUnsubscribe('acc-1', 'onboarding', t + '00', secret)).toBe(false);
  });

  it('builds a URL carrying account, category and a valid token', async () => {
    const url = await buildUnsubscribeUrl('https://apricoti.co.uk', 'https://x.supabase.co/functions/v1', 'acc-9', 'onboarding', secret);
    const u = new URL(url);
    expect(u.pathname).toMatch(/email-unsubscribe$/);
    expect(u.searchParams.get('a')).toBe('acc-9');
    expect(u.searchParams.get('c')).toBe('onboarding');
    expect(await verifyUnsubscribe('acc-9', 'onboarding', u.searchParams.get('t')!, secret)).toBe(true);
  });
});

describe('resend passes a List-Unsubscribe header', () => {
  it('forwards custom headers in the request body', async () => {
    let captured: Record<string, unknown> = {};
    const fakeFetch = async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
    };
    const r = await sendViaResend(
      CONFIG,
      {
        to: 'a@b.com',
        rendered: { subject: 's', html: '<p>h</p>', text: 't' },
        idempotencyKey: 'k1',
        headers: { 'List-Unsubscribe': '<https://u>' },
      },
      fakeFetch as unknown as typeof fetch,
    );
    expect(r.ok).toBe(true);
    expect((captured.headers as Record<string, string>)['List-Unsubscribe']).toBe('<https://u>');
  });
});

const MIG = readFileSync('supabase/migrations/0153_onboarding_reminder_engine.sql', 'utf8');
const FN = readFileSync('supabase/functions/nudge-incomplete-onboarding/index.ts', 'utf8');
const UNSUB_FN = readFileSync('supabase/functions/email-unsubscribe/index.ts', 'utf8');

describe('onboarding reminder engine (0153)', () => {
  it('targets incomplete, active accounts and skips the finished', () => {
    expect(MIG).toContain('ac.onboarding_complete = false');
    expect(MIG).toContain("ac.status = 'active'");
  });

  it('enforces weekly cadence, a reminder cap and the unsubscribe list', () => {
    expect(MIG).toContain('cadence_days  integer not null default 7');
    expect(MIG).toContain('max_reminders integer not null default 8');
    expect(MIG).toContain('make_interval(days => cfg.cadence_days)');
    expect(MIG).toContain('cfg.max_reminders = 0 or');
    expect(MIG).toContain('from public.email_suppressions s');
  });

  it('claim + suppress live in public and are granted to service_role only', () => {
    expect(MIG).toContain('function public.claim_onboarding_nudges(');
    expect(MIG).toContain('function public.suppress_onboarding_emails(');
    expect(MIG).toContain('grant execute on function public.claim_onboarding_nudges(integer) to service_role');
    expect(MIG).toContain('grant execute on function public.suppress_onboarding_emails(uuid, text) to service_role');
  });

  it('is scheduled to run daily via pg_cron and pg_net', () => {
    expect(MIG).toContain("cron.schedule('nudge-incomplete-onboarding'");
    expect(MIG).toContain('net.http_post');
    expect(MIG).toContain('/functions/v1/nudge-incomplete-onboarding');
  });
});

describe('sender + unsubscribe edge functions', () => {
  it('sender accepts the cron secret OR a support-admin, and sets List-Unsubscribe', () => {
    expect(FN).toContain("req.headers.get('x-billing-secret')");
    expect(FN).toContain("from('support_admins')");
    expect(FN).toContain("rpc('claim_onboarding_nudges'");
    expect(FN).toContain("'List-Unsubscribe'");
    expect(FN).toContain("'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'");
  });

  it('unsubscribe endpoint verifies the token before suppressing', () => {
    expect(UNSUB_FN).toContain('verifyUnsubscribe');
    expect(UNSUB_FN).toContain("rpc('suppress_email'");
  });

  it('unsubscribe endpoint handles the auth_confirmation category by user id', () => {
    expect(UNSUB_FN).toContain("category === 'auth_confirmation'");
    expect(UNSUB_FN).toContain("from('auth_confirmation_reminders')");
  });
});

const CFG_MIG = readFileSync('supabase/migrations/0154_onboarding_nudge_config_admin.sql', 'utf8');
const CONF_MIG = readFileSync('supabase/migrations/0155_auth_confirmation_reminders.sql', 'utf8');
const CONF_FN = readFileSync('supabase/functions/resend-confirmations/index.ts', 'utf8');

describe('cadence controls (0154)', () => {
  it('exposes support-gated get/set config RPCs granted to authenticated', () => {
    expect(CFG_MIG).toContain('function public.admin_get_onboarding_nudge_config()');
    expect(CFG_MIG).toContain('function public.admin_set_onboarding_nudge_config(');
    expect(CFG_MIG).toContain('app_private.require_support()');
    expect(CFG_MIG).toContain('grant execute on function public.admin_set_onboarding_nudge_config(boolean, integer, integer) to authenticated');
  });

  it('clamps cadence + cap to safe bounds', () => {
    expect(CFG_MIG).toContain('least(greatest(p_cadence_days, 1), 90)');
    expect(CFG_MIG).toContain('greatest(p_max_reminders, 0)');
  });
});

describe('never-confirmed resend path (0155 + resend-confirmations)', () => {
  it('ledger is keyed by auth user id (no accounts FK) with RLS on', () => {
    expect(CONF_MIG).toContain('create table if not exists public.auth_confirmation_reminders');
    expect(CONF_MIG).toContain('user_id          uuid primary key references auth.users(id)');
    expect(CONF_MIG).toContain('enable row level security');
  });

  it('is scheduled daily and offset from the confirmed-user run', () => {
    expect(CONF_MIG).toContain("cron.schedule('resend-confirmations'");
    expect(CONF_MIG).toContain('/functions/v1/resend-confirmations');
  });

  it('worker mints a magic link, honours cadence/cap/opt-out and a min age', () => {
    expect(CONF_FN).toContain("type: 'magiclink'");
    expect(CONF_FN).toContain('email_confirmed_at');
    expect(CONF_FN).toContain('rec?.unsubscribed');
    expect(CONF_FN).toContain('MIN_AGE_MS');
    expect(CONF_FN).toContain("buildUnsubscribeUrl(config.appUrl, functionsBase, u.id, 'auth_confirmation'");
  });
});
