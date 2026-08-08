/**
 * Pure authorization + presentation logic for the booking_requested email.
 *
 * Recipients are ALWAYS resolved from the booking record server-side (the
 * Companion on the booking) — there is no code path that accepts a client-
 * supplied recipient, which is what stops a user emailing an arbitrary person.
 * The trigger is authorised: only the account that made the booking may cause
 * its Companion to be emailed.
 */
import { escapeHtml } from './escape.ts';

export class EmailAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailAuthorizationError';
  }
}

export interface BookingRow {
  id: string;
  booked_by_account_id: string;
  member_profile_id: string;
  companion_profile_id: string;
  starts_at: string;   // ISO
  ends_at: string;     // ISO
  timezone: string;
  is_trial: boolean;
  status: string;
}

/**
 * Only the booker may trigger the Companion notification for their booking.
 * Throws EmailAuthorizationError otherwise — a user can never make Apricoti
 * email someone on a booking that isn't theirs.
 */
export function assertBookingEmailAuthorized(booking: BookingRow, callerAccountId: string): void {
  if (!callerAccountId || booking.booked_by_account_id !== callerAccountId) {
    throw new EmailAuthorizationError('Not authorised to trigger email for this booking');
  }
}

/** Human-readable date / time / duration in the booking's own timezone. */
export function formatCallTimes(startsAtIso: string, endsAtIso: string, timezone: string): {
  dateText: string; timeText: string; durationText: string;
} {
  const start = new Date(startsAtIso);
  const end = new Date(endsAtIso);
  const tz = timezone || 'UTC';
  const dateText = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz,
  }).format(start);
  const timeText = new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  }).format(start);
  const mins = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  const durationText = `${mins} minute${mins === 1 ? '' : 's'}`;
  return { dateText, timeText, durationText };
}

/** The MINIMUM Member identity a Companion may see: first name only. */
export function minimalMemberName(firstName: string | null | undefined): string {
  const n = (firstName ?? '').trim();
  return n.length > 0 ? n : 'A member';
}

/** Secure deep link to review the booking, always built from APP_URL. */
export function bookingReviewUrl(appUrl: string, bookingId: string): string {
  return `${appUrl.replace(/\/+$/, '')}/#/bookings/${encodeURIComponent(bookingId)}`;
}

/** Escaped, minimal export used by callers that need the safe member label. */
export function safeMemberLabel(firstName: string | null | undefined): string {
  return escapeHtml(minimalMemberName(firstName));
}
