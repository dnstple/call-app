/**
 * email-unsubscribe — public, no-login opt-out endpoint for lifecycle emails.
 *
 * The unsubscribe link in an email carries ?a=<account>&c=<category>&t=<token>,
 * where token = HMAC-SHA256(secret, "account:category"). We verify the token
 * (so the link can't be forged or enumerated), record the suppression, and show
 * a friendly confirmation page. Supports GET (person clicks the link) and POST
 * (RFC 8058 one-click List-Unsubscribe-Post).
 *
 *   supabase functions deploy email-unsubscribe --no-verify-jwt
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyUnsubscribe } from '../_shared/email/unsubscribe.ts';

const HTML = (title: string, body: string) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;background:#FBE9DE;color:#201C19;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="max-width:480px;margin:40px auto;background:#FCFAF7;border-radius:16px;padding:28px;">
<div style="font-size:20px;font-weight:700;color:#C8643D;margin-bottom:12px;">Apricoti</div>
<p style="font-size:16px;line-height:1.6;">${body}</p>
</div></body></html>`;

function page(title: string, body: string, status = 200): Response {
  return new Response(HTML(title, body), { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const accountId = url.searchParams.get('a') ?? '';
  const category = url.searchParams.get('c') ?? 'onboarding';
  const token = url.searchParams.get('t') ?? '';

  const secret = Deno.env.get('EMAIL_UNSUBSCRIBE_SECRET') ?? Deno.env.get('BILLING_CRON_SECRET') ?? '';
  if (!secret) return page('Unsubscribe', 'This unsubscribe link can’t be processed right now. Please email info@apricoti.co.uk and we’ll remove you.', 503);

  const ok = await verifyUnsubscribe(accountId, category, token, secret);
  if (!ok) {
    return page('Unsubscribe', 'This unsubscribe link is invalid or has expired. If you’d like to stop these emails, please email info@apricoti.co.uk.', 400);
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  let error: unknown = null;
  if (category === 'auth_confirmation') {
    // Never-confirmed users have no accounts row — suppress by auth user id.
    const res = await admin.from('auth_confirmation_reminders')
      .upsert({ user_id: accountId, unsubscribed: true, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    error = res.error;
  } else {
    const res = await admin.rpc('suppress_onboarding_emails', { p_account: accountId, p_source: 'email_unsubscribe' });
    error = res.error;
  }
  if (error) {
    return page('Unsubscribe', 'We couldn’t update your preferences just now. Please email info@apricoti.co.uk and we’ll remove you.', 500);
  }

  return page('Unsubscribed', 'You’ve been unsubscribed from Apricoti account-setup reminders. You won’t receive any more of these emails. If this was a mistake, just email info@apricoti.co.uk.');
});
