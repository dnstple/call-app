/**
 * send-sms — admin one-off SMS sender. Sends either to a single number or to a
 * date-based audience of verified sign-ups, form-encoding the request the way
 * Twilio requires (which pg_net can't do directly).
 *
 * Auth: internal cron secret (x-billing-secret) — so it's callable from SQL via
 * pg_net — OR a support-admin Bearer token.
 *
 * Body:
 *   { to: "+447…", body: "…" }                → send to that one number
 *   { since: "2026-09-04", body: "…" }        → send to every verified sign-up
 *                                               created on/after that date
 *   add { dryRun: true } to return the audience count without sending.
 *
 * SELF-CONTAINED (no ../_shared imports). Deploy WITHOUT JWT verification:
 *   supabase functions deploy send-sms --no-verify-jwt
 *   Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER (or
 *        TWILIO_MESSAGING_SERVICE_SID), BILLING_CRON_SECRET,
 *        SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info, x-billing-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function sendSms(to: string, body: string): Promise<{ ok: boolean; sid?: string; error?: string }> {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
  const token = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
  const from = Deno.env.get('TWILIO_FROM_NUMBER') ?? '';
  const msgSvc = Deno.env.get('TWILIO_MESSAGING_SERVICE_SID') ?? '';
  if (!sid || !token || (!from && !msgSvc)) return { ok: false, error: 'twilio_not_configured' };
  const form = new URLSearchParams();
  form.set('To', to);
  form.set('Body', body);
  if (msgSvc) form.set('MessagingServiceSid', msgSvc); else form.set('From', from);
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + btoa(`${sid}:${token}`), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (data as { message?: string })?.message ?? String(res.status) };
    return { ok: true, sid: (data as { sid?: string })?.sid };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // Auth: cron secret OR support-admin bearer.
  let callerId = '';
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
    callerId = userData.user.id;
  }

  let to = ''; let since = ''; let body = ''; let dryRun = false; let source = 'verified'; let selfTest = false;
  let roles: string[] = [];
  try {
    const b = await req.json();
    to = String(b?.to ?? '');
    since = String(b?.since ?? '');
    body = String(b?.body ?? '');
    dryRun = b?.dryRun === true;
    selfTest = b?.selfTest === true;
    if (Array.isArray(b?.roles)) roles = b.roles.map((r: unknown) => String(r)).filter(Boolean);
    // 'verified' (default) = confirmed mobiles; 'unverified' = numbers typed at the
    // verify step but never confirmed; 'all' = both.
    if (b?.source === 'unverified' || b?.source === 'all') source = b.source;
  } catch { /* no body */ }

  if (!body) return json({ error: 'missing_body_text' }, 400);

  // Build the recipient list.
  let recipients: string[] = [];
  if (selfTest) {
    if (!callerId) return json({ error: 'no_self', detail: 'Self-test requires a signed-in admin.' }, 400);
    const { data: acct } = await admin.from('accounts').select('phone_e164').eq('id', callerId).maybeSingle();
    const phone = (acct as { phone_e164?: string | null } | null)?.phone_e164 ?? '';
    if (!phone) return json({ error: 'no_self_phone', detail: 'Your account has no verified mobile to test to.' }, 400);
    recipients = [phone];
  } else if (to) {
    recipients = [to];
  } else if (roles.length > 0) {
    const { data, error } = await admin.rpc('broadcast_recipients_sms', { p_roles: roles });
    if (error) return json({ error: 'audience_failed', detail: error.message }, 500);
    recipients = (data ?? [])
      .map((r: { phone: string | null }) => r.phone)
      .filter((p): p is string => !!p);
  } else if (since) {
    const { data, error } = await admin.rpc('outreach_recent_sms', {
      p_since: since,
      p_include_verified: source === 'verified' || source === 'all',
      p_include_unverified: source === 'unverified' || source === 'all',
    });
    if (error) return json({ error: 'audience_failed', detail: error.message }, 500);
    recipients = (data ?? [])
      .map((r: { phone: string | null }) => r.phone)
      .filter((p): p is string => !!p);
  } else {
    return json({ error: 'need_to_since_or_roles' }, 400);
  }

  if (dryRun) return json({ ok: true, dryRun: true, audience: recipients.length });

  let sent = 0, failed = 0;
  const errors: string[] = [];
  for (const phone of recipients) {
    const r = await sendSms(phone, body);
    if (r.ok) sent += 1;
    else { failed += 1; if (errors.length < 5) errors.push(`${phone}: ${r.error}`); }
  }

  return json({ ok: true, audience: recipients.length, sent, failed, errors });
});
