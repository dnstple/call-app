/**
 * call-failover — TRANSPORT worker for the backup-companion / call-failover
 * feature. It does NOT decide anything: all state transitions happen in the
 * database (process_failover_tick, run by pg_cron). This function only reads the
 * pending SMS (failover_sms_pending), sends each via Twilio, and records the SID
 * back. Idempotent (rows already sent aren't returned again) and gated by
 * backup_failover_config.sms_enabled.
 *
 * SELF-CONTAINED (Twilio helper inlined) so it can be deployed by pasting into
 * the Supabase dashboard's Edge Functions editor — no CLI or shared files.
 * Auth: internal cron secret (x-billing-secret) OR a support-admin bearer token.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info, x-billing-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ---- inlined Twilio SMS sender -------------------------------------------
interface TwilioCfg { accountSid: string; authToken: string; from?: string; messagingServiceSid?: string; statusCallback?: string; }
function readTwilio(): TwilioCfg | null {
  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
  const from = Deno.env.get('TWILIO_FROM_NUMBER') ?? '';
  const messagingServiceSid = Deno.env.get('TWILIO_MESSAGING_SERVICE_SID') ?? '';
  if (!accountSid || !authToken || (!from && !messagingServiceSid)) return null;
  return { accountSid, authToken, from: from || undefined, messagingServiceSid: messagingServiceSid || undefined, statusCallback: Deno.env.get('TWILIO_STATUS_CALLBACK_URL') || undefined };
}
async function sendSms(cfg: TwilioCfg, to: string, body: string): Promise<{ ok: boolean; sid?: string; status?: string; error?: string }> {
  try {
    const form = new URLSearchParams();
    form.set('To', to); form.set('Body', body);
    if (cfg.messagingServiceSid) form.set('MessagingServiceSid', cfg.messagingServiceSid);
    else if (cfg.from) form.set('From', cfg.from);
    if (cfg.statusCallback) form.set('StatusCallback', cfg.statusCallback);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(`${cfg.accountSid}:${cfg.authToken}`), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: String(res.status), error: data?.message ?? 'twilio_error' };
    return { ok: true, sid: data?.sid, status: data?.status ?? 'queued' };
  } catch (err) { return { ok: false, error: (err as Error).message }; }
}
// --------------------------------------------------------------------------

interface OfferRow { offer_id: string; token: string; batch: 'initial' | 'emergency'; phone: string | null; phone_verified: boolean; first_name: string | null; starts_at: string; duration_minutes: number; timezone: string | null; }
interface NoticeRow { id: number; kind: string; body: string; phone: string | null; phone_verified: boolean; }

function localTime(iso: string, tz: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz ?? 'Europe/London' })
      .format(new Date(iso)).replace(/\s/g, '').toLowerCase();
  } catch { return ''; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  const cronSecret = Deno.env.get('BILLING_CRON_SECRET') ?? '';
  const isInternal = cronSecret.length > 0 && (req.headers.get('x-billing-secret') ?? '') === cronSecret;
  if (!isInternal) {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorised' }, 401);
    const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ error: 'unauthorised' }, 401);
    const { data: adminRow } = await admin.from('support_admins').select('account_id').eq('account_id', u.user.id).maybeSingle();
    if (!adminRow) return json({ error: 'forbidden' }, 403);
  }

  const { data: pending, error } = await admin.rpc('failover_sms_pending');
  if (error) return json({ error: 'pending_failed', detail: error.message }, 500);
  const p = (pending ?? {}) as { sms_enabled?: boolean; app_url?: string; notices?: NoticeRow[]; offers?: OfferRow[] };
  if (!p.sms_enabled) return json({ ok: true, skipped: 'sms_disabled', offers: (p.offers ?? []).length, notices: (p.notices ?? []).length });

  const twilio = readTwilio();
  if (!twilio) return json({ ok: false, error: 'twilio_not_configured' }, 503);
  const appUrl = (p.app_url ?? 'https://apricoti.co.uk').replace(/\/+$/, '');

  let sentOffers = 0, sentNotices = 0, failed = 0, skipped = 0;

  for (const o of p.offers ?? []) {
    if (!o.phone || !o.phone_verified) { skipped += 1; continue; }
    const time = localTime(o.starts_at, o.timezone);
    const link = `${appUrl}/#/cover?o=${o.offer_id}&t=${o.token}`;
    const body = o.batch === 'emergency'
      ? `Apricoti: Cover needed for a ${o.duration_minutes}-minute call at ${time} today. If you can take it, confirm here: ${link}`
      : `Apricoti: There's a ${o.duration_minutes}-minute call at ${time} today that may not be covered — are you okay to take it over if needed? Confirm or decline here: ${link}`;
    const r = await sendSms(twilio, o.phone, body);
    await admin.rpc('record_offer_sms', { p_offer: o.offer_id, p_sid: r.sid ?? null, p_status: r.status ?? (r.ok ? 'queued' : 'failed') });
    if (r.ok) sentOffers += 1; else failed += 1;
  }

  for (const n of p.notices ?? []) {
    if (!n.phone || !n.phone_verified) { await admin.rpc('record_outbox_sms', { p_id: n.id, p_sid: null, p_status: 'no_phone', p_ok: false }); skipped += 1; continue; }
    const r = await sendSms(twilio, n.phone, n.body);
    await admin.rpc('record_outbox_sms', { p_id: n.id, p_sid: r.sid ?? null, p_status: r.status ?? (r.ok ? 'queued' : 'failed'), p_ok: r.ok });
    if (r.ok) sentNotices += 1; else failed += 1;
  }

  return json({ ok: true, sent_offers: sentOffers, sent_notices: sentNotices, failed, skipped });
});
