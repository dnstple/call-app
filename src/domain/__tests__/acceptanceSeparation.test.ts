/**
 * Section 3 — message acceptance, paid-booking acceptance and Companion payout
 * setup are three DISTINCT concepts and must never be conflated.
 *
 *  A. Message-request acceptance  → no card, no payout. Pure permission.
 *  B. Paid booking                → the PAYER's card is enforced up-front by the
 *                                   setup-first flow, never at the Companion's
 *                                   accept step.
 *  C. Companion payout account    → not required to accept; earnings are held
 *                                   until payouts are connected.
 *
 * Asserted at source level (these pages are large and data-wired).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const MESSAGES = readFileSync(join(ROOT, 'src', 'pages', 'MessagesPage.tsx'), 'utf-8');
const BOOKING = readFileSync(join(ROOT, 'src', 'pages', 'BookingDetail.tsx'), 'utf-8');

describe('A. message-request acceptance needs no card or payout', () => {
  it('the message accept/decline path never references billing, cards or Connect', () => {
    // The whole Messages surface must not tie a message-request response to any
    // payment/payout concept.
    expect(MESSAGES).not.toMatch(/getConnectStatus|getBillingStatus|paymentMethodReady|payouts?_enabled|Set up payouts/i);
    expect(MESSAGES).toContain('respondToIntroduction');
    expect(MESSAGES).toContain('respondToMessageRequest');
  });
});

describe('B + C. paid-booking acceptance is not gated on the Companion payout account', () => {
  it('the Accept button is disabled only while a request is in flight — never on payout state', () => {
    const acceptLine = BOOKING.split('\n').find((l) => l.includes('acceptBooking(booking.id)')) ?? '';
    expect(acceptLine).toContain('disabled={busy}');
    expect(acceptLine).not.toMatch(/payoutReady|connect|payout/i);
  });

  it('an unconnected payout account produces a calm, non-blocking notice — not an error or a block', () => {
    // The notice is a role="note", shown only for a paid request with payouts
    // not yet ready, and it offers a route to set up payouts.
    expect(BOOKING).toContain('payoutReady === false');
    expect(BOOKING).toContain('isPaidRequest');
    expect(BOOKING).toContain('You can accept — payouts are on hold');
    expect(BOOKING).toContain('Set up payouts');
    expect(BOOKING).toMatch(/role="note"/);
  });

  it('payout readiness is only checked for a paid, requested booking on the Companion side', () => {
    const effect = BOOKING.slice(BOOKING.indexOf('const [payoutReady'), BOOKING.indexOf('getConnectStatus()') + 400);
    expect(effect).toContain("booking.status !== 'requested'");
    expect(effect).toContain('!isCompanionSide');
    expect(effect).toContain('!isPaidRequest');
  });

  it('a paid request excludes free trials (trials never need a payout)', () => {
    expect(BOOKING).toContain('!booking.is_trial && booking.price_minor > 0');
  });
});
