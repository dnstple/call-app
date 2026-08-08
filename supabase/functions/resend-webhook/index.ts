/**
 * resend-webhook — verified delivery-event sink for Resend (Svix-signed).
 *
 * Verifies the RAW body against RESEND_WEBHOOK_SECRET, rejects bad signatures,
 * records each event id exactly once (idempotent), and advances the matching
 * email_notifications row by provider message id. An email is only ever marked
 * delivered/bounced/complained/failed HERE — never from the send API's 200.
 *
 * Self-authenticating (Svix signature), so deploy WITHOUT a Supabase JWT check:
 *   supabase functions deploy resend-webhook --no-verify-jwt
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { mapResendEvent, verifyResendSignature } from '../_shared/email/webhook.ts';

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const secret = Deno.env.get('RESEND_WEBHOOK_SECRET') ?? '';
  const raw = await req.text();   // exact bytes — never re-serialise before verifying

  const ok = await verifyResendSignature(secret, {
    id: req.headers.get('svix-id'),
    timestamp: req.headers.get('svix-timestamp'),
    signature: req.headers.get('svix-signature'),
  }, raw);
  if (!ok) return json({ error: 'invalid_signature' }, 401);

  let event: { type?: string; data?: { email_id?: string } };
  try { event = JSON.parse(raw); } catch { return json({ error: 'bad_payload' }, 400); }

  const eventId = req.headers.get('svix-id') ?? '';
  const messageId = event?.data?.email_id ?? null;
  const eventType = event?.type ?? '';

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // Idempotent processing: record the event id once; a repeat is a no-op.
  const { error: ledgerErr } = await admin.from('email_webhook_events')
    .insert({ event_id: eventId, event_type: eventType, message_id: messageId });
  if (ledgerErr) return json({ ok: true, duplicate: true });   // unique violation ⇒ already handled

  const mapping = mapResendEvent(eventType);
  if (!mapping || !mapping.status || !messageId) {
    return json({ ok: true, acknowledged: true });   // delivery_delayed / unknown: recorded, no status change
  }

  const patch: Record<string, unknown> = { status: mapping.status };
  if (mapping.tsField) patch[mapping.tsField] = new Date().toISOString();
  if (mapping.status === 'failed' || mapping.status === 'bounced') {
    patch.last_error_code = eventType;
  }

  await admin.from('email_notifications').update(patch).eq('provider_message_id', messageId);
  return json({ ok: true, status: mapping.status });
});
