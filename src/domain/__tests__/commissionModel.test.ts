import { describe, it, expect } from 'vitest';
import {
  computeCommission,
  commissionRateBps,
  allocatePence,
  STANDARD_COMMISSION_BPS,
  TRIAL_COMMISSION_BPS,
} from '../commission';

describe('commission model — authoritative integer-pence calculation', () => {
  it('config: 10% standard, 0% trial', () => {
    expect(STANDARD_COMMISSION_BPS).toBe(1000);
    expect(TRIAL_COMMISSION_BPS).toBe(0);
    expect(commissionRateBps(false)).toBe(1000);
    expect(commissionRateBps(true)).toBe(0);
  });

  // The exact figures required by the spec.
  const cases = [
    { label: '£15.00 gross, 43p fee', gross: 1500, fee: 43, trial: false, net: 1457, commission: 146, companion: 1311 },
    { label: '£10.00 gross, 35p fee', gross: 1000, fee: 35, trial: false, net: 965, commission: 97, companion: 868 },
    { label: '£20.00 gross, 50p fee', gross: 2000, fee: 50, trial: false, net: 1950, commission: 195, companion: 1755 },
    { label: '£5.00 trial, 28p fee', gross: 500, fee: 28, trial: true, net: 472, commission: 0, companion: 472 },
  ];

  for (const c of cases) {
    it(`${c.label}`, () => {
      const r = computeCommission(c.gross, c.fee, c.trial);
      expect(r.netAfterStripePence).toBe(c.net);
      expect(r.commissionPence).toBe(c.commission);
      expect(r.companionEarningsPence).toBe(c.companion);
    });
  }

  it('the reconciliation invariant always holds exactly', () => {
    for (const c of cases) {
      const r = computeCommission(c.gross, c.fee, c.trial);
      expect(r.stripeFeePence + r.commissionPence + r.companionEarningsPence).toBe(r.grossPence);
    }
  });

  it('same price, different actual Stripe fees produce different splits', () => {
    const a = computeCommission(1500, 43, false);
    const b = computeCommission(1500, 60, false);
    expect(a.stripeFeePence).not.toBe(b.stripeFeePence);
    // Higher fee → lower net → lower commission and lower companion earnings.
    expect(b.commissionPence).toBeLessThan(a.commissionPence);
    expect(b.companionEarningsPence).toBeLessThan(a.companionEarningsPence);
    // Both still reconcile.
    for (const r of [a, b]) expect(r.stripeFeePence + r.commissionPence + r.companionEarningsPence).toBe(r.grossPence);
  });

  it('rounds half away from zero, with the remainder assigned to the Companion', () => {
    // net = 965 → 96.5 → 97 (half up), companion absorbs the 0.5 remainder downwards.
    const r = computeCommission(1000, 35, false);
    expect(r.commissionPence).toBe(97);
    expect(r.companionEarningsPence).toBe(868);
    // A net that divides exactly leaves no remainder.
    const exact = computeCommission(2000, 50, false); // net 1950 → 195.0
    expect(exact.commissionPence).toBe(195);
  });

  it('trials never charge commission but still deduct the Stripe fee', () => {
    const r = computeCommission(500, 28, true);
    expect(r.commissionRateBps).toBe(0);
    expect(r.commissionPence).toBe(0);
    expect(r.companionEarningsPence).toBe(472); // net = gross - fee
    expect(r.stripeFeePence).toBe(28);
  });

  it('rejects invalid amounts (server never trusts these)', () => {
    expect(() => computeCommission(-1, 0, false)).toThrow();
    expect(() => computeCommission(1000, -1, false)).toThrow();
    expect(() => computeCommission(1000, 1001, false)).toThrow(); // fee > gross
    expect(() => computeCommission(10.5, 0, false)).toThrow();    // non-integer
  });

  it('package/plan allocation sums EXACTLY to the total (largest remainder)', () => {
    // A package earning of 1311p across 4 calls: 328,328,328,327 → 1311.
    const a = allocatePence(1311, 4);
    expect(a.reduce((s, x) => s + x, 0)).toBe(1311);
    expect(a).toEqual([328, 328, 328, 327]);
    // Each component of the breakdown is allocated across credits and the
    // per-call slices sum EXACTLY back to the payment-level total (the spec's
    // reconciliation requirement — components are allocated independently).
    const r = computeCommission(6137, 137, false); // odd figures → real remainders
    const feeShares = allocatePence(r.stripeFeePence, 3);
    const commShares = allocatePence(r.commissionPence, 3);
    const earnShares = allocatePence(r.companionEarningsPence, 3);
    expect(feeShares.reduce((s, x) => s + x, 0)).toBe(r.stripeFeePence);
    expect(commShares.reduce((s, x) => s + x, 0)).toBe(r.commissionPence);
    expect(earnShares.reduce((s, x) => s + x, 0)).toBe(r.companionEarningsPence);
    // Uneven splits differ by at most one penny between shares.
    expect(Math.max(...earnShares) - Math.min(...earnShares)).toBeLessThanOrEqual(1);
    expect(() => allocatePence(100, 0)).toThrow();
  });

  it('a zero-net payment yields zero commission and zero earnings', () => {
    const r = computeCommission(500, 500, false);
    expect(r.netAfterStripePence).toBe(0);
    expect(r.commissionPence).toBe(0);
    expect(r.companionEarningsPence).toBe(0);
  });
});
