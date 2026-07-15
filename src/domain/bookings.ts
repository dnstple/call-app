import type {
  Booking,
  BookingStatus,
  CompletionConfirmation,
  CompletionOutcome,
} from '../types';

/** Allowed booking status transitions. */
const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  draft: ['requested', 'cancelled'],
  requested: ['confirmed', 'cancelled', 'requested'], // requested→requested = proposed new time
  confirmed: ['in_progress', 'awaiting_completion', 'cancelled', 'confirmed'], // confirmed→confirmed = reschedule
  in_progress: ['awaiting_completion'],
  awaiting_completion: ['completed', 'missed', 'needs_review'],
  completed: [],
  missed: [],
  cancelled: [],
  needs_review: ['completed', 'missed', 'cancelled'],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid booking transition: ${from} → ${to}`);
  }
}

/**
 * Derive the display status from stored status + current time.
 * Confirmed bookings become "in progress" during the slot and
 * "awaiting completion" once the scheduled end has passed.
 */
export function effectiveStatus(booking: Booking, now: Date): BookingStatus {
  if (booking.status === 'confirmed') {
    if (now >= new Date(booking.end)) return 'awaiting_completion';
    if (now >= new Date(booking.start)) return 'in_progress';
  }
  return booking.status;
}

/**
 * Trial rule: one 30-minute trial per Member–Companion pairing.
 * A cancelled or declined trial does not consume eligibility.
 */
export function trialEligible(
  bookings: Booking[],
  memberId: string,
  companionId: string,
): boolean {
  return !bookings.some(
    (b) =>
      b.isTrial &&
      b.memberId === memberId &&
      b.companionId === companionId &&
      b.status !== 'cancelled',
  );
}

/** True when the proposed slot overlaps an existing active booking for the Companion. */
export function hasConflict(
  bookings: Booking[],
  companionId: string,
  startISO: string,
  endISO: string,
  ignoreBookingId?: string,
): boolean {
  const start = new Date(startISO).getTime();
  const end = new Date(endISO).getTime();
  return bookings.some((b) => {
    if (b.companionId !== companionId) return false;
    if (b.id === ignoreBookingId) return false;
    if (!['requested', 'confirmed', 'in_progress'].includes(b.status)) return false;
    const bStart = new Date(b.start).getTime();
    const bEnd = new Date(b.end).getTime();
    return start < bEnd && end > bStart;
  });
}

/**
 * Reconcile the two parties' completion confirmations.
 * - Both "completed"                → completed
 * - Any "concern" or disagreement   → needs_review
 * - Both "did_not_happen"           → missed
 * - Only one response so far        → awaiting (waiting for the other person)
 */
export function reconcileCompletion(
  confirmations: CompletionConfirmation[],
  bookingId: string,
): { resolved: BookingStatus | null; waitingFor: 'other' | null } {
  const byBooking = confirmations.filter((c) => c.bookingId === bookingId);
  const outcomes = new Map<string, CompletionOutcome>();
  for (const c of byBooking) outcomes.set(c.userId, c.outcome); // latest wins per user
  const values = [...outcomes.values()];

  if (values.includes('concern')) return { resolved: 'needs_review', waitingFor: null };
  if (values.length >= 2) {
    const allCompleted = values.every((v) => v === 'completed');
    const allMissed = values.every((v) => v === 'did_not_happen');
    if (allCompleted) return { resolved: 'completed', waitingFor: null };
    if (allMissed) return { resolved: 'missed', waitingFor: null };
    return { resolved: 'needs_review', waitingFor: null }; // disagreement
  }
  if (values.length === 1) return { resolved: null, waitingFor: 'other' };
  return { resolved: null, waitingFor: null };
}

export const STATUS_LABELS: Record<BookingStatus, string> = {
  draft: 'Draft',
  requested: 'Requested',
  confirmed: 'Confirmed',
  in_progress: 'In progress',
  awaiting_completion: 'Awaiting completion',
  completed: 'Completed',
  missed: 'Missed',
  cancelled: 'Cancelled',
  needs_review: 'Needs review',
};
