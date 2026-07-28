/**
 * Block 9 — payment-method-first booking (contract).
 *
 * Source-level guarantees on the booking wizard + profile resume, complementing
 * the behavioural bookingDraft and edge-allowlist suites. The wizard is a large
 * component wired to auth/state/repos, so — like the existing 2G2 checkout
 * tests — its guarantees are asserted against the source.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const WIZ = readFileSync(join(ROOT, 'src', 'components', 'SupabaseBookingWizard.tsx'), 'utf-8');
const PROFILE = readFileSync(join(ROOT, 'src', 'pages', 'ProfileDetail.tsx'), 'utf-8');
const REPO = readFileSync(join(ROOT, 'src', 'repositories', 'billingRepository.ts'), 'utf-8');

describe('Block 9 — wizard setup-first flow', () => {
  it('card readiness is server-derived (billing_status) for this customer', () => {
    expect(WIZ).toContain('getBillingStatus()');
    expect(WIZ).toContain('setCardReady(s.paymentMethodReady)');
  });

  it('existing-card bypass: setup only launches when a card is truly needed', () => {
    // Divert to setup only when no card AND a card amount is actually due.
    expect(WIZ).toContain('cardReady === false && !!quote && quote.cardAmountMinor > 0');
  });

  it('missing-card launch saves the draft and opens Stripe setup — with NO order', () => {
    const fn = WIZ.slice(WIZ.indexOf('const launchCardSetup'), WIZ.indexOf('const submit = useCallback'));
    expect(fn).toContain('saveBookingDraft({');
    expect(fn).toContain('createSetupSession(`/people/${companion.id}`)');
    expect(fn).toContain('window.location.href = url');
    // The authoritative order call must NOT appear in the setup path.
    expect(fn).not.toContain('createPaidRequest');
  });

  it('order creation stays at its existing authoritative point with the SAME idempotency key', () => {
    expect(WIZ).toContain('idempotencyRef.current = `req-${member.id}-${selection.offer.id}-${slot.startsAt}`');
    expect(WIZ).toContain('idempotencyKey: idempotencyRef.current');
    // createPaidRequest is only reached via submitPaid (the paid path), never setup.
    expect(WIZ).toContain('await submitPaid();');
  });

  it('draft is terminal: cleared once an order is placed', () => {
    expect(WIZ).toContain('clearBookingDraft(); // draft is terminal once the order is placed');
  });

  it('a single-redirect guard prevents repeated launches', () => {
    const fn = WIZ.slice(WIZ.indexOf('const launchCardSetup'), WIZ.indexOf('const submit = useCallback'));
    expect(fn).toContain('redirectedRef.current');
  });

  it('resume restores the exact offer + slot and lands on review', () => {
    expect(WIZ).toContain('offers.find((o) => o.id === resume.offerId)');
    expect(WIZ).toContain("setStep('review')");
    expect(WIZ).toContain('setSelection({ kind: \'offer\', offer })');
  });
});

describe('Block 9 — profile resume-on-return', () => {
  it('only acts on the resume return once and strips the query to prevent replay', () => {
    expect(PROFILE).toContain("params.get('resume') !== 'booking'");
    expect(PROFILE).toContain('resumeHandledRef.current = true');
    expect(PROFILE).toContain('navigate(`/people/${id}`, { replace: true })');
  });

  it('loads the OWNER-BOUND draft and only for this companion', () => {
    expect(PROFILE).toContain('loadBookingDraft(accountId)');
    expect(PROFILE).toContain('draft.companionId !== user.id');
  });

  it('verifies the card SERVER-SIDE before resuming; cancel keeps the draft', () => {
    expect(PROFILE).toContain('getBillingStatus().then((s) =>');
    expect(PROFILE).toContain('s.paymentMethodReady');
    expect(PROFILE).toContain("setupOutcome === 'cancelled'");
  });
});

describe('Block 9 — repo', () => {
  it('createSetupSession passes the resume returnPath through', () => {
    expect(REPO).toContain('createSetupSession(returnPath?: string)');
    expect(REPO).toContain("returnPath: returnPath ?? ''");
  });
});
