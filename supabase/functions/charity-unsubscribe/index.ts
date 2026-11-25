/**
 * charity-unsubscribe — public, no-login opt-out for charity outreach emails.
 * Link: ?o=<charity_outreach id>&t=HMAC(secret, "<id>:charity"). Suppresses the
 * charity's email address and closes the thread. GET (click) and POST (one-click).
 *
 * Deploy: supabase functions deploy charity-unsubscribe --no-verify-jwt
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyUnsubscribe } from '../_shared/email/unsubscribe.ts';

const page = (body: string, status = 200) => new Response(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Apricoti</title></head>
<body style="margin:0;background:#FBE9DE;color:#201C19;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="max-width:480px;margin:40px auto;background:#FCFAF7;border-radius:16px;padding:28px;">
<div style="font-size:20px;font-weight:700;color:#C8643D;margin-bottom:12px;">Apricoti</div>
<p style="font-size:16px;line-height:1.6;">${body}</p></div></body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const id = url.searchParams.get('o') ?? '';
  const token = url.searchParams.get('t') ?? '';
  const secret = Deno.env.get('EMAIL_UNSUBSCRIBE_SECRET') ?? Deno.env.get('BILLING_CRON_SECRET') ?? '';
  const fallback = 'Please email info@apricoti.co.uk with “unsubscribe” and we’ll remove you straight away.';
  if (!secret || !(await verifyUnsubscribe(id, 'charity', token, secret))) {
    return page(`This unsubscribe link couldn’t be verified. ${fallback}`, 400);
  }
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: row } = await admin.from('charity_outreach').select('id, charity:charities(contact_email)').eq('id', id).maybeSingle();
  const email = (row as { charity?: { contact_email?: string } } | null)?.charity?.contact_email;
  if (!email) return page(`We couldn’t find that address. ${fallback}`, 404);

  const at = new Date().toISOString();
  const a = await admin.from('charity_suppressions').upsert({ value: email.toLowerCase(), kind: 'email', reason: 'unsubscribed', source: `link:${id}` }, { onConflict: 'value' });
  const b = await admin.from('charity_outreach').update({ status: 'unsubscribed', closed_at: at, updated_at: at }).eq('id', id);
  if (a.error || b.error) return page(`We couldn’t update our records just now. ${fallback}`, 500);
  return page('You’ve been unsubscribed. Apricoti won’t email this address again. Thank you, and sorry for the interruption.');
});
