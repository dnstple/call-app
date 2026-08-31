/**
 * call-failover — TRANSPORT worker for the backup-companion / call-failover
 * feature. It does NOT decide anything: all state transitions happen in the
 * database (process_failover_tick, run by pg_cron). This function only:
 *   1. reads the pending SMS (failover_sms_pending) — standby/emergency offers
 *      needing an SMS, plus queued member/companion reassignment notices;
 *   2. sends each via Twilio;
 *   3. records the message SID/status back (record_offer_sms / record_outbox_sms).
 *
 * It is idempotent: offers already carrying a SID and outbox rows already 'sent'
 * are not returned again, so running it repeatedly can't double-send. SMS is
 * gated by backup_failover_config.sms_enabled (kill-switch).
 *
 * Auth: internal cron secret (x-billing-secret) OR a support-admin bearer token.
 *   supabase functions deploy call-failover
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { readTwilioConfig, sendSms } from '../_shared/twilio/sms.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info, x-billing-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

interface OfferRow {
  offer_id: string; token: string; batch: 'initial' | 'emergency';
  phone: string | null; phone_verified: boolean; first_name: string | null;
  starts_at: string; duration_minutes: number; timezone: string | null;
}
interface NoticeRow { id: number; kind: string; body: string; phone: string | null; phone_verified: boolean; }

function localTime(iso: string, tz: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz ?? 'Europe/London',
    }).format(new Date(iso)).replace(/\s/g, '').toLowerCase();
  } catch { return ''; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // Auth: internal cron secret OR support-admin bearer.
  const cronSecret = Deno.env.get('BILLING_CRON_SECRET') ?? '';
  const isInternal = cronSecret.length > 0 && (req.headers.get('x-billing-secret') ?? '') === cronSecret;
  if (!isInternal) {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorised' }, 401);
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
    );
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ error: 'unauthorised' }, 401);
    const { data: adminRow } = await admin.from('support_admins')
      .select('account_id').eq('account_id', u.user.id).maybeSingle();
    if (!adminRow) return json({ error: 'forbidden' }, 403);
  }

  const { data: pending, error } = await admin.rpc('failover_sms_pending');
  if (error) return json({ error: 'pending_failed', detail: error.message }, 500);

  const p = (pending ?? {}) as {
    sms_enabled?: boolean; app_url?: string; notices?: NoticeRow[]; offers?: OfferRow[];
  };
  if (!p.sms_enabled) {
    return json({ ok: true, skipped: 'sms_disabled', offers: (p.offers ?? []).length, notices: (p.notices ?? []).length });
  }

  const twilio = readTwilioConfig();
  if (!twilio) return json({ ok: false, error: 'twilio_not_configured' }, 503);
  const appUrl = (p.app_url ?? 'https://apricoti.co.uk').replace(/\/+$/, '');

  let sentOffers = 0, sentNotices = 0, failed = 0, skipped = 0;

  // 1. Offer SMS (standby + emergency) with the secure response link.
  for (const o of p.offers ?? []) {
    if (!o.phone || !o.phone_verified) { skipped += 1; continue; }
    const time = localTime(o.starts_at, o.timezone);
    const link = `${appUrl}/#/cover?o=${o.offer_id}&t=${o.token}`;
    const body = o.batch === 'emergency'
      ? `Apricoti: Cover needed for a ${o.duration_minutes}-minute call at ${time} today. If you can take it, confirm here: ${link}`
      : `Apricoti: A ${o.duration_minutes}-minute call at ${time} today may need cover. Are you available if needed? View and respond: ${link}`;
    const r = await sendSms(twilio, o.phone, body);
    await admin.rpc('record_offer_sms', { p_offer: o.offer_id, p_sid: r.sid ?? null, p_status: r.status ?? (r.ok ? 'queued' : 'failed') });
    if (r.ok) sentOffers += 1; else failed += 1;
  }

  // 2. Member / companion reassignment notices from the outbox.
  for (const n of p.notices ?? []) {
    if (!n.phone || !n.phone_verified) {
      await admin.rpc('record_outbox_sms', { p_id: n.id, p_sid: null, p_status: 'no_phone', p_ok: false });
      skipped += 1; continue;
    }
    const r = await sendSms(twilio, n.phone, n.body);
    await admin.rpc('record_outbox_sms', { p_id: n.id, p_sid: r.sid ?? null, p_status: r.status ?? (r.ok ? 'queued' : 'failed'), p_ok: r.ok });
    if (r.ok) sentNotices += 1; else failed += 1;
  }

  return json({ ok: true, sent_offers: sentOffers, sent_notices: sentNotices, failed, skipped });
});
