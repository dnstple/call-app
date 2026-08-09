/**
 * marketing-broadcast — admin-only marketing automation via the Resend API.
 * SEPARATE from transactional email. Actions (JSON body { action }):
 *   • sync : upsert active users into the Resend marketing Audience (never
 *            resurrects an unsubscribed contact — create-only, skip on conflict).
 *   • test : send the campaign to EMAIL_TEST_RECIPIENT only (preview tokens).
 *   • send : create a Broadcast and send it to the whole audience — requires
 *            body.confirm === 'SEND'. Resend injects the unsubscribe link.
 *
 * Requires an authenticated support admin. Never accepts arbitrary recipients or
 * HTML — content is the fixed server-side campaign; the audience is Resend-managed.
 *   supabase functions deploy marketing-broadcast
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { validateEmailConfig, EmailConfigError } from '../_shared/email/config.ts';
import { sendViaResend } from '../_shared/email/resend.ts';
import {
  MARKETING_CAMPAIGN_HTML, MARKETING_CAMPAIGN_NAME,
  marketingPreviewHtml, marketingPreviewText,
} from '../_shared/email/marketing.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const DEFAULT_SUBJECT = 'Know someone who’d love Apricoti?';

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
    });
  } catch (e) {
    if (e instanceof EmailConfigError) return json({ error: 'email_not_configured', detail: e.message }, 503);
    throw e;
  }
  const audienceId = Deno.env.get('RESEND_MARKETING_AUDIENCE_ID') ?? '';

  // Authenticate + admin gate.
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorised' }, 401);
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: 'unauthorised' }, 401);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
  const { data: adminRow } = await admin.from('support_admins')
    .select('account_id').eq('account_id', userData.user.id).maybeSingle();
  if (!adminRow) return json({ error: 'forbidden' }, 403);

  let body: { action?: string; subject?: string; confirm?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const subject = (body.subject && body.subject.trim()) ? body.subject.trim() : DEFAULT_SUBJECT;

  const rHeaders = { 'Authorization': `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' };

  // ---- sync: push active users into the Resend audience ----
  if (body.action === 'sync') {
    if (!audienceId) return json({ error: 'audience_not_configured', detail: 'Set RESEND_MARKETING_AUDIENCE_ID.' }, 503);
    const { data: accounts } = await admin.from('accounts').select('id, display_name, status');
    const active = new Map((accounts ?? [])
      .filter((a: { status: string }) => a.status === 'active')
      .map((a: { id: string; display_name: string | null }) => [a.id, a.display_name]));

    let added = 0, skipped = 0, scanned = 0;
    for (let page = 1; page < 1000; page += 1) {
      const { data: list, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error || !list?.users?.length) break;
      for (const u of list.users) {
        scanned += 1;
        if (!u.email || !active.has(u.id)) { skipped += 1; continue; }
        const firstName = String(active.get(u.id) ?? '').trim().split(/\s+/)[0] || undefined;
        const res = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
          method: 'POST', headers: rHeaders,
          body: JSON.stringify({ email: u.email, first_name: firstName, unsubscribed: false }),
        });
        if (res.ok) added += 1; else skipped += 1;   // conflict/unsubscribed ⇒ skip, never resurrect
      }
      if (list.users.length < 1000) break;
    }
    return json({ ok: true, action: 'sync', added, skipped, scanned });
  }

  // ---- test: send only to EMAIL_TEST_RECIPIENT ----
  if (body.action === 'test') {
    const result = await sendViaResend(config, {
      to: config.testRecipient,
      rendered: { subject, html: marketingPreviewHtml(config.appUrl), text: marketingPreviewText(config.appUrl) },
      idempotencyKey: `marketing_test/${crypto.randomUUID()}`,
    });
    return result.ok
      ? json({ ok: true, action: 'test', recipient: config.testRecipient, message_id: result.messageId })
      : json({ ok: false, error: 'send_failed', code: result.errorCode }, 502);
  }

  // ---- send: create + send the broadcast to the whole audience (guarded) ----
  if (body.action === 'send') {
    if (body.confirm !== 'SEND') return json({ error: 'confirmation_required', detail: 'Pass confirm:"SEND".' }, 400);
    if (!audienceId) return json({ error: 'audience_not_configured', detail: 'Set RESEND_MARKETING_AUDIENCE_ID.' }, 503);

    const create = await fetch('https://api.resend.com/broadcasts', {
      method: 'POST', headers: rHeaders,
      body: JSON.stringify({
        audience_id: audienceId, from: config.emailFrom, reply_to: config.emailReplyTo,
        subject, html: MARKETING_CAMPAIGN_HTML, name: `${MARKETING_CAMPAIGN_NAME} — ${new Date().toISOString()}`,
      }),
    });
    if (!create.ok) {
      const detail = await create.text().catch(() => '');
      return json({ ok: false, error: 'broadcast_create_failed', status: create.status, detail: detail.slice(0, 300) }, 502);
    }
    const created = await create.json();
    const broadcastId = created?.id;

    const send = await fetch(`https://api.resend.com/broadcasts/${broadcastId}/send`, {
      method: 'POST', headers: rHeaders, body: JSON.stringify({}),
    });
    if (!send.ok) {
      const detail = await send.text().catch(() => '');
      return json({ ok: false, error: 'broadcast_send_failed', broadcast_id: broadcastId, detail: detail.slice(0, 300) }, 502);
    }
    return json({ ok: true, action: 'send', broadcast_id: broadcastId });
  }

  return json({ error: 'unknown_action', detail: "Use action: 'sync' | 'test' | 'send'." }, 400);
});
