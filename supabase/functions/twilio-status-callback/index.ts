/**
 * twilio-status-callback — records Twilio delivery-status webhooks
 * (queued/sent/delivered/failed/undelivered) against the backup_offers /
 * failover_sms_outbox row that carries the MessageSid. Twilio posts
 * application/x-www-form-urlencoded with MessageSid + MessageStatus.
 *
 * This NEVER changes call assignment — it only annotates delivery state. Deploy
 * public (no JWT), and set TWILIO_STATUS_CALLBACK_URL to this function's URL:
 *   supabase functions deploy twilio-status-callback --no-verify-jwt
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  let sid = '', status = '';
  try {
    const form = await req.formData();
    sid = String(form.get('MessageSid') ?? form.get('SmsSid') ?? '');
    status = String(form.get('MessageStatus') ?? form.get('SmsStatus') ?? '');
  } catch {
    try {
      const b = await req.json();
      sid = String(b?.MessageSid ?? b?.SmsSid ?? '');
      status = String(b?.MessageStatus ?? b?.SmsStatus ?? '');
    } catch { /* ignore */ }
  }
  if (!sid || !status) return new Response('ok', { status: 200 }); // ack, nothing to record

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
  await admin.rpc('record_twilio_status', { p_sid: sid, p_status: status });

  // Mirror terminal delivery status onto the outreach ledger (if this SMS was an
  // outreach send). Only terminal states, so a later callback never regresses.
  const s = status.toLowerCase();
  const mapped = s === 'delivered' ? 'delivered'
    : s === 'undelivered' ? 'undelivered'
    : s === 'failed' ? 'failed'
    : null;
  if (mapped) {
    await admin.from('outreach_messages')
      .update({ status: mapped, updated_at: new Date().toISOString() })
      .eq('provider_message_id', sid);
  }
  // Always 200 so Twilio doesn't retry indefinitely (idempotent update anyway).
  return new Response('ok', { status: 200 });
});
