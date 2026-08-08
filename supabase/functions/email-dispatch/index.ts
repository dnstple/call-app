/**
 * email-dispatch — the ONLY authenticated entry point that turns an app event
 * into a transactional email. The caller supplies only { event, bookingId };
 * the recipient, subject and HTML are resolved/rendered SERVER-SIDE from
 * authenticated database records. The Resend API key never leaves this process.
 *
 * Supported events: booking_requested (notify the Companion of a new request).
 * In-app notifications are unaffected — this is an additional channel.
 *
 *   supabase functions deploy email-dispatch      (JWT verification ON)
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { validateEmailConfig, EmailConfigError } from '../_shared/email/config.ts';
import { renderEmail } from '../_shared/email/templates.ts';
import { entityEmailKey } from '../_shared/email/idempotency.ts';
import { sendViaResend } from '../_shared/email/resend.ts';
import {
  assertBookingEmailAuthorized, EmailAuthorizationError,
  formatCallTimes, minimalMemberName, bookingReviewUrl, type BookingRow,
} from '../_shared/email/booking.ts';

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

  // 1. Config (fails loudly if the provider isn't set up).
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

  // 2. Authenticate: either a trusted INTERNAL trigger (the DB booking trigger,
  //    carrying the shared internal secret) or an authenticated USER who must own
  //    the booking. Internal calls skip the booker check because the system, not
  //    a user, is the trigger — but the recipient is STILL resolved from the DB.
  const internalSecret = Deno.env.get('EMAIL_DISPATCH_SECRET') ?? Deno.env.get('BILLING_CRON_SECRET') ?? '';
  const isInternal = internalSecret.length > 0
    && (req.headers.get('x-email-dispatch-secret') ?? '') === internalSecret;

  let callerId: string | null = null;
  if (!isInternal) {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorised' }, 401);
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
    );
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: 'unauthorised' }, 401);
    callerId = userData.user.id;
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // 3. Parse — only a predefined event + entity id, never a recipient/subject/HTML.
  let body: { event?: string; bookingId?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }
  if (body.event !== 'booking_requested' || !body.bookingId) {
    return json({ error: 'unsupported_event' }, 400);
  }

  // 4. Load the booking and authorise the trigger.
  const { data: booking } = await admin.from('bookings').select('*').eq('id', body.bookingId).maybeSingle();
  if (!booking) return json({ error: 'not_found' }, 404);
  if (!isInternal) {
    try {
      assertBookingEmailAuthorized(booking as BookingRow, callerId!);
    } catch (e) {
      if (e instanceof EmailAuthorizationError) return json({ error: 'forbidden' }, 403);
      throw e;
    }
  }

  // 5. Resolve recipient (the Companion) from the record — never from the client.
  const { data: access } = await admin.from('profile_access')
    .select('account_id').eq('profile_id', booking.companion_profile_id)
    .eq('access_role', 'owner').neq('consent_status', 'withdrawn').limit(1).maybeSingle();
  if (!access?.account_id) return json({ error: 'recipient_unresolved' }, 422);
  const companionAccountId = access.account_id as string;

  const { data: companionUser } = await admin.auth.admin.getUserById(companionAccountId);
  const recipientEmail = companionUser?.user?.email;
  if (!recipientEmail) return json({ error: 'recipient_email_missing' }, 422);

  const { data: companionProfile } = await admin.from('profiles')
    .select('first_name').eq('id', booking.companion_profile_id).maybeSingle();
  const { data: memberProfile } = await admin.from('profiles')
    .select('first_name').eq('id', booking.member_profile_id).maybeSingle();

  // 6. Idempotency: deterministic key, unique in DB + passed to Resend.
  const idem = entityEmailKey('booking_requested', booking.id, companionAccountId);
  const { data: existing } = await admin.from('email_notifications')
    .select('id,status').eq('idempotency_key', idem).maybeSingle();
  if (existing && ['sending', 'sent', 'delivered'].includes(existing.status)) {
    return json({ ok: true, deduped: true, id: existing.id });
  }

  const { data: row, error: insErr } = await admin.from('email_notifications').insert({
    notification_type: 'booking_requested',
    recipient_user_id: companionAccountId,
    recipient_email: recipientEmail,
    related_entity_type: 'booking',
    related_entity_id: booking.id,
    provider: 'resend',
    idempotency_key: idem,
    status: 'sending',
    attempt_count: 1,
  }).select('id').single();
  if (insErr || !row) return json({ ok: true, deduped: true });  // unique race ⇒ another worker owns it

  // 7. Render server-side and send.
  const times = formatCallTimes(booking.starts_at, booking.ends_at, booking.timezone);
  const rendered = renderEmail('booking_requested', {
    companionFirstName: minimalMemberName(companionProfile?.first_name),
    memberFirstName: minimalMemberName(memberProfile?.first_name),
    callDateText: times.dateText,
    callTimeText: times.timeText,
    durationText: times.durationText,
    timezone: booking.timezone,
    isTrial: !!booking.is_trial,
    reviewUrl: bookingReviewUrl(config.appUrl, booking.id),
  });

  const result = await sendViaResend(config, { to: recipientEmail, rendered, idempotencyKey: idem });
  if (result.ok) {
    await admin.from('email_notifications').update({
      status: 'sent', provider_message_id: result.messageId ?? null, sent_at: new Date().toISOString(),
    }).eq('id', row.id);
    return json({ ok: true, id: row.id, message_id: result.messageId });
  }
  await admin.from('email_notifications').update({
    status: 'failed', last_error_code: result.errorCode ?? 'send_failed',
    last_error_message: result.errorMessage ?? null, failed_at: new Date().toISOString(),
  }).eq('id', row.id);
  return json({ ok: false, error: 'send_failed', code: result.errorCode }, 502);
});
