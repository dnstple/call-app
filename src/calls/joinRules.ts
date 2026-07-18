/**
 * Stage 2F1 — ONE consistent join rule for in-app conversations.
 *
 * The database/server clock is the authority: the Edge Function
 * (supabase/functions/livekit-token) applies EXACTLY these boundaries when
 * deciding whether to mint a token. This module is the browser's mirror of
 * that rule for countdowns and screen states — never a substitute for it.
 *
 * Boundaries (documented contract):
 * - waiting room (page, no media):  starts_at − 10 minutes
 * - media/token becomes available:  starts_at − 5 minutes
 * - room stays joinable until:      ends_at + 30 minutes
 * - only CONFIRMED bookings ever open a room; requested, declined,
 *   cancelled, completed and needs_review bookings do not.
 */

export const WAITING_ROOM_OPEN_MINUTES = 10;
export const MEDIA_OPEN_MINUTES = 5;
export const ROOM_CLOSE_AFTER_END_MINUTES = 30;

export type JoinState =
  | 'too_early'
  | 'joinable'
  | 'ended'
  | 'unauthorised'
  | 'booking_not_eligible';

/** Statuses that may ever open a call room. */
export const JOINABLE_STATUSES = ['confirmed'] as const;

/** Pure media-window evaluation (mirrors the Edge Function). */
export function evaluateJoinWindow(
  startsAt: string,
  endsAt: string,
  now: Date = new Date(),
): 'too_early' | 'joinable' | 'ended' {
  const opens = Date.parse(startsAt) - MEDIA_OPEN_MINUTES * 60_000;
  const closes = Date.parse(endsAt) + ROOM_CLOSE_AFTER_END_MINUTES * 60_000;
  if (now.getTime() < opens) return 'too_early';
  if (now.getTime() > closes) return 'ended';
  return 'joinable';
}

/** Full booking evaluation (mirrors the Edge Function decision). */
export function evaluateBookingJoin(
  booking: { status: string; starts_at: string; ends_at: string } | null,
  now: Date = new Date(),
): JoinState {
  if (!booking) return 'unauthorised'; // not found and not yours look identical
  if (!(JOINABLE_STATUSES as readonly string[]).includes(booking.status)) {
    return 'booking_not_eligible';
  }
  return evaluateJoinWindow(booking.starts_at, booking.ends_at, now);
}

/** May the waiting-room page (no media) be shown yet? */
export function waitingRoomOpen(startsAt: string, now: Date = new Date()): boolean {
  return now.getTime() >= Date.parse(startsAt) - WAITING_ROOM_OPEN_MINUTES * 60_000;
}

/** Server-derived room name: booking-scoped, no personal information. */
export function roomNameFor(bookingId: string): string {
  return `booking-${bookingId}`;
}
