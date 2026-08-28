/**
 * "Verify your mobile number" reminder email. Sent manually by an admin to
 * accounts that haven't verified a UK mobile yet. The CTA deep-links to the
 * in-app verification screen (hash route). Pure render (HTML + text); all values
 * escaped; one-click unsubscribe included.
 */
import { BRAND } from './types.ts';
import { escapeHtml, plainText } from './escape.ts';

export const VERIFY_PHONE_SUBJECT = 'Please verify your mobile number on Apricoti';

export interface VerifyPhoneData {
  firstName: string;
  appUrl: string;
  supportEmail: string;
  unsubscribeUrl: string;
  /** Optional subject override from the admin panel. */
  subject?: string;
}

export function renderVerifyPhone(d: VerifyPhoneData): { subject: string; html: string; text: string } {
  const name = escapeHtml(d.firstName && d.firstName.trim() ? d.firstName.trim() : 'there');
  const app = d.appUrl.replace(/\/+$/, '');
  const verifyUrl = `${app}/#/verify-phone`;
  const appEsc = escapeHtml(app);
  const verifyEsc = escapeHtml(verifyUrl);
  const support = escapeHtml(d.supportEmail);
  const unsub = escapeHtml(d.unsubscribeUrl);
  const subject = (d.subject && d.subject.trim()) ? d.subject.trim() : VERIFY_PHONE_SUBJECT;

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.paleApricot};color:${BRAND.darkInk};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">A quick step to keep your account secure — verify your mobile number.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.paleApricot};">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:${BRAND.warmIvory};border-radius:16px;overflow:hidden;">
<tr><td style="background:${BRAND.apricot};padding:20px 28px;">
<span style="font-size:20px;font-weight:700;color:${BRAND.warmIvory};">Apricoti</span>
</td></tr>
<tr><td style="padding:28px;font-size:16px;line-height:1.6;color:${BRAND.darkInk};">
<p style="margin:0 0 14px;">Hi ${name},</p>
<p style="margin:0 0 14px;">We're asking everyone on Apricoti to confirm their UK mobile number. It takes less than a minute and it helps keep your account secure and lets us send you essential alerts about your calls.</p>
<p style="margin:0 0 14px;">Please tap the button below, enter your mobile number, and pop in the code we text you.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="border-radius:10px;background:${BRAND.apricot};">
<a href="${verifyEsc}" style="display:inline-block;padding:13px 24px;font-size:16px;font-weight:600;color:${BRAND.warmIvory};text-decoration:none;border-radius:10px;">Verify my mobile number</a>
</td></tr></table>
<p style="margin:0 0 14px;">If the button doesn't work, copy and paste this link into your browser:<br>
<a href="${verifyEsc}" style="color:${BRAND.apricot};">${verifyEsc}</a></p>
<p style="margin:0 0 14px;">Already verified? Then you're all set — thank you, and you can ignore this email.</p>
<p style="margin:0 0 14px;">Any questions, just reply to this email or reach us at <a href="mailto:${support}" style="color:${BRAND.apricot};">${support}</a>.</p>
<p style="margin:0;">Warm wishes,<br>Daniel — Apricoti</p>
</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid ${BRAND.paleApricot};font-size:12px;line-height:1.5;color:#6b625c;">
You're receiving this because you have an Apricoti account (<a href="${appEsc}" style="color:#6b625c;text-decoration:underline;">${appEsc}</a>). If you'd rather not get these reminders, <a href="${unsub}" style="color:#6b625c;text-decoration:underline;">unsubscribe here</a>.
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = plainText([
    `Hi ${d.firstName && d.firstName.trim() ? d.firstName.trim() : 'there'},`,
    '',
    "We're asking everyone on Apricoti to confirm their UK mobile number. It takes less than a minute and it",
    'helps keep your account secure and lets us send you essential alerts about your calls.',
    '',
    'Please open the link below, enter your mobile number, and pop in the code we text you:',
    verifyUrl,
    '',
    "Already verified? Then you're all set — thank you, and you can ignore this email.",
    '',
    `Any questions, just reply to this email or reach us at ${d.supportEmail}.`,
    '',
    'Warm wishes,',
    'Daniel — Apricoti',
    '',
    `If you'd rather not get these reminders, unsubscribe here: ${d.unsubscribeUrl}`,
  ].join('\n'));

  return { subject, html, text };
}
