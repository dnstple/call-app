/**
 * Marketing broadcast content (server-only). Kept SEPARATE from transactional
 * templates: this is opt-out-able promotional email and always carries an
 * unsubscribe link. The broadcast HTML uses Resend Broadcast tokens
 * ({{{FIRST_NAME|there}}}, {{{RESEND_UNSUBSCRIBE_URL}}}); the preview variant
 * substitutes them so an admin can send a test to themselves.
 */

export const MARKETING_CAMPAIGN_NAME = 'Invite a coordinator or member';

/** Broadcast HTML (Resend substitutes the {{{...}}} tokens for the real audience). */
export const MARKETING_CAMPAIGN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Know someone who’d love Apricoti?</title>
</head>
<body style="margin:0;padding:0;background:#FBE9DE;color:#201C19;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">Know someone who’d love a friendly companion, or could help arrange calls? Invite them to Apricoti.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBE9DE;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#FCFAF7;border-radius:16px;overflow:hidden;">
<tr><td style="background:#F2A272;padding:22px 28px;">
<span style="font-size:22px;font-weight:700;color:#FCFAF7;letter-spacing:0.3px;">Apricoti</span>
</td></tr>
<tr><td style="padding:30px 28px 8px;">
<h1 style="margin:0 0 12px;font-size:24px;line-height:1.25;color:#201C19;">Hi {{{FIRST_NAME|there}}}, know someone who’d love this?</h1>
<p style="margin:0 0 16px;font-size:16px;line-height:1.6;">
Apricoti is friendly companion calls for people who’d enjoy a warm, regular chat. If someone you know
would love that — a parent, a friend, a neighbour — you can bring them in two ways:
</p>
</td></tr>
<tr><td style="padding:0 28px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBE9DE;border-radius:12px;">
<tr><td style="padding:18px 20px;font-size:15px;line-height:1.6;">
<p style="margin:0 0 10px;"><strong>As a member</strong> — someone who’d enjoy the conversations themselves.</p>
<p style="margin:0;"><strong>As a coordinator</strong> — someone who’d help arrange and manage the calls for a loved one who isn’t online.</p>
</td></tr>
</table>
</td></tr>
<tr><td align="center" style="padding:26px 28px 6px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:10px;background:#F2A272;">
<a href="https://www.apricoti.co.uk/" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:600;color:#FCFAF7;text-decoration:none;border-radius:10px;">Invite someone to Apricoti</a>
</td></tr></table>
</td></tr>
<tr><td style="padding:8px 28px 26px;">
<p style="margin:0;font-size:14px;line-height:1.6;color:#6b625c;">
Just share this link with them: <a href="https://www.apricoti.co.uk/" style="color:#201C19;">www.apricoti.co.uk</a>. It only takes a couple of minutes to get started, and you’ll be helping someone feel a little more connected.
</p>
</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #FBE9DE;font-size:12px;line-height:1.6;color:#6b625c;">
You’re receiving this because you have an Apricoti account.<br>
Apricoti · United Kingdom · <a href="mailto:info@apricoti.co.uk" style="color:#6b625c;">info@apricoti.co.uk</a><br>
<a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#6b625c;text-decoration:underline;">Unsubscribe from these emails</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

/** Preview for the admin test send: substitute broadcast tokens with safe values. */
export function marketingPreviewHtml(appUrl: string): string {
  return MARKETING_CAMPAIGN_HTML
    .replace(/\{\{\{FIRST_NAME\|there\}\}\}/g, 'there')
    .replace(/\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/g, `${appUrl.replace(/\/+$/, '')}/unsubscribe`);
}

export function marketingPreviewText(appUrl: string): string {
  const base = appUrl.replace(/\/+$/, '');
  return [
    'Hi there, know someone who’d love Apricoti?',
    '',
    'Apricoti is friendly companion calls. You can invite someone as a member (who’d enjoy the',
    'conversations themselves) or as a coordinator (who’d help arrange calls for a loved one).',
    '',
    `Invite someone: ${base}/`,
    '',
    'You’re receiving this because you have an Apricoti account.',
    `Unsubscribe: ${base}/unsubscribe`,
  ].join('\n');
}
