/**
 * Typed, server-only email templates in Apricoti's visual identity. Every
 * dynamic value is escaped (escapeHtml) before interpolation, every CTA uses the
 * configured production APP_URL, and every template ships an HTML AND a
 * plain-text body. Restrained, accessible, mobile-first (single 480px column,
 * 16px+ text, high-contrast ink on ivory).
 */
import { BRAND, type EmailEvent, type RenderedEmail } from './types.ts';
import { escapeHtml, plainText } from './escape.ts';

export interface BookingRequestedData {
  companionFirstName: string;
  memberFirstName: string;   // minimum Member info the Companion may see
  callDateText: string;      // e.g. "Friday, 8 August 2026"
  callTimeText: string;      // e.g. "3:00 PM"
  durationText: string;      // e.g. "30 minutes"
  timezone: string;          // e.g. "Europe/London"
  isTrial: boolean;
  reviewUrl: string;         // secure deep link, built from APP_URL
}

export interface TestEmailData {
  environment: string;
  testRunId: string;
  timestampText: string;
  appUrl: string;
}

/** Shared chrome. `preheader` is the inbox-preview snippet; `bodyHtml` is trusted (already escaped). */
function layout(opts: { title: string; preheader: string; bodyHtml: string }): string {
  const { title, preheader, bodyHtml } = opts;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.paleApricot};color:${BRAND.darkInk};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.paleApricot};">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:${BRAND.warmIvory};border-radius:16px;overflow:hidden;">
<tr><td style="background:${BRAND.apricot};padding:20px 28px;">
<span style="font-size:20px;font-weight:700;color:${BRAND.warmIvory};letter-spacing:0.3px;">Apricoti</span>
</td></tr>
<tr><td style="padding:28px;font-size:16px;line-height:1.55;color:${BRAND.darkInk};">
${bodyHtml}
</td></tr>
<tr><td style="padding:20px 28px;border-top:1px solid ${BRAND.paleApricot};font-size:12px;line-height:1.5;color:#6b625c;">
You're receiving this because you have an Apricoti account. This is a service message about your account activity.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function button(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td style="border-radius:10px;background:${BRAND.apricot};">
<a href="${escapeHtml(url)}" style="display:inline-block;padding:13px 24px;font-size:16px;font-weight:600;color:${BRAND.warmIvory};text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>
</td></tr></table>`;
}

function renderBookingRequested(d: BookingRequestedData): RenderedEmail {
  const kind = d.isTrial ? 'trial call' : 'paid call';
  const companion = escapeHtml(d.companionFirstName);
  const member = escapeHtml(d.memberFirstName);
  const subject = `New ${kind} request on Apricoti`;

  const bodyHtml = `
<p style="margin:0 0 12px;">Hi ${companion},</p>
<p style="margin:0 0 16px;">You have a new <strong>${escapeHtml(kind)}</strong> request from ${member}. Here are the details:</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.paleApricot};border-radius:12px;">
<tr><td style="padding:16px 18px;font-size:15px;line-height:1.7;">
<div><strong>Date:</strong> ${escapeHtml(d.callDateText)}</div>
<div><strong>Time:</strong> ${escapeHtml(d.callTimeText)} (${escapeHtml(d.timezone)})</div>
<div><strong>Duration:</strong> ${escapeHtml(d.durationText)}</div>
<div><strong>Type:</strong> ${escapeHtml(d.isTrial ? 'Trial' : 'Paid')}</div>
</td></tr>
</table>
${button('Review booking', d.reviewUrl)}
<p style="margin:0;font-size:14px;color:#6b625c;">Please review and respond so ${member} knows if the call is confirmed.</p>`;

  const text = plainText(
    `Hi ${d.companionFirstName},\n\n` +
    `You have a new ${kind} request from ${d.memberFirstName}.\n\n` +
    `Date: ${d.callDateText}\n` +
    `Time: ${d.callTimeText} (${d.timezone})\n` +
    `Duration: ${d.durationText}\n` +
    `Type: ${d.isTrial ? 'Trial' : 'Paid'}\n\n` +
    `Review booking: ${d.reviewUrl}\n\n` +
    `Please review and respond so they know if the call is confirmed.\n\n— Apricoti`,
  );

  return { subject, html: layout({ title: subject, preheader: `New ${kind} request from ${d.memberFirstName}`, bodyHtml }), text };
}

function renderTestEmail(d: TestEmailData): RenderedEmail {
  const subject = 'Apricoti email notification test';
  const bodyHtml = `
<p style="margin:0 0 12px;">This is a test of Apricoti's transactional email delivery.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.paleApricot};border-radius:12px;">
<tr><td style="padding:16px 18px;font-size:15px;line-height:1.7;">
<div><strong>Environment:</strong> ${escapeHtml(d.environment)}</div>
<div><strong>Test run ID:</strong> ${escapeHtml(d.testRunId)}</div>
<div><strong>Sent at:</strong> ${escapeHtml(d.timestampText)}</div>
</td></tr>
</table>
${button('Open Apricoti', d.appUrl)}
<p style="margin:0;font-size:14px;color:#6b625c;">No booking, call or payment was created by this test.</p>`;

  const text = plainText(
    `Apricoti email notification test\n\n` +
    `Environment: ${d.environment}\n` +
    `Test run ID: ${d.testRunId}\n` +
    `Sent at: ${d.timestampText}\n\n` +
    `Open Apricoti: ${d.appUrl}\n\n` +
    `No booking, call or payment was created by this test.`,
  );

  return { subject, html: layout({ title: subject, preheader: 'Apricoti email delivery test', bodyHtml }), text };
}

/** Discriminated render entry point. Data shape is validated by the caller/types. */
export function renderEmail(event: EmailEvent, data: BookingRequestedData | TestEmailData): RenderedEmail {
  switch (event) {
    case 'booking_requested':
      return renderBookingRequested(data as BookingRequestedData);
    case 'email_test':
      return renderTestEmail(data as TestEmailData);
    default: {
      const _exhaustive: never = event;
      throw new Error(`Unknown email event: ${String(_exhaustive)}`);
    }
  }
}
