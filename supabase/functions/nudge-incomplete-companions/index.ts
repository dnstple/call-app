/**
 * nudge-incomplete-companions — admin-only, one-click batch that emails every
 * Companion whose profile isn't publishable yet (missing photo / short bio /
 * unsigned consent / unapproved) the "complete your profile" nudge.
 *
 * Operational/account email (transactional), sent via Resend. Idempotent per
 * Companion per day (idempotency_key companion_incomplete/{profile}/{yyyy-mm-dd})
 * so a double-click never double-sends, but you can nudge again another day.
 *
 *   supabase functions deploy nudge-incomplete-companions
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { validateEmailConfig, EmailConfigError } from '../_shared/email/config.ts';
import { renderCompanionNudge } from '../_shared/email/companionNudge.ts';
import { sendViaResend } from '../_shared/email/resend.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

interface IncompleteRow { profile_id: string; account_id: string; first_name: string | null; email: string }

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

  // Authenticate + admin gate.
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorised' }, 401);
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: 'unauthorised' }, 401);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
  const { data: adminRow } = await admin.from('support_admins')
    .select('account_id').eq('account_id', userData.user.id).maybeSingle();
  if (!adminRow) return json({ error: 'forbidden' }, 403);

  const { data: rows, error: listErr } = await admin.rpc('support_incomplete_companions');
  if (listErr) return json({ error: 'list_failed', detail: listErr.message }, 500);
  const companions = (rows ?? []) as IncompleteRow[];

  const day = new Date().toISOString().slice(0, 10);
  let sent = 0, skipped = 0, failed = 0;

  for (const c of companions) {
    if (!c.email) { skipped += 1; continue; }
    const idem = `companion_incomplete/${c.profile_id}/${day}`;

    // Idempotent: skip if already sent/sending today.
    const { data: existing } = await admin.from('email_notifications')
      .select('id,status').eq('idempotency_key', idem).maybeSingle();
    if (existing && ['sending', 'sent', 'delivered'].includes(existing.status)) { skipped += 1; continue; }

    const { data: row, error: insErr } = await admin.from('email_notifications').insert({
      notification_type: 'companion_profile_incomplete',
      recipient_user_id: c.account_id,
      recipient_email: c.email,
      related_entity_type: 'companion_profile',
      related_entity_id: c.profile_id,
      provider: 'resend',
      idempotency_key: idem,
      status: 'sending',
      attempt_count: 1,
    }).select('id').single();
    if (insErr || !row) { skipped += 1; continue; }   // unique race ⇒ another run owns it

    const rendered = renderCompanionNudge({
      firstName: c.first_name ?? '', appUrl: config.appUrl, supportEmail: config.emailReplyTo,
    });
    const result = await sendViaResend(config, { to: c.email, rendered, idempotencyKey: idem });
    if (result.ok) {
      await admin.from('email_notifications').update({
        status: 'sent', provider_message_id: result.messageId ?? null, sent_at: new Date().toISOString(),
      }).eq('id', row.id);
      sent += 1;
    } else {
      await admin.from('email_notifications').update({
        status: 'failed', last_error_code: result.errorCode ?? 'send_failed',
        last_error_message: result.errorMessage ?? null, failed_at: new Date().toISOString(),
      }).eq('id', row.id);
      failed += 1;
    }
  }

  return json({ ok: true, total: companions.length, sent, skipped, failed });
});
