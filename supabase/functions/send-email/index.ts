/**
 * send-email — admin one-off email sender. Sends either to a single address or
 * to a date-based audience of recent sign-ups (via outreach_recent_emails).
 * Reaches dropped-off users who never got as far as a phone number.
 *
 * Auth: internal cron secret (x-billing-secret) — callable from SQL via pg_net —
 * OR a support-admin Bearer token.
 *
 * Body:
 *   { to: "a@b.com", subject, body }            → one address
 *   { since: "2026-09-04", subject, body }       → every sign-up since that date
 *   add { dryRun: true } to return the audience count without sending.
 * `body` is plain text; a simple branded HTML version is generated from it, and a
 * one-click unsubscribe (category 'outreach') is appended.
 *
 * Deploy WITHOUT JWT verification:  supabase functions deploy send-email --no-verify-jwt
 *   Env: RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO, APP_URL, BILLING_CRON_SECRET,
 *        EMAIL_UNSUBSCRIBE_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info, x-billing-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const enc = new TextEncoder();
function toHex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf); let out = '';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}
async function unsubscribeUrl(base: string, accountId: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${accountId}:outreach`));
  const params = new URLSearchParams({ a: accountId, c: 'outreach', t: toHex(sig) });
  return `${base.replace(/\/+$/, '')}/email-unsubscribe?${params.toString()}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function linkify(s: string): string {
  return s.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" style="color:#c8643d">$1</a>');
}

async function sendEmail(
  cfg: { apiKey: string; from: string; replyTo?: string },
  input: { to: string; subject: string; html: string; text: string; idempotencyKey: string; headers?: Record<string, string> },
): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify({
        from: cfg.from, to: [input.to],
        ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
        subject: input.subject, html: input.html, text: input.text,
        ...(input.headers && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
      }),
    });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (b as { message?: string })?.message ?? String(res.status) };
    return { ok: true, id: (b as { id?: string })?.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const resendKey = Deno.env.get('RESEND_API_KEY') ?? '';
  const emailFrom = Deno.env.get('EMAIL_FROM') ?? '';
  const emailReplyTo = Deno.env.get('EMAIL_REPLY_TO') ?? '';
  if (!resendKey || !emailFrom) return json({ error: 'email_not_configured' }, 503);
  const functionsBase = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '') + '/functions/v1';
  const unsubSecret = Deno.env.get('EMAIL_UNSUBSCRIBE_SECRET') ?? Deno.env.get('BILLING_CRON_SECRET') ?? '';

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  let callerId = ''; let callerEmail = '';
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
    callerEmail = userData.user.email ?? '';
  }

  let to = ''; let since = ''; let subject = ''; let body = ''; let dryRun = false; let selfTest = false;
  let roles: string[] = [];
  try {
    const b = await req.json();
    to = String(b?.to ?? '');
    since = String(b?.since ?? '');
    subject = String(b?.subject ?? '');
    body = String(b?.body ?? '');
    dryRun = b?.dryRun === true;
    selfTest = b?.selfTest === true;
    if (Array.isArray(b?.roles)) roles = b.roles.map((r: unknown) => String(r)).filter(Boolean);
  } catch { /* no body */ }

  if (!subject || !body) return json({ error: 'missing_subject_or_body' }, 400);

  // Recipients: [{ account_id, email }]
  let recipients: { account_id: string | null; email: string }[] = [];
  if (selfTest) {
    if (!callerEmail) return json({ error: 'no_self_email', detail: 'Your account has no email to test to.' }, 400);
    recipients = [{ account_id: callerId || null, email: callerEmail }];
  } else if (to) {
    recipients = [{ account_id: null, email: to }];
  } else if (roles.length > 0) {
    const { data, error } = await admin.rpc('broadcast_recipients_email', { p_roles: roles });
    if (error) return json({ error: 'audience_failed', detail: error.message }, 500);
    recipients = (data ?? [])
      .map((r: { account_id: string; email: string | null }) => ({ account_id: r.account_id, email: r.email ?? '' }))
      .filter((r: { email: string }) => !!r.email);
  } else if (since) {
    const { data, error } = await admin.rpc('outreach_recent_emails', { p_since: since });
    if (error) return json({ error: 'audience_failed', detail: error.message }, 500);
    recipients = (data ?? [])
      .map((r: { account_id: string; email: string | null }) => ({ account_id: r.account_id, email: r.email ?? '' }))
      .filter((r: { email: string }) => !!r.email);
  } else {
    return json({ error: 'need_to_since_or_roles' }, 400);
  }

  if (dryRun) return json({ ok: true, dryRun: true, audience: recipients.length });

  const htmlBody = linkify(escapeHtml(body)).replace(/\n/g, '<br>');
  const runStamp = Date.now();
  let sent = 0, failed = 0;
  const errors: string[] = [];

  for (const r of recipients) {
    let unsub = functionsBase;
    if (r.account_id) { try { unsub = await unsubscribeUrl(functionsBase, r.account_id, unsubSecret); } catch { /* fallback */ } }
    const html =
      `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#201c19;line-height:1.5">` +
      `<p>${htmlBody}</p>` +
      (r.account_id ? `<p style="color:#8a817b;font-size:12px;margin-top:24px">If you'd rather not receive these, <a href="${unsub}" style="color:#8a817b">unsubscribe</a>.</p>` : '') +
      `</div>`;
    const result = await sendEmail(
      { apiKey: resendKey, from: emailFrom, replyTo: emailReplyTo || undefined },
      {
        to: r.email, subject, html, text: body,
        idempotencyKey: `apology_email:${r.email}:${runStamp}`,
        headers: r.account_id ? { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
      },
    );
    if (result.ok) sent += 1;
    else { failed += 1; if (errors.length < 5) errors.push(`${r.email}: ${result.error}`); }
  }

  return json({ ok: true, audience: recipients.length, sent, failed, errors });
});
