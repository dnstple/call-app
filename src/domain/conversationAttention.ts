/**
 * Conversations redesign — role-aware attention classification.
 *
 * A conversation belongs in "Needs your attention" ONLY when the
 * currently authenticated user has a clear action they can perform NOW.
 * Waiting for the other party is a STATUS, never attention:
 *
 *  - member-side (Coordinator/Member) with status 'requested' is
 *    "Awaiting reply" — the Companion must act, not us;
 *  - a Companion with status 'requested' must Accept / Suggest / Decline
 *    → attention;
 *  - 'change_proposed' requires the receiving side's response → attention
 *    (the row-level proposal detail decides acceptance; at list level the
 *    conversation cannot proceed until someone answers);
 *  - an ended-but-unconfirmed conversation needs THIS user's outcome
 *    confirmation → attention for whichever side hasn't confirmed;
 *  - 'needs_review' is blocked and needs a decision → attention.
 *
 * The classifier is pure and fully unit-tested; the page renders whatever
 * it returns and never invents its own rules.
 */
import type { MyBookingRow } from '../supabase/database.types';
import { canConfirmCompletion } from '../repositories/bookingRepository';

export type ViewerRole = 'coordinator' | 'member' | 'companion';

export type AttentionKind =
  | 'respond_to_request'   // Companion: new booking request
  | 'review_proposal'      // a proposed time change awaits this side's answer
  | 'confirm_outcome'      // ended conversation needs this user's confirmation
  | 'blocked';             // needs_review / cannot proceed

export interface AttentionState {
  required: boolean;
  kind?: AttentionKind;
  /** Short human reason, ready for the attention panel. */
  reason?: string;
  /** Label for the row's primary action button. */
  action?: string;
}

const NONE: AttentionState = { required: false };

export function requiresCurrentUserAction(
  booking: MyBookingRow,
  role: ViewerRole,
  now: Date = new Date(),
): AttentionState {
  // Ended-but-unconfirmed: the user can confirm the outcome right now.
  if (canConfirmCompletion(booking, now)) {
    return {
      required: true,
      kind: 'confirm_outcome',
      reason: 'This conversation has ended — confirm how it went.',
      action: 'Confirm outcome',
    };
  }

  switch (booking.status) {
    case 'requested':
      // Only the COMPANION can act on a new request. The requester side
      // is simply waiting — that is a status, not attention.
      return role === 'companion'
        ? {
            required: true,
            kind: 'respond_to_request',
            reason: 'A new booking request needs your response.',
            action: 'Respond',
          }
        : NONE;
    case 'change_proposed':
      return {
        required: true,
        kind: 'review_proposal',
        reason: 'A new time has been proposed and needs a response.',
        action: 'Review change',
      };
    case 'needs_review':
      return {
        required: true,
        kind: 'blocked',
        reason: 'This conversation cannot proceed until it is reviewed.',
        action: 'Open',
      };
    default:
      // confirmed / completed / cancelled / declined: nothing for the
      // current user to do from the schedule.
      return NONE;
  }
}

/** All bookings needing THIS user's action, soonest first. */
export function attentionItems(
  rows: MyBookingRow[],
  role: ViewerRole,
  now: Date = new Date(),
): { booking: MyBookingRow; state: AttentionState }[] {
  return rows
    .map((booking) => ({ booking, state: requiresCurrentUserAction(booking, role, now) }))
    .filter((x) => x.state.required)
    .sort((a, b) => a.booking.starts_at.localeCompare(b.booking.starts_at));
}
