/**
 * nudge-book-first-call — one-off "book your first call" nudge to members who do
 * NOT have an active membership. Three channels per member:
 *   1. in-app notification (always) — via record_first_call_nudge (dedupe marker)
 *   2. email (Resend) — if we have an email
 *   3. SMS (Twilio) — ONLY to a verified mobile
 *
 * Triggered on demand by a support admin (Bearer token) or the shared cron secret
 * (x-billing-secret). claim_first_call_nudges enforces the audience (no active
 * membership) and excludes anyone already nudged, so re-running never double-sends.
 *
 * SELF-CONTAINED: everything is inlined (no ../_shared imports) so it deploys
 * straight from the dashboard editor.
 *
 *   Env: RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO, APP_URL,
 *        TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER (or
 *        TWILIO_MESSAGING_SERVICE_SID), BILLING_CRON_SECRET.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info, x-billing-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

interface DueRow {
  account_id: string;
  email: string | null;
  first_name: string | null;
  phone_e164: string | null;
  phone_verified: boolean | null;
}

// ---- inlined: signed one-click unsubscribe (HMAC-SHA256(secret, "acct:category")) ----
const enc = new TextEncoder();
function toHex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}
async function signUnsubscribe(accountId: string, category: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${accountId}:${category}`));
  return toHex(sig);
}
async function buildUnsubscribeUrl(functionsBaseUrl: string, accountId: string, category: string, secret: string): Promise<string> {
  const token = await signUnsubscribe(accountId, category, secret);
  const params = new URLSearchParams({ a: accountId, c: category, t: token });
  return `${functionsBaseUrl.replace(/\/+$/, '')}/email-unsubscribe?${params.toString()}`;
}

// ---- inlined: minimal Resend send ----
async function sendEmail(
  cfg: { apiKey: string; from: string; replyTo?: string },
  input: { to: string; subject: string; html: string; text: string; idempotencyKey: string; headers?: Record<string, string> },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify({
        from: cfg.from,
        to: [input.to],
        ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
        subject: input.subject,
        html: input.html,
        text: input.text,
        ...(input.headers && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
      }),
    });
    if (!res.ok) {
      let msg = String(res.status);
      try { const b = await res.json(); msg = b?.message ?? b?.name ?? msg; } catch { /* keep */ }
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---- inlined: Twilio Messages send ----
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

function renderEmail(firstName: string | null, bookUrl: string, unsubscribeUrl: string) {
  const hi = firstName && firstName.trim() ? `Hi ${firstName.trim()},` : 'Hi,';
  const subject = 'Book your first Apricoti call';
  const text =
    `${hi}\n\nYou're all set to book your first call with an Apricoti companion — a friendly ` +
    `45-minute conversation, whenever suits you.\n\nBook now: ${bookUrl}\n\n` +
    `If you'd rather not receive these, unsubscribe here: ${unsubscribeUrl}`;
  const html =
    `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#1e1a17;line-height:1.5">` +
    `<p>${hi}</p>` +
    `<p>You're all set to book your <strong>first call</strong> with an Apricoti companion — a friendly ` +
    `45-minute conversation, whenever suits you.</p>` +
    `<p><a href="${bookUrl}" style="display:inline-block;background:#c8674e;color:#fff;text-decoration:none;` +
    `padding:11px 20px;border-radius:8px;font-weight:600">Book your first call</a></p>` +
    `<p style="color:#8a817b;font-size:12px;margin-top:24px">` +
    `If you'd rather not receive these, <a href="${unsubscribeUrl}" style="color:#8a817b">unsubscribe</a>.</p>` +
    `</div>`;
  return { subject, html, text };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const resendKey = Deno.env.get('RESEND_API_KEY') ?? '';
  const emailFrom = Deno.env.get('EMAIL_FROM') ?? '';
  const emailReplyTo = Deno.env.get('EMAIL_REPLY_TO') ?? '';
  const appUrl = (Deno.env.get('APP_URL') ?? '').replace(/\/+$/, '');
  if (!resendKey || !emailFrom || !appUrl) {
    return json({ error: 'email_not_configured', detail: 'RESEND_API_KEY, EMAIL_FROM and APP_URL are required.' }, 503);
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

  // Dry-run support: { dryRun: true } returns the audience size without sending.
  let limit = 200;
  let dryRun = false;
  try {
    const body = await req.json();
    if (Number.isFinite(body?.limit)) limit = Math.max(1, Math.min(1000, body.limit));
    dryRun = body?.dryRun === true;
  } catch { /* no body */ }

  const { data: rows, error: listErr } = await admin.rpc('claim_first_call_nudges', { p_limit: limit });
  if (listErr) return json({ error: 'list_failed', detail: listErr.message }, 500);
  const due = (rows ?? []) as DueRow[];

  if (dryRun) {
    const withPhone = due.filter((r) => r.phone_verified && r.phone_e164).length;
    const withEmail = due.filter((r) => r.email).length;
    return json({ ok: true, dryRun: true, audience: due.length, would_sms: withPhone, would_email: withEmail });
  }

  const functionsBase = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '') + '/functions/v1';
  const unsubSecret = Deno.env.get('EMAIL_UNSUBSCRIBE_SECRET') ?? cronSecret;
  const bookUrl = `${appUrl}/#/explore`;

  let inApp = 0, emails = 0, texts = 0, emailFailed = 0, smsFailed = 0;

  for (const r of due) {
    // 1. In-app (also the "already nudged" marker; makes re-runs safe).
    const { error: recErr } = await admin.rpc('record_first_call_nudge', { p_account: r.account_id });
    if (!recErr) inApp += 1;

    // 2. Email.
    if (r.email) {
      let unsubscribeUrl = appUrl;
      try { unsubscribeUrl = await buildUnsubscribeUrl(functionsBase, r.account_id, 'system', unsubSecret); } catch { /* fall back */ }
      const rendered = renderEmail(r.first_name, bookUrl, unsubscribeUrl);
      const result = await sendEmail(
        { apiKey: resendKey, from: emailFrom, replyTo: emailReplyTo || undefined },
        {
          to: r.email, subject: rendered.subject, html: rendered.html, text: rendered.text,
          idempotencyKey: `first_call_nudge:${r.account_id}`,
          headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        },
      );
      if (result.ok) emails += 1; else emailFailed += 1;
    }

    // 3. SMS — verified mobiles only.
    if (r.phone_verified && r.phone_e164) {
      const smsBody = `Apricoti: you're all set — book your first call with a companion here: ${bookUrl}  Reply STOP to opt out.`;
      const sms = await sendSms(r.phone_e164, smsBody);
      if (sms.ok) texts += 1; else smsFailed += 1;
    }
  }

  return json({ ok: true, audience: due.length, in_app: inApp, emails, texts, email_failed: emailFailed, sms_failed: smsFailed });
});
