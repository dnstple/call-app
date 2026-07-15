import { describe, expect, it } from 'vitest';
import { availableCredits, consumeCredit, isExpired, remainingCredits, usageLabel } from '../packages';
import type { Booking, PackagePurchase } from '../../types';

const now = new Date('2026-07-12T12:00:00Z');

function purchase(partial: Partial<PackagePurchase> = {}): PackagePurchase {
  return {
    id: 'pp1',
    buyerId: 'coord-1',
    memberId: 'm1',
    companionId: 'c1',
    offerId: 'o1',
    callsTotal: 4,
    callsUsed: 0,
    purchasedAt: '2026-07-01T00:00:00Z',
    expiresAt: '2026-08-12T00:00:00Z',
    status: 'active',
    transactionRef: 'SIM-1',
    ...partial,
  };
}

function pkgBooking(id: string, status: Booking['status']): Booking {
  return {
    id,
    memberId: 'm1',
    companionId: 'c1',
    offerId: 'o1',
    offerKind: 'package',
    packagePurchaseId: 'pp1',
    start: '2026-07-20T10:00:00Z',
    end: '2026-07-20T10:30:00Z',
    timeZone: 'Europe/London',
    medium: 'phone',
    durationMins: 30,
    pricePence: 0,
    isTrial: false,
    status,
    createdAt: '2026-07-12T00:00:00Z',
    history: [],
  };
}

describe('package credits', () => {
  it('credits are consumed only on completion', () => {
    const p = purchase();
    expect(remainingCredits(p)).toBe(4);
    const after = consumeCredit(p);
    expect(after.callsUsed).toBe(1);
    expect(remainingCredits(after)).toBe(3);
  });

  it('active bookings reserve credits without consuming them', () => {
    const p = purchase({ callsUsed: 1 });
    const bookings = [pkgBooking('b1', 'confirmed'), pkgBooking('b2', 'requested')];
    expect(remainingCredits(p)).toBe(3); // display
    expect(availableCredits(p, bookings, now)).toBe(1); // 4 - 1 used - 2 reserved
  });

  it('cancelled bookings release their reservation', () => {
    const p = purchase({ callsUsed: 1 });
    expect(availableCredits(p, [pkgBooking('b1', 'cancelled')], now)).toBe(3);
  });

  it('marks the purchase exhausted at the final credit', () => {
    const p = consumeCredit(purchase({ callsUsed: 3 }));
    expect(p.status).toBe('exhausted');
    expect(availableCredits(p, [], now)).toBe(0);
  });

  it('expired packages cannot be booked', () => {
    const p = purchase({ expiresAt: '2026-07-01T00:00:00Z' });
    expect(isExpired(p, now)).toBe(true);
    expect(availableCredits(p, [], now)).toBe(0);
  });

  it('formats the usage display', () => {
    expect(usageLabel(purchase({ callsUsed: 2 }))).toBe('2 of 4 conversations remaining');
  });
});
