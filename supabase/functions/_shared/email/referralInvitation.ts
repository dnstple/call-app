/**
 * Referral invitation email — template key `coordinator_member_referral_invitation`, v1.
 *
 * Promotional / referral email (NOT transactional). Invites existing Companions
 * and approved referrers to introduce a new Coordinator or Member. Pure,
 * dependency-free module (runs under Deno and Vitest) that returns a rendered
 * { subject, preheader, html, text } from TYPED, VALIDATED variables. Sender /
 * reply-to are applied by the sending function from secure env config — never
 * hard-coded here.
 *
 * Security: required variables fail validation if missing; every URL must be
 * https and on an approved Apricoti domain (app links) or at least a safe https
 * URL (provider-hosted unsubscribe/preferences); all interpolated values are
 * HTML-escaped; optional values (programme_end_date) drop their sentence cleanly.
 */
import { escapeHtml, plainText } from './escape.ts';

export const REFERRAL_TEMPLATE_KEY = 'coordinator_member_referral_invitation';
export const REFERRAL_TEMPLATE_VERSION = 'v1';

export const REFERRAL_DEFAULT_SUBJECT = 'Earn up to £10 when you introduce a family to Apricoti';
export const REFERRAL_DEFAULT_PREHEADER =
  'Help a new Coordinator or Member discover Apricoti and receive rewards as they continue.';

const C = {
  apricot: '#F2A272',
  deepApricot: '#C8643D',
  soft: '#FBE9DE',
  ivory: '#FCFAF7',
  ink: '#201C19',
  white: '#FFFFFF',
  muted: '#6b625c',
};

export class ReferralTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReferralTemplateError';
  }
}

export interface ReferralInvitationVars {
  recipient_first_name: string;
  recipient_type: string;            // e.g. 'companion' | 'referrer'
  referral_url: string;
  referral_code: string;
  programme_terms_url: string;
  privacy_url: string;
  support_email: string;
  unsubscribe_url: string;
  app_url: string;
  legal_company_name: string;
  programme_limit: string | number;
  // Optional — omit cleanly when absent:
  referral_dashboard_url?: string;
  preferences_url?: string;
  registered_office_address?: string;
  programme_end_date?: string;
  subject?: string;
  preheader?: string;
}

const REQUIRED: (keyof ReferralInvitationVars)[] = [
  'recipient_first_name', 'recipient_type', 'referral_url', 'referral_code',
  'programme_terms_url', 'privacy_url', 'support_email', 'unsubscribe_url',
  'app_url', 'legal_company_name', 'programme_limit',
];

// App-owned links must be https AND on apricoti.co.uk (or a subdomain).
const APP_LINKS: (keyof ReferralInvitationVars)[] = [
  'referral_url', 'programme_terms_url', 'privacy_url', 'app_url', 'referral_dashboard_url',
];
// Provider-hosted links: https + safe scheme, any host.
const SAFE_LINKS: (keyof ReferralInvitationVars)[] = ['unsubscribe_url', 'preferences_url'];

function parseUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ReferralTemplateError(`Invalid URL: ${raw}`); }
  const scheme = u.protocol.toLowerCase();
  if (scheme === 'javascript:' || scheme === 'data:' || scheme === 'vbscript:') {
    throw new ReferralTemplateError(`Unsafe URL scheme: ${raw}`);
  }
  if (scheme !== 'https:') throw new ReferralTemplateError(`URL must use https: ${raw}`);
  return u;
}
function assertApprovedAppUrl(raw: string): void {
  const host = parseUrl(raw).hostname.toLowerCase();
  if (host !== 'apricoti.co.uk' && !host.endsWith('.apricoti.co.uk')) {
    throw new ReferralTemplateError(`URL is not on an approved Apricoti domain: ${raw}`);
  }
}
function assertSafeHttpsUrl(raw: string): void { parseUrl(raw); }

function assertEmail(raw: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) throw new ReferralTemplateError(`Invalid support email: ${raw}`);
}

function validate(vars: ReferralInvitationVars): void {
  for (const key of REQUIRED) {
    const v = vars[key];
    if (v === undefined || v === null || String(v).trim() === '') {
      throw new ReferralTemplateError(`Missing required variable: ${key}`);
    }
  }
  for (const key of APP_LINKS) {
    const v = vars[key];
    if (v) assertApprovedAppUrl(String(v));
  }
  for (const key of SAFE_LINKS) {
    const v = vars[key];
    if (v) assertSafeHttpsUrl(String(v));
  }
  assertEmail(vars.support_email);
}

/** Bulletproof, Outlook-safe CTA button (VML fallback for MSO). */
function ctaButton(label: string, url: string): string {
  const safeUrl = escapeHtml(url);
  const safeLabel = escapeHtml(label);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 4px;">
<tr><td align="center">
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeUrl}" style="height:48px;v-text-anchor:middle;width:280px;" arcsize="21%" strokecolor="${C.deepApricot}" fillcolor="${C.deepApricot}">
<w:anchorlock/><center style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;">${safeLabel}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-- -->
<a href="${safeUrl}" style="display:inline-block;min-height:44px;line-height:44px;padding:0 28px;background:${C.deepApricot};color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;text-decoration:none;border-radius:10px;">${safeLabel}</a>
<!--<![endif]-->
</td></tr></table>`;
}

function milestoneRow(steps: string, reward: string): string {
  return `<tr>
<td style="padding:10px 14px;font-family:Arial,Helvetica,sans-serif;font-size:16px;color:${C.ink};background:${C.soft};border-radius:8px;">
<strong>${escapeHtml(steps)}</strong>
</td>
<td width="24" style="font-size:0;line-height:0;">&nbsp;</td>
<td style="padding:10px 14px;font-family:Arial,Helvetica,sans-serif;font-size:16px;color:${C.deepApricot};font-weight:bold;background:${C.soft};border-radius:8px;white-space:nowrap;">
${escapeHtml(reward)}
</td>
</tr>`;
}

export interface RenderedReferral {
  subject: string;
  preheader: string;
  html: string;
  text: string;
}

export function renderReferralInvitation(vars: ReferralInvitationVars): RenderedReferral {
  validate(vars);

  const subject = (vars.subject && vars.subject.trim()) || REFERRAL_DEFAULT_SUBJECT;
  const preheader = (vars.preheader && vars.preheader.trim()) || REFERRAL_DEFAULT_PREHEADER;
  const name = escapeHtml(vars.recipient_first_name);
  const code = escapeHtml(vars.referral_code);
  const limit = escapeHtml(String(vars.programme_limit));
  const support = escapeHtml(vars.support_email);

  // Optional programme-end sentence — omitted cleanly when absent.
  const endSentence = (vars.programme_end_date && vars.programme_end_date.trim())
    ? ` The pilot is scheduled to run until ${escapeHtml(vars.programme_end_date.trim())}.`
    : '';

  const termsLink = `<a href="${escapeHtml(vars.programme_terms_url)}" style="color:${C.deepApricot};">Read the full programme terms</a>`;
  const dashOrReferral = vars.referral_dashboard_url || vars.referral_url;

  const html = `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(subject)}</title>
<!--[if mso]><style>table,td{font-family:Arial,Helvetica,sans-serif!important;}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:${C.ivory};color:${C.ink};">
<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.ivory};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${C.white};border-radius:16px;overflow:hidden;">

<tr><td style="padding:22px 28px;border-bottom:1px solid ${C.soft};">
<span style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;color:${C.deepApricot};letter-spacing:0.3px;">Apricoti</span>
</td></tr>

<tr><td style="padding:28px 28px 6px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:${C.ink};">
<p style="margin:0 0 14px;">Hi ${name},</p>
<p style="margin:0 0 14px;">You already understand how much a regular, friendly conversation can mean. We’re inviting a small number of people in the Apricoti community to help introduce new families to the platform.</p>
<p style="margin:0 0 8px;">You can introduce either:</p>
</td></tr>

<tr><td style="padding:0 28px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.soft};border-radius:12px;">
<tr><td style="padding:16px 18px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:${C.ink};">
<p style="margin:0 0 10px;"><strong>A Coordinator</strong> — a relative, friend or carer who would like to arrange regular calls for someone they care about.</p>
<p style="margin:0;"><strong>A Member</strong> — someone who would like to choose a Companion and arrange friendly calls for themselves.</p>
</td></tr>
</table>
</td></tr>

<tr><td style="padding:24px 28px 6px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:${C.ink};">
<p style="margin:0 0 10px;"><strong>How the reward works</strong></p>
<p style="margin:0 0 6px;">1. Share your personal Apricoti referral link.</p>
<p style="margin:0 0 6px;">2. The Coordinator or Member creates their own account and books a free 30-minute trial call.</p>
</td></tr>

<tr><td style="padding:6px 28px 4px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
${milestoneRow('4 paid calls', '£5 reward')}
<tr><td colspan="3" style="font-size:0;line-height:8px;">&nbsp;</td></tr>
${milestoneRow('8 paid calls', 'additional £5 reward')}
</table>
</td></tr>

<tr><td style="padding:14px 28px 4px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:${C.ink};">
<p style="margin:0;">You can earn up to <strong>£10</strong> for each qualifying household you introduce.</p>
</td></tr>

<tr><td style="padding:14px 28px 4px;">
${ctaButton('View and share my referral link', dashOrReferral)}
</td></tr>

<tr><td style="padding:8px 28px 4px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:${C.ink};">
<p style="margin:0 0 6px;">Your referral code:</p>
<p style="margin:0 0 6px;font-size:20px;font-weight:bold;letter-spacing:2px;color:${C.deepApricot};">${code}</p>
<p style="margin:0;font-size:14px;color:${C.muted};word-break:break-all;">Or share this link: <a href="${escapeHtml(vars.referral_url)}" style="color:${C.deepApricot};">${escapeHtml(vars.referral_url)}</a></p>
</td></tr>

<tr><td style="padding:16px 28px 4px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:${C.ink};">
<p style="margin:0 0 12px;">Please share your referral link rather than sending us someone’s personal details. The person joining Apricoti must choose to register and provide their own information or give the appropriate consent.</p>
<p style="margin:0 0 12px;">The programme is currently limited to the first ${limit} qualifying households.${endSentence} Trial, cancelled, refunded or disputed calls do not count towards the reward milestones. Existing users and self-referrals are not eligible.</p>
<p style="margin:0 0 12px;">If you work professionally as a carer or support worker, please make sure participation is permitted by your employer and professional policies.</p>
<p style="margin:0 0 12px;">${termsLink}</p>
<p style="margin:0 0 4px;">Thank you for helping more people discover regular companionship.</p>
<p style="margin:0 0 12px;">The Apricoti team</p>
<p style="margin:0;font-size:14px;color:${C.muted};">Questions? Contact <a href="mailto:${support}" style="color:${C.deepApricot};">${support}</a>.</p>
</td></tr>

<tr><td style="padding:20px 28px;border-top:1px solid ${C.soft};font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:${C.muted};">
You are receiving this email because you registered with Apricoti and agreed to receive community and programme updates. Essential account and booking notifications are managed separately.<br><br>
${escapeHtml(vars.legal_company_name)}${vars.registered_office_address ? ' · ' + escapeHtml(vars.registered_office_address) : ''}<br>
<a href="${escapeHtml(vars.privacy_url)}" style="color:${C.muted};">Privacy policy</a> ·
<a href="${escapeHtml(vars.programme_terms_url)}" style="color:${C.muted};">Programme terms</a>${vars.preferences_url ? ' · <a href="' + escapeHtml(vars.preferences_url) + '" style="color:' + C.muted + ';">Email preferences</a>' : ''} ·
<a href="${escapeHtml(vars.unsubscribe_url)}" style="color:${C.muted};text-decoration:underline;">Unsubscribe</a>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  const text = plainText([
    `Hi ${vars.recipient_first_name},`,
    '',
    'You already understand how much a regular, friendly conversation can mean. We’re inviting a small',
    'number of people in the Apricoti community to help introduce new families to the platform.',
    '',
    'You can introduce either:',
    '- A Coordinator: a relative, friend or carer who would like to arrange regular calls for someone they care about.',
    '- A Member: someone who would like to choose a Companion and arrange friendly calls for themselves.',
    '',
    'How the reward works',
    '1. Share your personal Apricoti referral link.',
    '2. The Coordinator or Member creates their own account and books a free 30-minute trial call.',
    '3. You receive £5 after their household completes four paid calls.',
    '4. You receive another £5 after they complete eight paid calls.',
    '',
    '  4 paid calls  -> £5 reward',
    '  8 paid calls  -> additional £5 reward',
    '',
    'You can earn up to £10 for each qualifying household you introduce.',
    '',
    `View and share my referral link: ${dashOrReferral}`,
    `Your referral code: ${vars.referral_code}`,
    `Referral link: ${vars.referral_url}`,
    '',
    'Please share your referral link rather than sending us someone’s personal details. The person joining',
    'Apricoti must choose to register and provide their own information or give the appropriate consent.',
    '',
    `The programme is currently limited to the first ${vars.programme_limit} qualifying households.` +
      (vars.programme_end_date && vars.programme_end_date.trim() ? ` The pilot is scheduled to run until ${vars.programme_end_date.trim()}.` : ''),
    'Trial, cancelled, refunded or disputed calls do not count towards the reward milestones.',
    'Existing users and self-referrals are not eligible.',
    '',
    'If you work professionally as a carer or support worker, please make sure participation is permitted',
    'by your employer and professional policies.',
    '',
    `Read the full programme terms: ${vars.programme_terms_url}`,
    '',
    'Thank you for helping more people discover regular companionship.',
    'The Apricoti team',
    `Questions? Contact ${vars.support_email}.`,
    '',
    '—',
    'You are receiving this email because you registered with Apricoti and agreed to receive community and',
    'programme updates. Essential account and booking notifications are managed separately.',
    `${vars.legal_company_name}${vars.registered_office_address ? ' · ' + vars.registered_office_address : ''}`,
    `Privacy: ${vars.privacy_url}`,
    `Programme terms: ${vars.programme_terms_url}`,
    vars.preferences_url ? `Email preferences: ${vars.preferences_url}` : '',
    `Unsubscribe: ${vars.unsubscribe_url}`,
  ].filter((l) => l !== '' || true).join('\n'));

  return { subject, preheader, html, text };
}

/** Realistic admin/preview fixture (safe test data — never sent automatically). */
export const REFERRAL_PREVIEW_FIXTURE: ReferralInvitationVars = {
  recipient_first_name: 'Grace',
  recipient_type: 'companion',
  referral_code: 'GRACE24',
  referral_url: 'https://apricoti.co.uk/join?ref=GRACE24',
  referral_dashboard_url: 'https://apricoti.co.uk/referrals',
  programme_terms_url: 'https://apricoti.co.uk/referral-terms',
  privacy_url: 'https://apricoti.co.uk/privacy',
  support_email: 'info@apricoti.co.uk',
  unsubscribe_url: 'https://apricoti.co.uk/unsubscribe?u=demo',
  preferences_url: 'https://apricoti.co.uk/settings/notifications',
  app_url: 'https://apricoti.co.uk',
  legal_company_name: 'Apricoti Ltd',
  registered_office_address: 'United Kingdom',
  programme_limit: 25,
};
