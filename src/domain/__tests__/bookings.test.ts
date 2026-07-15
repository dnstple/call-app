import { describe, expect, it } from 'vitest';
import {
  canTransition,
  effectiveStatus,
  hasConflict,
  reconcileCompletion,
  trialEligible,
} from '../bookings';
import type { Booking, CompletionConfirmation } from '../../types';

function booking(partial: Partial<Booking>): Booking {
  return {
    id: 'b1',
    memberId: 'm1',
    companionId: 'c1',
    offerId: 'o1',
    offerKind: 'single',
    start: '2026-07-10T10:00:00.000Z',
    end: '2026-07-10T10:30:00.000Z',
    timeZone: 'Europe/London',
    medium: 'phone',
    durationMins: 30,
    pricePence: 1500,
    isTrial: false,
    status: 'confirmed',
    createdAt: '2026-07-01T00:00:00.000Z',
    history: [],
    ...partial,
  };
}

function conf(userId: string, outcome: CompletionConfirmation['outcome']): CompletionConfirmation {
  return { id: `cc-${userId}`, bookingId: 'b1', userId, outcome, confirmedAt: '2026-07-10T11:00:00.000Z' };
}

describe('status transitions', () => {
  it('allows the documented lifecycle', () => {
    expect(canTransition('requested', 'confirmed')).toBe(true);
    expect(canTransition('confirmed', 'awaiting_completion')).toBe(true);
    expect(canTransition('awaiting_completion', 'completed')).toBe(true);
    expect(canTransition('awaiting_completion', 'needs_review')).toBe(true);
  });
  it('blocks invalid jumps', () => {
    expect(canTransition('completed', 'requested')).toBe(false);
    expect(canTransition('cancelled', 'confirmed')).toBe(false);
    expect(canTransition('requested', 'completed')).toBe(false);
  });
});

describe('effective status by time', () => {
  it('derives in-progress and awaiting-completion from confirmed', () => {
    const b = booking({ status: 'confirmed' });
    expect(effectiveStatus(b, new Date('2026-07-10T09:00:00Z'))).toBe('confirmed');
    expect(effectiveStatus(b, new Date('2026-07-10T10:15:00Z'))).toBe('in_progress');
    expect(effectiveStatus(b, new Date('2026-07-10T11:00:00Z'))).toBe('awaiting_completion');
  });
});

describe('trial eligibility (one trial per Member–Companion pairing)', () => {
  it('is eligible with no prior trial', () => {
    expect(trialEligible([], 'm1', 'c1')).toBe(true);
  });
  it('is ineligible after any non-cancelled trial', () => {
    expect(trialEligible([booking({ isTrial: true, status: 'completed' })], 'm1', 'c1')).toBe(false);
    expect(trialEligible([booking({ isTrial: true, status: 'requested' })], 'm1', 'c1')).toBe(false);
  });
  it('a cancelled trial restores eligibility', () => {
    expect(trialEligible([booking({ isTrial: true, status: 'cancelled' })], 'm1', 'c1')).toBe(true);
  });
  it('is scoped to the pairing', () => {
    expect(trialEligible([booking({ isTrial: true, status: 'completed' })], 'm1', 'c2')).toBe(true);
    expect(trialEligible([booking({ isTrial: true, status: 'completed' })], 'm2', 'c1')).toBe(true);
  });
});

describe('double-booking checks', () => {
  const existing = [booking({ status: 'confirmed' })];
  it('detects overlap', () => {
    expect(hasConflict(existing, 'c1', '2026-07-10T10:15:00Z', '2026-07-10T10:45:00Z')).toBe(true);
  });
  it('allows adjacent slots', () => {
    expect(hasConflict(existing, 'c1', '2026-07-10T10:30:00Z', '2026-07-10T11:00:00Z')).toBe(false);
  });
  it('ignores cancelled bookings and other companions', () => {
    expect(
      hasConflict([booking({ status: 'cancelled' })], 'c1', '2026-07-10T10:00:00Z', '2026-07-10T10:30:00Z'),
    ).toBe(false);
    expect(hasConflict(existing, 'c2', '2026-07-10T10:00:00Z', '2026-07-10T10:30:00Z')).toBe(false);
  });
});

describe('completion reconciliation', () => {
  it('waits when only one side has confirmed', () => {
    expect(reconcileCompletion([conf('m1', 'completed')], 'b1')).toEqual({
      resolved: null,
      waitingFor: 'other',
    });
  });
  it('completes when both agree', () => {
    expect(reconcileCompletion([conf('m1', 'completed'), conf('c1', 'completed')], 'b1').resolved).toBe(
      'completed',
    );
  });
  it('marks missed when both say it did not happen', () => {
    expect(
      reconcileCompletion([conf('m1', 'did_not_happen'), conf('c1', 'did_not_happen')], 'b1').resolved,
    ).toBe('missed');
  });
  it('routes disagreement to needs_review', () => {
    expect(
      reconcileCompletion([conf('m1', 'completed'), conf('c1', 'did_not_happen')], 'b1').resolved,
    ).toBe('needs_review');
  });
  it('routes any concern straight to needs_review', () => {
    expect(reconcileCompletion([conf('m1', 'concern')], 'b1').resolved).toBe('needs_review');
  });
});
