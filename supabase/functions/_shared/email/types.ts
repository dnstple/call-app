/**
 * Typed transactional-email primitives shared by the Edge Functions AND the
 * Vitest suite. This module is intentionally DEPENDENCY-FREE (no Deno/npm/Node
 * imports, only web-standard globals) so it runs identically under Deno and
 * jsdom.
 *
 * The frontend NEVER supplies recipients, subjects or HTML. It may only name a
 * predefined event and an entity id; the server resolves everything else from
 * authenticated database records.
 */

/** The only email events Apricoti will ever send. Adding an email = adding here. */
export type EmailEvent = 'booking_requested' | 'email_test';

export const EMAIL_EVENTS: readonly EmailEvent[] = ['booking_requested', 'email_test'] as const;

export function isEmailEvent(x: unknown): x is EmailEvent {
  return typeof x === 'string' && (EMAIL_EVENTS as readonly string[]).includes(x);
}

/** Delivery lifecycle mirrored by the DB check constraint (0138). */
export type EmailStatus =
  | 'pending' | 'sending' | 'sent' | 'delivered'
  | 'failed' | 'bounced' | 'complained' | 'suppressed';

/** A fully-rendered email — never assembled on the client. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Apricoti brand palette (email-safe hex). */
export const BRAND = {
  apricot: '#F2A272',
  paleApricot: '#FBE9DE',
  warmIvory: '#FCFAF7',
  darkInk: '#201C19',
} as const;
