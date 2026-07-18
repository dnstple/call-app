// @vitest-environment jsdom
/**
 * 2G2 fix — the trial journey uses REAL paid requests in Supabase mode.
 * Regression: prototype-payment wording can never reach the Supabase
 * paid-trial review flow again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const WIZ = readFileSync(join(ROOT, 'src', 'components', 'TestCallWizard.tsx'), 'utf-8');
const HERO = readFileSync(join(ROOT, 'src', 'components', 'CompanionPlanHero.tsx'), 'utf-8');

/** The Supabase-mode (paid) sections of the component source. */
function paidSections(): string {
  // Everything except the explicitly mock-only branch and mock confirm path.
  return WIZ
    .replace(/\{step === 'pay' && slot && member && !paid && \([\s\S]*?\)\}/, '')
    .replace(/\/\/ Mock mode: the simulated prototype journey[\s\S]*?setTimeout\(\(\) => navigate[^\n]*\n/, '');
}

describe('Supabase trial checkout (paid flow)', () => {
  it('1. the review step calls the paid quote operation', () => {
    expect(WIZ).toContain('quotePaidRequest(member.id, companion.id, trialOffer.id)');
    expect(WIZ).toContain("if (step !== 'pay' || !paid || !slot || !member) return;");
  });

  it('2+4. the itemised summary shows the trial price inside the total', () => {
    for (const line of ['Trial price', 'Service fee', 'Card amount', 'Total']) {
      expect(WIZ).toContain(line);
    }
    expect(WIZ).toContain('formatMinor(quote.subtotalMinor)');
    expect(WIZ).toContain('formatMinor(quote.totalMinor)');
  });

  it('3. eligible trials show the waiver — never a free trial', () => {
    expect(WIZ).toContain('Trial service fee waived');
    expect(WIZ).not.toMatch(/trial is free|free trial/i);
  });

  it('5+6. action copy follows the funding split', () => {
    expect(WIZ).toContain("'Use credit and request conversation'");
    expect(WIZ).toContain("'Pay and request conversation'");
    expect(WIZ).toContain('quote.cardAmountMinor === 0');
  });

  it('7. prototype-payment wording is impossible in the paid branch', () => {
    const paid = paidSections();
    for (const phrase of [
      'Prototype payment', 'no payment will be taken',
      'Card payments arrive', 'Request test call', 'One-time test call',
    ]) {
      expect(paid).not.toContain(phrase);
    }
    // "No payment was taken" survives ONLY as the mock arm of the done
    // ternary — the paid arm says payment was received.
    expect(WIZ).toContain("? 'Payment received. Waiting for the Companion’s response.'");
    expect(WIZ).toContain(": 'Your conversation will take place securely in the app. No payment was taken.'");
  });

  it('8. mock mode keeps its clearly-simulated step, explicitly gated', () => {
    expect(WIZ).toContain("{step === 'pay' && slot && member && !paid && (");
    expect(WIZ).toContain('PrototypePaymentStep');
    expect(WIZ).toContain('const paid = isSupabaseMode();');
  });

  it('9. quote failure shows an honest retry — no unpaid fallback', () => {
    expect(WIZ).toContain('Try again');
    expect(WIZ).toContain('onClick={loadQuote}');
    // The paid confirm path contains NO createBookingRequest call.
    const confirmPaid = WIZ.slice(WIZ.indexOf('if (paid) {'), WIZ.indexOf('// Mock mode:'));
    expect(confirmPaid).not.toContain('createBookingRequest');
    // The submit button is disabled until a quote exists.
    expect(WIZ).toContain('disabled={submitting || (paid && !quote)}');
  });

  it('10+11. double submission blocked; success is webhook-gated', () => {
    expect(WIZ).toContain('if (!slot || !member || submitting) return; // duplicate-click protection');
    expect(WIZ).toContain('idempotencyRef.current = `trial-${member.id}-${trialOffer.id}-${slot.startsAt}`');
    expect(WIZ).toContain('getPaymentOrderState(result.orderId)');
    expect(WIZ).toContain('Payment is being confirmed.');
    expect(WIZ).toContain('Payment received. Waiting for the Companion’s response.');
  });

  it('payment-method-required preserves selections and routes to setup', () => {
    expect(WIZ).toContain("payState === 'payment_method_required'");
    expect(WIZ).toContain('Add payment method');
    expect(WIZ).toContain('your selections');
    const branch = WIZ.slice(WIZ.indexOf("if (result.state === 'payment_method_required')"), WIZ.indexOf("if (result.state === 'requires_action'"));
    expect(branch).not.toContain('onClose()');
  });

  it('terminology: Trial conversation everywhere users read', () => {
    expect(WIZ).toContain('Trial conversation with ${companion.firstName}');
    expect(WIZ).toContain('A one-time introduction with no ongoing commitment.');
    expect(HERO).toContain('Book a trial conversation');
    expect(HERO).not.toContain('Book a test call');
  });

  it('13. the one-off paid flow in the booking wizard is untouched', () => {
    const BOOKING = readFileSync(join(ROOT, 'src', 'components', 'SupabaseBookingWizard.tsx'), 'utf-8');
    expect(BOOKING).toContain('quotePaidRequest(member.id, companion.id, selection.offer.id)');
    expect(BOOKING).toContain("'Pay and request conversation'");
  });
});
