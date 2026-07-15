import type { Booking, PackagePurchase } from '../types';

/**
 * Package credit rule: `callsUsed` increments only when a booking is COMPLETED
 * (the correct simulated lifecycle point). Active bookings *reserve* credits so
 * a purchase cannot be over-booked, but reserved credits are released if the
 * booking is cancelled or declined.
 */

export function isExpired(purchase: PackagePurchase, now: Date): boolean {
  return now > new Date(purchase.expiresAt);
}

/** Credits reserved by bookings that are still moving through the lifecycle. */
export function reservedCredits(purchase: PackagePurchase, bookings: Booking[]): number {
  return bookings.filter(
    (b) =>
      b.packagePurchaseId === purchase.id &&
      ['requested', 'confirmed', 'in_progress', 'awaiting_completion', 'needs_review'].includes(
        b.status,
      ),
  ).length;
}

/** Credits available to book with right now. */
export function availableCredits(purchase: PackagePurchase, bookings: Booking[], now: Date): number {
  if (purchase.status !== 'active' || isExpired(purchase, now)) return 0;
  return Math.max(0, purchase.callsTotal - purchase.callsUsed - reservedCredits(purchase, bookings));
}

/** Remaining (not yet consumed) credits, ignoring reservations — for "2 of 4 remaining" display. */
export function remainingCredits(purchase: PackagePurchase): number {
  return Math.max(0, purchase.callsTotal - purchase.callsUsed);
}

/** Called when a package-funded booking completes: consume one credit. */
export function consumeCredit(purchase: PackagePurchase): PackagePurchase {
  const callsUsed = Math.min(purchase.callsTotal, purchase.callsUsed + 1);
  return {
    ...purchase,
    callsUsed,
    status: callsUsed >= purchase.callsTotal ? 'exhausted' : purchase.status,
  };
}

export function usageLabel(purchase: PackagePurchase): string {
  return `${remainingCredits(purchase)} of ${purchase.callsTotal} conversations remaining`;
}
