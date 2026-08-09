/**
 * "Complete your Companion profile" nudge — an OPERATIONAL/account email (not
 * marketing), sent to approved Companions whose profile isn't publishable yet.
 * Pure, dependency-free render (HTML + text) in Apricoti's identity. All dynamic
 * values are escaped; the CTA uses the configured APP_URL.
 */
import { BRAND } from './types.ts';
import { escapeHtml, plainText } from './escape.ts';

export const COMPANION_NUDGE_SUBJECT = 'Please complete your Apricoti Companion profile';

export interface CompanionNudgeData {
  firstName: string;
  appUrl: string;
  supportEmail: string;
}

export function renderCompanionNudge(d: CompanionNudgeData): { subject: string; html: string; text: string } {
  const name = escapeHtml(d.firstName && d.firstName.trim() ? d.firstName.trim() : 'there');
  const app = escapeHtml(d.appUrl.replace(/\/+$/, ''));
  const support = escapeHtml(d.supportEmail);
  const subject = COMPANION_NUDGE_SUBJECT;

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.paleApricot};color:${BRAND.darkInk};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">A few steps left to get your Companion profile live.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.paleApricot};">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:${BRAND.warmIvory};border-radius:16px;overflow:hidden;">
<tr><td style="background:${BRAND.apricot};padding:20px 28px;">
<span style="font-size:20px;font-weight:700;color:${BRAND.warmIvory};">Apricoti</span>
</td></tr>
<tr><td style="padding:28px;font-size:16px;line-height:1.6;color:${BRAND.darkInk};">
<p style="margin:0 0 14px;">Hi ${name},</p>
<p style="margin:0 0 14px;">Thanks for joining Apricoti as a Companion! To get your profile live, please log back in to accept the Companion Consent Agreement, finish any remaining profile sections, and upload a clear, recent head-and-shoulders photo that shows your face.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="border-radius:10px;background:${BRAND.apricot};">
<a href="${app}" style="display:inline-block;padding:13px 24px;font-size:16px;font-weight:600;color:${BRAND.warmIvory};text-decoration:none;border-radius:10px;">Complete my profile</a>
</td></tr></table>
<p style="margin:0 0 14px;">Once that's done, members can start booking calls with you. Any questions or problems, just reply to this email or contact us at <a href="mailto:${support}" style="color:${BRAND.apricot};">${support}</a>.</p>
<p style="margin:0;">Kind regards,<br>Daniel — Apricoti</p>
</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid ${BRAND.paleApricot};font-size:12px;line-height:1.5;color:#6b625c;">
This is a service message about your Apricoti Companion account.
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = plainText([
    `Hi ${d.firstName && d.firstName.trim() ? d.firstName.trim() : 'there'},`,
    '',
    "Thanks for joining Apricoti as a Companion! To get your profile live, please log back in to accept the",
    'Companion Consent Agreement, finish any remaining profile sections, and upload a clear, recent',
    'head-and-shoulders photo that shows your face.',
    '',
    `Complete my profile: ${d.appUrl.replace(/\/+$/, '')}`,
    '',
    `Once that's done, members can start booking calls with you. Any questions or problems, just reply to`,
    `this email or contact us at ${d.supportEmail}.`,
    '',
    'Kind regards,',
    'Daniel — Apricoti',
  ].join('\n'));

  return { subject, html, text };
}
