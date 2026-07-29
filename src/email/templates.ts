/**
 * Block 3 — deterministic email templates.
 *
 * The outbox row already snapshots a neutral subject + body (the same copy shown
 * in-app), so rendering is deterministic and adds only a safe, consistent
 * plain-text wrapper: a greeting-free body, a link back to the app, a
 * preferences note, and a fixed safety line. NO timestamps, NO sensitive
 * financial detail, NO personal data beyond what the notification already
 * carried. Given the same input, render() always returns identical output.
 */
import type { OutboxEmail, RenderedEmail } from './adapter';

const APP_NAME = 'your companionship app';

const CATEGORY_FOOTER: Record<string, string> = {
  messages: 'You’re receiving this because you have a conversation on the app.',
  bookings: 'You’re receiving this about a conversation you have booked.',
  billing: 'You’re receiving this about a payment on your account.',
  safety: 'You’re receiving this because it concerns safety on the app.',
  system: 'You’re receiving this because of activity on your account.',
};

const SAFETY_LINE =
  'This service is not for emergencies. If someone is in immediate danger, contact your local emergency services. We never ask for your password or bank details by email.';

/** Deterministically render an outbox row to a plain-text email body. */
export function renderEmail(row: OutboxEmail): RenderedEmail {
  const footer = CATEGORY_FOOTER[row.category] ?? CATEGORY_FOOTER.system;
  const text = [
    row.body_text.trim(),
    '',
    `Open ${APP_NAME} to see more.`,
    '',
    footer,
    'You can change your email preferences in Settings.',
    '',
    SAFETY_LINE,
  ].join('\n');
  return { ...row, text };
}

/** The set of template keys the enqueue trigger can produce (notification:<type>). */
export function isKnownTemplate(templateKey: string): boolean {
  return templateKey.startsWith('notification:');
}
