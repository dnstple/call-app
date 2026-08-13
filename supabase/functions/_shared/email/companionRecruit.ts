/**
 * Companion recruitment campaign email — the core growth push: convince
 * Companions to invite the members/coordinators THEY know onto Apricoti. The
 * pitch is not a cash bounty; it's the real value: when someone you invite joins
 * and books calls with you, you earn from every conversation. Manual-send only
 * (admin-triggered). Pure render (HTML + text); all values escaped; one-click
 * unsubscribe included.
 */
import { BRAND } from './types.ts';
import { escapeHtml, plainText } from './escape.ts';

export const COMPANION_RECRUIT_SUBJECT = 'Invite the people you know — and earn from every conversation';

export interface CompanionRecruitData {
  firstName: string;
  appUrl: string;
  supportEmail: string;
  unsubscribeUrl: string;
}

export function renderCompanionRecruit(d: CompanionRecruitData): { subject: string; html: string; text: string } {
  const name = escapeHtml(d.firstName && d.firstName.trim() ? d.firstName.trim() : 'there');
  const app = escapeHtml(d.appUrl.replace(/\/+$/, ''));
  const support = escapeHtml(d.supportEmail);
  const unsub = escapeHtml(d.unsubscribeUrl);
  const subject = COMPANION_RECRUIT_SUBJECT;

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.paleApricot};color:${BRAND.darkInk};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">Invite someone you know — when they book calls with you, you earn.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.paleApricot};">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:${BRAND.warmIvory};border-radius:16px;overflow:hidden;">
<tr><td style="background:${BRAND.apricot};padding:20px 28px;">
<span style="font-size:20px;font-weight:700;color:${BRAND.warmIvory};">Apricoti</span>
</td></tr>
<tr><td style="padding:28px;font-size:16px;line-height:1.6;color:${BRAND.darkInk};">
<p style="margin:0 0 14px;">Hi ${name},</p>
<p style="margin:0 0 14px;">You're already set up to have wonderful conversations on Apricoti — now here's the best way to fill your calendar with people you'll genuinely enjoy talking to: <strong>invite the members and coordinators you already know.</strong></p>
<p style="margin:0 0 14px;">Think of someone who'd love a regular friendly chat — a neighbour, a former client, a family you've supported, someone in a group you're part of. Send them your personal invite link. When they join and book calls with you, <strong>you earn from every conversation you have together.</strong></p>
<p style="margin:0 0 14px;">It's the simplest way to grow your own little community here — and to turn the relationships you already have into regular, paid conversations.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="border-radius:10px;background:${BRAND.apricot};">
<a href="${app}" style="display:inline-block;padding:13px 24px;font-size:16px;font-weight:600;color:${BRAND.warmIvory};text-decoration:none;border-radius:10px;">Get my invite link</a>
</td></tr></table>
<p style="margin:0 0 14px;">Your invite link is on your Apricoti home screen — copy it and share it with one person today. Any questions, just reply to this email or reach us at <a href="mailto:${support}" style="color:${BRAND.apricot};">${support}</a>.</p>
<p style="margin:0;">Warm wishes,<br>Daniel — Apricoti</p>
</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid ${BRAND.paleApricot};font-size:12px;line-height:1.5;color:#6b625c;">
You're receiving this because you're a Companion on Apricoti. If you'd rather not get these, <a href="${unsub}" style="color:#6b625c;text-decoration:underline;">unsubscribe here</a>.
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = plainText([
    `Hi ${d.firstName && d.firstName.trim() ? d.firstName.trim() : 'there'},`,
    '',
    "You're already set up to have wonderful conversations on Apricoti — now here's the best way to fill your",
    'calendar with people you\'ll genuinely enjoy talking to: invite the members and coordinators you already know.',
    '',
    "Think of someone who'd love a regular friendly chat — a neighbour, a former client, a family you've",
    'supported, someone in a group you\'re part of. Send them your personal invite link. When they join and book',
    'calls with you, you earn from every conversation you have together.',
    '',
    "It's the simplest way to grow your own little community here — and to turn the relationships you already",
    'have into regular, paid conversations.',
    '',
    `Get my invite link: ${d.appUrl.replace(/\/+$/, '')}`,
    '',
    'Your invite link is on your Apricoti home screen — copy it and share it with one person today.',
    `Any questions, just reply to this email or reach us at ${d.supportEmail}.`,
    '',
    'Warm wishes,',
    'Daniel — Apricoti',
    '',
    `If you'd rather not get these, unsubscribe here: ${d.unsubscribeUrl}`,
  ].join('\n'));

  return { subject, html, text };
}
