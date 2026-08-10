/**
 * "Finish setting up your Apricoti account" reminder — an OPERATIONAL/lifecycle
 * email (not a marketing broadcast) sent to people who started signing up but
 * never completed onboarding. Two variants:
 *
 *   • emailConfirmed = false → they never confirmed their email, so the message
 *     is "confirm your email to continue" and the CTA takes them to sign in /
 *     resend confirmation.
 *   • emailConfirmed = true  → they confirmed but didn't finish the wizard, so
 *     the message is "you're almost there — finish your profile".
 *
 * When known, the copy is tailored to the role they chose (companion vs the
 * member/coordinator path). Pure, dependency-free render (HTML + text) in
 * Apricoti's identity. All dynamic values are escaped. Every send includes a
 * one-click unsubscribe link (also surfaced as a List-Unsubscribe header).
 */
import { BRAND } from './types.ts';
import { escapeHtml, plainText } from './escape.ts';

export interface OnboardingNudgeData {
  firstName: string;
  intendedRole: string | null;   // 'member' | 'coordinator' | 'companion' | null
  emailConfirmed: boolean;
  appUrl: string;
  supportEmail: string;
  unsubscribeUrl: string;
  /** CTA target; defaults to appUrl. Set to a magic/confirmation link for the
   *  never-confirmed resend path so one click confirms + signs them in. */
  ctaUrl?: string;
}

function roleNoun(role: string | null): string {
  if (role === 'companion') return 'Companion';
  if (role === 'coordinator') return 'Coordinator';
  if (role === 'member') return 'member';
  return '';
}

/** The single line that changes with how far they got + which path they chose. */
function leadCopy(d: OnboardingNudgeData): string {
  const noun = roleNoun(d.intendedRole);
  if (!d.emailConfirmed) {
    return noun
      ? `You started joining Apricoti as a ${noun}, but we don't think you've confirmed your email address yet. Confirming it is the only thing standing between you and finishing your account.`
      : `You started joining Apricoti, but we don't think you've confirmed your email address yet. Confirming it is the only thing standing between you and finishing your account.`;
  }
  if (d.intendedRole === 'companion') {
    return `You're almost a Companion on Apricoti — there are just a few steps left to finish your profile so members can start booking calls with you.`;
  }
  if (d.intendedRole === 'coordinator') {
    return `You're almost set up as a Coordinator on Apricoti — there are just a few steps left to finish setting up the person you're supporting.`;
  }
  return `You're almost there — there are just a few steps left to finish setting up your Apricoti account.`;
}

function ctaLabel(d: OnboardingNudgeData): string {
  return d.emailConfirmed ? 'Finish my account' : 'Confirm and continue';
}

export function renderOnboardingNudge(d: OnboardingNudgeData): { subject: string; html: string; text: string } {
  const name = escapeHtml(d.firstName && d.firstName.trim() ? d.firstName.trim() : 'there');
  const ctaTarget = (d.ctaUrl && d.ctaUrl.trim() ? d.ctaUrl.trim() : d.appUrl).replace(/\/+$/, '');
  const app = escapeHtml(ctaTarget);
  const support = escapeHtml(d.supportEmail);
  const unsub = escapeHtml(d.unsubscribeUrl);
  const lead = escapeHtml(leadCopy(d));
  const cta = escapeHtml(ctaLabel(d));

  const subject = d.emailConfirmed
    ? 'You’re almost there — finish setting up your Apricoti account'
    : 'One step left — confirm your email to finish joining Apricoti';

  const preheader = d.emailConfirmed
    ? 'A few steps left to finish your Apricoti account.'
    : 'Confirm your email to finish joining Apricoti.';

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.paleApricot};color:${BRAND.darkInk};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.paleApricot};">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:${BRAND.warmIvory};border-radius:16px;overflow:hidden;">
<tr><td style="background:${BRAND.apricot};padding:20px 28px;">
<span style="font-size:20px;font-weight:700;color:${BRAND.warmIvory};">Apricoti</span>
</td></tr>
<tr><td style="padding:28px;font-size:16px;line-height:1.6;color:${BRAND.darkInk};">
<p style="margin:0 0 14px;">Hi ${name},</p>
<p style="margin:0 0 14px;">${lead}</p>
<p style="margin:0 0 14px;">It only takes a couple of minutes to pick up where you left off.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="border-radius:10px;background:${BRAND.apricot};">
<a href="${app}" style="display:inline-block;padding:13px 24px;font-size:16px;font-weight:600;color:${BRAND.warmIvory};text-decoration:none;border-radius:10px;">${cta}</a>
</td></tr></table>
<p style="margin:0 0 14px;">Any questions or trouble getting back in, just reply to this email or contact us at <a href="mailto:${support}" style="color:${BRAND.apricot};">${support}</a> — we're happy to help.</p>
<p style="margin:0;">Kind regards,<br>Daniel — Apricoti</p>
</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid ${BRAND.paleApricot};font-size:12px;line-height:1.5;color:#6b625c;">
This is a reminder about the Apricoti account you started setting up. If you'd rather not receive these reminders, <a href="${unsub}" style="color:#6b625c;text-decoration:underline;">unsubscribe here</a>.
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = plainText([
    `Hi ${d.firstName && d.firstName.trim() ? d.firstName.trim() : 'there'},`,
    '',
    leadCopy(d),
    '',
    'It only takes a couple of minutes to pick up where you left off.',
    '',
    `${ctaLabel(d)}: ${ctaTarget}`,
    '',
    `Any questions or trouble getting back in, just reply to this email or contact us at ${d.supportEmail} — we're happy to help.`,
    '',
    'Kind regards,',
    'Daniel — Apricoti',
    '',
    `If you'd rather not receive these reminders, unsubscribe here: ${d.unsubscribeUrl}`,
  ].join('\n'));

  return { subject, html, text };
}
