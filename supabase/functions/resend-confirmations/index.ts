/**
 * resend-confirmations — the "confirm your email to finish joining" arm of the
 * account-setup reminder campaign, for people who signed up but never confirmed
 * their email (so they have no public.accounts row and can't be reached by the
 * ledger-backed nudge-incomplete-onboarding worker).
 *
 * Runs daily from pg_cron (or on demand by a support admin). For each unconfirmed
 * auth user that is DUE (cadence + cap from onboarding_nudge_config, honouring
 * the auth_confirmation_reminders opt-out and a minimum age so we don't pile on
 * right after signup) it mints a magic link via the GoTrue admin API — one click
 * confirms their email AND signs them in, landing them in the app to finish — and
 * sends a branded email with a one-click unsubscribe.
 *
 *   supabase functions deploy resend-confirmations
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { validateEmailConfig, EmailConfigError } from '../_shared/email/config.ts';
import { renderOnboardingNudge } from '../_shared/email/onboardingNudge.ts';
import { buildUnsubscribeUrl } from '../_shared/email/unsubscribe.ts';
import { sendViaResend } from '../_shared/email/resend.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info, x-billing-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const MIN_AGE_MS = 24 * 60 * 60 * 1000;        // don't remind < 24h after signup
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;   // don't chase signups older than 90 days
const PER_PAGE = 1000;
const MAX_PAGES = 20;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let config;
  try {
    config = validateEmailConfig({
      RESEND_API_KEY: Deno.env.get('RESEND_API_KEY'),
      EMAIL_FROM: Deno.env.get('EMAIL_FROM'),
      EMAIL_REPLY_TO: Deno.env.get('EMAIL_REPLY_TO'),
      APP_URL: Deno.env.get('APP_URL'),
      EMAIL_TEST_RECIPIENT: Deno.env.get('EMAIL_TEST_RECIPIENT'),
    });
  } catch (e) {
    if (e instanceof EmailConfigError) return json({ error: 'email_not_configured', detail: e.message }, 503);
    throw e;
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // Auth: internal cron secret OR a support-admin bearer token.
  const cronSecret = Deno.env.get('BILLING_CRON_SECRET') ?? '';
  const isInternal = cronSecret.length > 0 && (req.headers.get('x-billing-secret') ?? '') === cronSecret;
  if (!isInternal) {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorised' }, 401);
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
    );
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: 'unauthorised' }, 401);
    const { data: adminRow } = await admin.from('support_admins')
      .select('account_id').eq('account_id', userData.user.id).maybeSingle();
    if (!adminRow) return json({ error: 'forbidden' }, 403);
  }

  // Cadence config (shared with the confirmed-user campaign).
  const { data: cfgRow } = await admin.from('onboarding_nudge_config')
    .select('enabled,cadence_days,max_reminders').eq('id', true).maybeSingle();
  const cfg = { enabled: cfgRow?.enabled ?? true, cadenceDays: cfgRow?.cadence_days ?? 7, maxReminders: cfgRow?.max_reminders ?? 8 };
  if (!cfg.enabled) return json({ ok: true, skipped: 'campaign_disabled', sent: 0 });

  let limit = 200;
  try { const body = await req.json(); if (Number.isFinite(body?.limit)) limit = Math.max(1, Math.min(500, body.limit)); } catch { /* no body */ }

  const unsubSecret = Deno.env.get('EMAIL_UNSUBSCRIBE_SECRET') ?? Deno.env.get('BILLING_CRON_SECRET') ?? '';
  const functionsBase = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '') + '/functions/v1';
  const day = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  const cadenceMs = cfg.cadenceDays * 24 * 60 * 60 * 1000;
  let scanned = 0, sent = 0, skipped = 0, failed = 0;

  for (let page = 1; page <= MAX_PAGES && sent < limit; page++) {
    const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (listErr) return json({ error: 'list_failed', detail: listErr.message }, 500);
    const users = list?.users ?? [];
    if (users.length === 0) break;

    for (const u of users) {
      if (sent >= limit) break;
      scanned += 1;
      const email = u.email ?? '';
      if (!email) { continue; }
      if (u.email_confirmed_at) { continue; }                 // already confirmed
      const created = u.created_at ? Date.parse(u.created_at) : now;
      if (now - created < MIN_AGE_MS) { continue; }           // too fresh
      if (now - created > MAX_AGE_MS) { continue; }           // too stale

      // Cadence + cap + opt-out from the auth_confirmation_reminders ledger.
      const { data: rec } = await admin.from('auth_confirmation_reminders')
        .select('reminder_count,last_reminded_at,unsubscribed').eq('user_id', u.id).maybeSingle();
      if (rec?.unsubscribed) { skipped += 1; continue; }
      if (rec?.last_reminded_at && (now - Date.parse(rec.last_reminded_at)) < cadenceMs) { skipped += 1; continue; }
      if (cfg.maxReminders > 0 && (rec?.reminder_count ?? 0) >= cfg.maxReminders) { skipped += 1; continue; }

      // Mint a magic link: one click confirms the email AND signs them in.
      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type: 'magiclink', email, options: { redirectTo: config.appUrl },
      });
      const actionLink = linkData?.properties?.action_link;
      if (linkErr || !actionLink) { failed += 1; continue; }

      const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
      const intendedRole = typeof meta.intended_role === 'string' ? meta.intended_role : null;
      const firstName = typeof meta.first_name === 'string' ? meta.first_name : '';

      let unsubscribeUrl = config.appUrl;
      try { unsubscribeUrl = await buildUnsubscribeUrl(config.appUrl, functionsBase, u.id, 'auth_confirmation', unsubSecret); } catch { /* fall back */ }

      const rendered = renderOnboardingNudge({
        firstName, intendedRole, emailConfirmed: false,
        appUrl: config.appUrl, ctaUrl: actionLink,
        supportEmail: config.emailReplyTo, unsubscribeUrl,
      });

      const result = await sendViaResend(config, {
        to: email, rendered, idempotencyKey: `auth_confirmation/${u.id}/${day}`,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });

      if (result.ok) {
        await admin.from('auth_confirmation_reminders').upsert({
          user_id: u.id, email,
          reminder_count: (rec?.reminder_count ?? 0) + 1,
          last_reminded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });
        sent += 1;
      } else {
        failed += 1;
      }
    }

    if (users.length < PER_PAGE) break;
  }

  return json({ ok: true, scanned, sent, skipped, failed });
});
