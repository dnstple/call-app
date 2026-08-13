/**
 * campaign-companion-recruit — MANUAL admin push of the Companion recruitment
 * email ("invite the people you know and earn from every conversation") to every
 * active Companion. No cron; only fires when a support admin triggers it.
 *
 * Idempotent per Companion per day, honours the 'companion_recruit' unsubscribe
 * list, records each send in the email_notifications ledger, includes a one-click
 * List-Unsubscribe.
 *
 *   supabase functions deploy campaign-companion-recruit
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { validateEmailConfig, EmailConfigError } from '../_shared/email/config.ts';
import { renderCompanionRecruit } from '../_shared/email/companionRecruit.ts';
import { buildUnsubscribeUrl } from '../_shared/email/unsubscribe.ts';
import { sendViaResend } from '../_shared/email/resend.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info, x-billing-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

interface CompanionRow { account_id: string; email: string; first_name: string | null }

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

  // Auth: support-admin bearer OR internal cron secret (manual push, but allow both).
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

  const { data: rows, error: listErr } = await admin.rpc('support_active_companions');
  if (listErr) return json({ error: 'list_failed', detail: listErr.message }, 500);
  const companions = (rows ?? []) as CompanionRow[];

  const unsubSecret = Deno.env.get('EMAIL_UNSUBSCRIBE_SECRET') ?? Deno.env.get('BILLING_CRON_SECRET') ?? '';
  const functionsBase = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '') + '/functions/v1';
  const day = new Date().toISOString().slice(0, 10);
  let sent = 0, skipped = 0, failed = 0;

  for (const c of companions) {
    if (!c.email) { skipped += 1; continue; }
    const idem = `companion_recruit/${c.account_id}/${day}`;

    const { data: existing } = await admin.from('email_notifications')
      .select('id,status').eq('idempotency_key', idem).maybeSingle();
    if (existing && ['sending', 'sent', 'delivered'].includes(existing.status)) { skipped += 1; continue; }

    const { data: ledger, error: insErr } = await admin.from('email_notifications').insert({
      notification_type: 'companion_recruit',
      recipient_user_id: c.account_id,
      recipient_email: c.email,
      related_entity_type: 'account',
      related_entity_id: c.account_id,
      provider: 'resend',
      idempotency_key: idem,
      status: 'sending',
      attempt_count: 1,
    }).select('id').single();
    if (insErr || !ledger) { skipped += 1; continue; }

    let unsubscribeUrl = config.appUrl;
    try { unsubscribeUrl = await buildUnsubscribeUrl(config.appUrl, functionsBase, c.account_id, 'companion_recruit', unsubSecret); } catch { /* fall back */ }

    const rendered = renderCompanionRecruit({
      firstName: c.first_name ?? '', appUrl: config.appUrl, supportEmail: config.emailReplyTo, unsubscribeUrl,
    });

    const result = await sendViaResend(config, {
      to: c.email, rendered, idempotencyKey: idem,
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

  return json({ ok: true, total: companions.length, sent, skipped, failed });
});
