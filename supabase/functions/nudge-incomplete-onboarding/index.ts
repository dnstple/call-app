/**
 * nudge-incomplete-onboarding — the automated "finish setting up your account"
 * reminder campaign. Runs daily from pg_cron (app_private.invoke_onboarding_nudges
 * → this function, authenticated by the shared cron secret), and can also be
 * triggered on demand by a support admin (Bearer token) from the console.
 *
 * For each account that is DUE a reminder (app_private.claim_onboarding_nudges
 * enforces the weekly cadence, the reminder cap and the unsubscribe list) it
 * renders the right variant (confirm-your-email vs finish-your-profile), sends
 * via Resend with a one-click List-Unsubscribe header, and records the send in
 * the email_notifications ledger (idempotent per account per day).
 *
 *   supabase functions deploy nudge-incomplete-onboarding
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { validateEmailConfig, EmailConfigError } from '../_shared/email/config.ts';
import { renderOnboardingNudge } from '../_shared/email/onboardingNudge.ts';
import { onboardingNudgeKey } from '../_shared/email/idempotency.ts';
import { buildUnsubscribeUrl } from '../_shared/email/unsubscribe.ts';
import { sendViaResend } from '../_shared/email/resend.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info, x-billing-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

interface DueRow {
  account_id: string;
  email: string;
  first_name: string | null;
  intended_role: string | null;
  email_confirmed: boolean;
}

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

  // Batch size (default 200, capped).
  let limit = 200;
  try { const body = await req.json(); if (Number.isFinite(body?.limit)) limit = Math.max(1, Math.min(500, body.limit)); } catch { /* no body */ }

  const { data: rows, error: listErr } = await admin.rpc('claim_onboarding_nudges', { p_limit: limit });
  if (listErr) return json({ error: 'list_failed', detail: listErr.message }, 500);
  const due = (rows ?? []) as DueRow[];

  const unsubSecret = Deno.env.get('EMAIL_UNSUBSCRIBE_SECRET') ?? Deno.env.get('BILLING_CRON_SECRET') ?? '';
  const functionsBase = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '') + '/functions/v1';
  const day = new Date().toISOString().slice(0, 10);
  let sent = 0, skipped = 0, failed = 0;

  for (const r of due) {
    if (!r.email) { skipped += 1; continue; }
    const idem = onboardingNudgeKey(r.account_id, day);

    // Idempotent: skip if already sent/sending today.
    const { data: existing } = await admin.from('email_notifications')
      .select('id,status').eq('idempotency_key', idem).maybeSingle();
    if (existing && ['sending', 'sent', 'delivered'].includes(existing.status)) { skipped += 1; continue; }

    const { data: ledger, error: insErr } = await admin.from('email_notifications').insert({
      notification_type: 'onboarding_incomplete',
      recipient_user_id: r.account_id,
      recipient_email: r.email,
      related_entity_type: 'account',
      related_entity_id: r.account_id,
      provider: 'resend',
      idempotency_key: idem,
      status: 'sending',
      attempt_count: 1,
    }).select('id').single();
    if (insErr || !ledger) { skipped += 1; continue; }   // unique race ⇒ another run owns it

    let unsubscribeUrl = `${config.appUrl}`;
    try { unsubscribeUrl = await buildUnsubscribeUrl(config.appUrl, functionsBase, r.account_id, 'onboarding', unsubSecret); } catch { /* fall back to app url */ }

    const rendered = renderOnboardingNudge({
      firstName: r.first_name ?? '',
      intendedRole: r.intended_role,
      emailConfirmed: r.email_confirmed,
      appUrl: config.appUrl,
      supportEmail: config.emailReplyTo,
      unsubscribeUrl,
    });

    const result = await sendViaResend(config, {
      to: r.email,
      rendered,
      idempotencyKey: idem,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });

    if (result.ok) {
      await admin.from('email_notifications').update({
        status: 'sent', provider_message_id: result.messageId ?? null, sent_at: new Date().toISOString(),
      }).eq('id', ledger.id);
      sent += 1;
    } else {
      await admin.from('email_notifications').update({
        status: 'failed', last_error_code: result.errorCode ?? 'send_failed',
        last_error_message: result.errorMessage ?? null, failed_at: new Date().toISOString(),
      }).eq('id', ledger.id);
      failed += 1;
    }
  }

  return json({ ok: true, total: due.length, sent, skipped, failed });
});
