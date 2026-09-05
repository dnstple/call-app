/**
 * outreach-run — ONE consolidated outreach sender for all five Reach-out
 * campaigns. Copy is read from public.outreach_templates, the audience from
 * public.outreach_audience(), and every send is recorded in the run + message
 * ledger (public.outreach_campaign_runs / public.outreach_messages).
 *
 * Channels per recipient: email (Resend) + SMS (Twilio) + in-app. Re-running
 * sends to the WHOLE current audience each time (opt-outs excluded in the
 * audience query); the run id makes each click a fresh, idempotent batch.
 *
 * Auth: support-admin Bearer token OR the internal cron secret (x-billing-secret).
 *
 * Body: { campaign: string, mode?: 'send' | 'preview', note?: string }
 *
 * SELF-CONTAINED (no ../_shared imports) so it deploys from the dashboard editor.
 *   Env: RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO, APP_URL,
 *        TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER (or
 *        TWILIO_MESSAGING_SERVICE_SID), BILLING_CRON_SECRET, EMAIL_UNSUBSCRIBE_SECRET.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info, x-billing-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

interface Recipient {
  account_id: string;
  first_name: string | null;
  email: string | null;
  phone_e164: string | null;
  phone_verified: boolean | null;
  sms_opt_out: boolean | null;
  profile_id: string | null;
}

type SmsRule = 'verified' | 'any' | 'none';
interface Policy { email: boolean; sms: SmsRule; in_app: boolean; link: string | 'referral'; }

const CAMPAIGNS: Record<string, Policy> = {
  member_first_call:            { email: true, sms: 'verified', in_app: true, link: '/#/explore' },
  member_incomplete:            { email: true, sms: 'verified', in_app: true, link: '/#/signup' },
  companion_verify_phone:       { email: true, sms: 'any',      in_app: true, link: '/#/verify-phone' },
  companion_incomplete_profile: { email: true, sms: 'verified', in_app: true, link: '/#/profile' },
  companion_invite_link:        { email: true, sms: 'verified', in_app: true, link: 'referral' },
};

// ---- inlined: signed one-click unsubscribe (HMAC-SHA256(secret, "acct:category")) ----
const encoder = new TextEncoder();
function toHex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf); let out = '';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}
async function buildUnsubscribeUrl(functionsBaseUrl: string, accountId: string, category: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${accountId}:${category}`));
  const params = new URLSearchParams({ a: accountId, c: category, t: toHex(sig) });
  return `${functionsBaseUrl.replace(/\/+$/, '')}/email-unsubscribe?${params.toString()}`;
}

// ---- inlined: Resend send (returns provider message id) ----
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
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (body as { message?: string })?.message ?? String(res.status) };
    return { ok: true, id: (body as { id?: string })?.id };
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
  form.set('To', to); form.set('Body', body);
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

function fill(tpl: string, vars: Record<string, string>): string {
  return (tpl ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? '');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const resendKey = Deno.env.get('RESEND_API_KEY') ?? '';
  const emailFrom = Deno.env.get('EMAIL_FROM') ?? '';
  const emailReplyTo = Deno.env.get('EMAIL_REPLY_TO') ?? '';
  const appUrl = (Deno.env.get('APP_URL') ?? '').replace(/\/+$/, '');
  if (!appUrl) return json({ error: 'not_configured', detail: 'APP_URL is required.' }, 503);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // ---- auth: cron secret OR support-admin bearer (capture admin id) ----
  const cronSecret = Deno.env.get('BILLING_CRON_SECRET') ?? '';
  const isInternal = cronSecret.length > 0 && (req.headers.get('x-billing-secret') ?? '') === cronSecret;
  let triggeredBy: string | null = null;
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
    triggeredBy = userData.user.id;
  }

  let campaign = ''; let mode = 'send';
  try {
    const body = await req.json();
    campaign = String(body?.campaign ?? '');
    if (body?.mode === 'preview') mode = 'preview';
  } catch { /* no body */ }

  const policy = CAMPAIGNS[campaign];
  if (!policy) return json({ error: 'unknown_campaign' }, 400);

  const { data: tplRows, error: tplErr } = await admin.from('outreach_templates')
    .select('*').eq('campaign_key', campaign).maybeSingle();
  if (tplErr || !tplRows) return json({ error: 'template_missing', detail: tplErr?.message }, 500);
  const tpl = tplRows as Record<string, string>;

  const { data: audRows, error: audErr } = await admin.rpc('outreach_audience', { p_campaign: campaign });
  if (audErr) return json({ error: 'audience_failed', detail: audErr.message }, 500);
  const audience = (audRows ?? []) as Recipient[];

  const canSms = (r: Recipient): boolean => {
    if (policy.sms === 'none') return false;
    if (!r.phone_e164 || r.sms_opt_out) return false;
    if (policy.sms === 'verified') return !!r.phone_verified;
    return true; // 'any'
  };

  if (mode === 'preview') {
    return json({
      ok: true, mode: 'preview', campaign,
      audience: audience.length,
      would_email: audience.filter((r) => policy.email && r.email).length,
      would_sms: audience.filter((r) => canSms(r)).length,
    });
  }

  // ---- start the run ----
  const { data: runId, error: runErr } = await admin.rpc('outreach_start_run', {
    p_campaign: campaign, p_triggered_by: triggeredBy, p_mode: 'send',
  });
  if (runErr || !runId) return json({ error: 'run_start_failed', detail: runErr?.message }, 500);
  const run = String(runId);

  const emailConfigured = !!(resendKey && emailFrom);
  const functionsBase = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '') + '/functions/v1';
  const unsubSecret = Deno.env.get('EMAIL_UNSUBSCRIBE_SECRET') ?? cronSecret;

  let inApp = 0, emails = 0, emailsFailed = 0, texts = 0, textsFailed = 0;

  for (const r of audience) {
    // Personal link for the invite campaign; static deep-link otherwise.
    let link = policy.link === 'referral' ? appUrl : appUrl + policy.link;
    if (policy.link === 'referral') {
      try {
        const { data: code } = await admin.rpc('outreach_ensure_referral_code', { p_account: r.account_id });
        link = code ? `${appUrl}/join?ref=${encodeURIComponent(String(code))}` : `${appUrl}/join`;
      } catch { link = `${appUrl}/join`; }
    }

    let unsubscribeUrl = appUrl;
    try { unsubscribeUrl = await buildUnsubscribeUrl(functionsBase, r.account_id, 'outreach', unsubSecret); } catch { /* fallback */ }

    const vars = {
      first_name: (r.first_name ?? '').trim() || 'there',
      link,
      unsubscribe: unsubscribeUrl,
    };

    // 1. In-app.
    if (policy.in_app) {
      try {
        await admin.rpc('outreach_inapp', {
          p_run: run, p_account: r.account_id, p_campaign: campaign,
          p_title: fill(tpl.in_app_title, vars), p_body: fill(tpl.in_app_body, vars),
        });
        inApp += 1;
      } catch { /* best-effort */ }
    }

    // 2. Email.
    if (policy.email && r.email && emailConfigured) {
      const result = await sendEmail(
        { apiKey: resendKey, from: emailFrom, replyTo: emailReplyTo || undefined },
        {
          to: r.email,
          subject: fill(tpl.subject, vars),
          html: fill(tpl.email_html, vars),
          text: fill(tpl.email_text, vars),
          idempotencyKey: `outreach:${campaign}:${run}:${r.account_id}`,
          headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        },
      );
      if (result.ok) emails += 1; else emailsFailed += 1;
      await admin.rpc('outreach_record_message', {
        p_run: run, p_campaign: campaign, p_channel: 'email', p_account: r.account_id,
        p_address: r.email, p_status: result.ok ? 'sent' : 'failed',
        p_provider: 'resend', p_provider_message_id: result.id ?? null, p_error: result.error ?? null,
      });
    }

    // 3. SMS.
    if (canSms(r)) {
      const sms = await sendSms(r.phone_e164!, fill(tpl.sms_body, vars));
      if (sms.ok) texts += 1; else textsFailed += 1;
      await admin.rpc('outreach_record_message', {
        p_run: run, p_campaign: campaign, p_channel: 'sms', p_account: r.account_id,
        p_address: r.phone_e164, p_status: sms.ok ? 'sent' : 'failed',
        p_provider: 'twilio', p_provider_message_id: sms.sid ?? null, p_error: sms.error ?? null,
      });
    }
  }

  await admin.rpc('outreach_finish_run', {
    p_run: run, p_audience: audience.length, p_in_app: inApp,
    p_emails_sent: emails, p_emails_failed: emailsFailed,
    p_texts_sent: texts, p_texts_failed: textsFailed, p_status: 'completed',
  });

  return json({
    ok: true, run_id: run, campaign, audience: audience.length,
    in_app: inApp, emails, emails_failed: emailsFailed, texts, texts_failed: textsFailed,
    email_configured: emailConfigured,
  });
});
