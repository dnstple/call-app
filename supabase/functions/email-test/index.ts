/**
 * email-test — admin-only delivery validation. Requires an authenticated
 * Apricoti support admin, and sends ONLY to the configured EMAIL_TEST_RECIPIENT.
 * Any recipient/subject/HTML in the request body is ignored: this function can
 * never be coerced into emailing an arbitrary address. No booking, call or
 * payment is created.
 *
 *   supabase functions deploy email-test          (JWT verification ON)
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { validateEmailConfig, EmailConfigError } from '../_shared/email/config.ts';
import { renderEmail } from '../_shared/email/templates.ts';
import { testEmailKey } from '../_shared/email/idempotency.ts';
import { sendViaResend } from '../_shared/email/resend.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

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
      RESEND_WEBHOOK_SECRET: Deno.env.get('RESEND_WEBHOOK_SECRET'),
      EMAIL_ENV: Deno.env.get('EMAIL_ENV'),
    });
  } catch (e) {
    if (e instanceof EmailConfigError) return json({ error: 'email_not_configured', detail: e.message }, 503);
    throw e;
  }

  // Authenticate.
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorised' }, 401);
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: 'unauthorised' }, 401);
  const callerId = userData.user.id;

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // Admin gate: must be a support admin.
  const { data: adminRow } = await admin.from('support_admins')
    .select('account_id').eq('account_id', callerId).maybeSingle();
  if (!adminRow) return json({ error: 'forbidden' }, 403);

  // Fixed recipient — the request body's recipient (if any) is IGNORED.
  const to = config.testRecipient;
  const testRunId = crypto.randomUUID();
  const idem = testEmailKey(testRunId);
  const now = new Date();

  const rendered = renderEmail('email_test', {
    environment: config.environment,
    testRunId,
    timestampText: now.toISOString(),
    appUrl: config.appUrl,
  });

  const { data: row, error: insErr } = await admin.from('email_notifications').insert({
    notification_type: 'email_test',
    recipient_user_id: callerId,
    recipient_email: to,
    related_entity_type: 'test_run',
    provider: 'resend',
    idempotency_key: idem,
    status: 'sending',
    attempt_count: 1,
  }).select('id').single();
  if (insErr || !row) return json({ error: 'insert_failed' }, 500);

  const result = await sendViaResend(config, { to, rendered, idempotencyKey: idem });
  if (result.ok) {
    await admin.from('email_notifications').update({
      status: 'sent', provider_message_id: result.messageId ?? null, sent_at: now.toISOString(),
    }).eq('id', row.id);
    return json({ ok: true, test_run_id: testRunId, recipient: to, message_id: result.messageId });
  }
  await admin.from('email_notifications').update({
    status: 'failed', last_error_code: result.errorCode ?? 'send_failed',
    last_error_message: result.errorMessage ?? null, failed_at: now.toISOString(),
  }).eq('id', row.id);
  return json({ ok: false, error: 'send_failed', code: result.errorCode }, 502);
});
