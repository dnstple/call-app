/**
 * Booking persistence (Supabase mode, Stage 2D).
 *
 * Every write goes through the controlled database functions from migration
 * 0005 — the browser never supplies prices, fees, participants or statuses.
 * NO payment is taken; all money fields are server-side snapshots (estimates
 * until the payments milestone). Never falls back to mock bookings.
 */
import { getSupabaseClient } from '../supabase/client';
import type {
  BookingHistoryRow,
  BookingProposalRow,
  BookingRow,
  BookingStatus2D,
  CompletionStatePayload,
  MyBookingRow,
  SlotRow,
} from '../supabase/database.types';
import { RepoError, type RepoErrorKind } from './profileRepository';

/** Statuses that keep a slot reserved (mirrors the DB exclusion constraints). */
export const ACTIVE_BOOKING_STATUSES = ['requested', 'confirmed', 'change_proposed'] as const;

/**
 * Every conversation happens inside the app (migration 0012). This is the
 * only communication method the product stores or offers — provider-neutral
 * until a calling provider is integrated behind /calls/:bookingId.
 */
export const IN_APP_METHOD = 'in_app';

/** Rescheduling closes this long before a conversation starts. */
export const RESCHEDULE_CUTOFF_HOURS = 2;

/**
 * Display mirror of the SERVER rule (`app_private.reschedule_open`).
 * The database decides using its own clock — this only shapes the copy.
 */
export function canRescheduleBooking(
  b: Pick<MyBookingRow, 'status' | 'starts_at'>,
  now = new Date(),
): boolean {
  if (!['requested', 'confirmed', 'change_proposed'].includes(b.status)) return false;
  const cutoff = new Date(b.starts_at).getTime() - RESCHEDULE_CUTOFF_HOURS * 3600 * 1000;
  return cutoff > now.getTime();
}

export const RESCHEDULE_OPEN_COPY = 'You can change this time until two hours before the conversation.';
export const RESCHEDULE_CLOSED_COPY =
  'This conversation can no longer be rescheduled because it starts in less than two hours.';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapBookingError(e: any, fallback = 'Something went wrong. Please try again.'): RepoError {
  const msg = String(e?.message ?? '').toLowerCase();
  if (import.meta.env?.DEV) console.warn('[bookings]', e?.code ?? '', e?.message ?? '');
  if (msg.includes('slot_taken') || msg.includes('no_overlap') || msg.includes('exclusion')) {
    return new RepoError('That time has just been taken. Please choose another available time.', 'conflict');
  }
  if (msg.includes('trial_pending') || msg.includes('one_pending_trial')) {
    return new RepoError('There’s already a trial request with this companion. You can cancel it first if plans changed.', 'conflict');
  }
  if (msg.includes('outside_availability')) {
    return new RepoError('That time isn’t within the companion’s availability any more. Please pick another time.', 'conflict');
  }
  if (msg.includes('invalid_transition')) {
    return new RepoError('This conversation has already moved on — refresh to see its latest status.', 'conflict');
  }
  if (msg.includes('reschedule_closed')) {
    return new RepoError(RESCHEDULE_CLOSED_COPY, 'conflict');
  }
  if (msg.includes('cannot book for this member') || msg.includes('you cannot')) {
    return new RepoError('You don’t have permission to do that for this member.', 'unauthorised');
  }
  if (msg.includes('not accepting new members')) {
    return new RepoError('This companion isn’t accepting new members right now.', 'validation');
  }
  if (msg.includes('offer not available')) {
    return new RepoError('That conversation offer is no longer available.', 'not_found');
  }
  if (msg.includes('method is not offered')) {
    return new RepoError('That call method isn’t offered — please choose another.', 'validation');
  }
  if (msg.includes('only the companion') || msg.includes('only the requester') || msg.includes('own proposal')) {
    return new RepoError('You can’t perform this action on this booking.', 'unauthorised');
  }
  if (msg.includes('not found')) {
    return new RepoError('We couldn’t find that conversation.', 'not_found');
  }
  if (msg.includes('row-level security') || msg.includes('permission denied') || msg.includes('not authenticated')) {
    return new RepoError('You don’t have permission to do that.', 'unauthorised');
  }
  if (msg.includes('failed to fetch') || msg.includes('network')) {
    return new RepoError('We couldn’t reach the server. Please check your connection.', 'network');
  }
  return new RepoError(fallback, 'database');
}

/* ---------------- Slots ---------------- */

export interface AvailableSlot {
  startsAt: string; // UTC ISO
  endsAt: string;
}

/**
 * Exact bookable slots, generated server-side from recurring availability +
 * exceptions, minus active bookings, respecting notice and horizon.
 * Range is clamped server-side to 31 days / 200 slots.
 */
export async function getAvailableSlots(input: {
  companionProfileId: string;
  offerId: string;
  from: string;
  to: string;
}): Promise<AvailableSlot[]> {
  const { data, error } = await getSupabaseClient().rpc('get_available_slots', {
    p_companion: input.companionProfileId,
    p_offer: input.offerId,
    p_from: input.from,
    p_to: input.to,
  });
  if (error) throw mapBookingError(error, 'We couldn’t load available times.');
  return ((data ?? []) as SlotRow[]).map((s) => ({ startsAt: s.slot_start, endsAt: s.slot_end }));
}

/**
 * Client-side pagination over a server-clamped slot fetcher (31 days /
 * 200 slots per call). The SERVER still generates every slot and enforces
 * every rule — this only issues follow-up calls so the full requested
 * window is visible instead of silently stopping at the first clamp.
 * Results are deduped by start time and sorted ascending.
 */
export async function paginateSlotWindow(
  fetchPage: (from: string, to: string) => Promise<AvailableSlot[]>,
  from: string,
  to: string,
): Promise<AvailableSlot[]> {
  const PAGE_CAP = 200; // server slot cap per call
  const WINDOW_MS = 31 * 24 * 3600_000; // server date clamp per call
  const MAX_PAGES = 30; // hard safety stop
  const byStart = new Map<string, AvailableSlot>();
  let cursor = from;
  const toMs = Date.parse(to);
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await fetchPage(cursor, to);
    for (const s of batch) byStart.set(s.startsAt, s);
    const windowEnd = Math.min(toMs, Math.max(Date.parse(cursor), Date.now()) + WINDOW_MS);
    if (batch.length >= PAGE_CAP) {
      // Slot cap hit — resume just after the last generated slot.
      cursor = batch[batch.length - 1].endsAt;
    } else if (windowEnd < toMs) {
      // Date clamp hit — continue with the next 31-day window.
      cursor = new Date(windowEnd).toISOString();
    } else {
      break;
    }
  }
  return [...byStart.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** Every available slot in [from, to] — see paginateSlotWindow. */
export async function getAllAvailableSlots(input: {
  companionProfileId: string;
  offerId: string;
  from: string;
  to: string;
}): Promise<AvailableSlot[]> {
  return paginateSlotWindow(
    (from, to) => getAvailableSlots({ ...input, from, to }),
    input.from,
    input.to,
  );
}

/* ---------------- Create ---------------- */

/**
 * The ONLY way to create a booking. Price, fee, companion and actor are all
 * derived server-side — nothing money-related is sent from the browser.
 */
export async function createBookingRequest(input: {
  memberProfileId: string;
  offerId: string;
  startsAt: string;
  communicationMethod: string;
}): Promise<BookingRow> {
  const { data, error } = await getSupabaseClient().rpc('create_booking_request', {
    p_member: input.memberProfileId,
    p_offer: input.offerId,
    p_starts_at: input.startsAt,
    p_method: input.communicationMethod,
  });
  if (error) throw mapBookingError(error, 'We couldn’t send your request. Please try again.');
  return data as BookingRow;
}

/* ---------------- Reads ---------------- */

export async function getBookingById(id: string): Promise<MyBookingRow | null> {
  const { data, error } = await getSupabaseClient()
    .from('my_bookings')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw mapBookingError(error);
  return (data as MyBookingRow | null) ?? null;
}

/** Every booking this account is authorised to see (RLS scopes the view). */
export async function listMyBookings(): Promise<MyBookingRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('my_bookings')
    .select('*')
    .order('starts_at', { ascending: true });
  if (error) throw mapBookingError(error, 'We couldn’t load your conversations.');
  return (data ?? []) as MyBookingRow[];
}

/** All bookings the account can see for one profile (either side). */
export async function listBookingsForProfile(profileId: string): Promise<MyBookingRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('my_bookings')
    .select('*')
    .or(`member_profile_id.eq.${profileId},companion_profile_id.eq.${profileId}`)
    .order('starts_at', { ascending: true });
  if (error) throw mapBookingError(error, 'We couldn’t load your conversations.');
  return (data ?? []) as MyBookingRow[];
}

export function isUpcoming(b: MyBookingRow, now = new Date()): boolean {
  if (['declined', 'cancelled', 'completed', 'needs_review'].includes(b.status)) return false;
  return new Date(b.ends_at).getTime() > now.getTime();
}

/** Upcoming: active statuses whose end hasn't passed. */
export function splitBookings(rows: MyBookingRow[], now = new Date()) {
  const upcoming = rows.filter((b) => isUpcoming(b, now));
  const past = rows
    .filter((b) => !isUpcoming(b, now))
    .sort((a, z) => new Date(z.starts_at).getTime() - new Date(a.starts_at).getTime());
  return { upcoming, past };
}

/**
 * Derived display state. "Awaiting completion" is deliberately NOT a stored
 * status: a confirmed booking whose end has passed simply awaits both sides'
 * outcomes (Stage 2E1A).
 */
/**
 * Authoritative outcome-confirmation read-model (migration 0051). A booking may
 * stay `status = 'confirmed'` after the outcome is complete, so completion is
 * derived from the per-side confirmation flags — NOT from booking status alone.
 * Undefined flags (mock rows / older fixtures) fall back to "not submitted",
 * preserving the pre-0051 behaviour.
 */
export function bothOutcomesConfirmed(b: Partial<Pick<MyBookingRow, 'member_outcome_submitted' | 'companion_outcome_submitted'>>): boolean {
  return !!b.member_outcome_submitted && !!b.companion_outcome_submitted;
}
export function myOutcomeConfirmed(
  b: Partial<Pick<MyBookingRow, 'member_outcome_submitted' | 'companion_outcome_submitted' | 'your_side'>>,
): boolean {
  if (b.your_side === 'companion') return !!b.companion_outcome_submitted;
  if (b.your_side === 'member') return !!b.member_outcome_submitted;
  return false; // read-only viewer / unknown side: nothing for this user to confirm
}

export function derivedStatusLabel(b: MyBookingRow, now = new Date()): string {
  if (b.status === 'confirmed' && new Date(b.ends_at).getTime() <= now.getTime()) {
    // Derive from the authoritative per-side confirmations, never status alone.
    if (bothOutcomesConfirmed(b)) return 'Completed — confirmed by both sides';
    if (b.your_side && myOutcomeConfirmed(b)) {
      return 'Conversation ended — waiting for the other person to confirm.';
    }
    if (b.your_side) return 'Conversation ended — confirm how it went.';
    return 'Conversation ended — waiting for both sides to confirm how it went.';
  }
  const labels: Record<string, string> = {
    requested: 'Awaiting the companion’s reply',
    confirmed: 'Confirmed',
    declined: 'Declined',
    change_proposed: 'New time proposed',
    cancelled: 'Cancelled',
    completed: 'Completed — confirmed by both sides',
    needs_review: 'Being looked into by the platform',
  };
  return labels[b.status] ?? b.status;
}

export async function getBookingHistory(bookingId: string): Promise<BookingHistoryRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('booking_status_history')
    .select('*')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: true });
  if (error) throw mapBookingError(error);
  return (data ?? []) as BookingHistoryRow[];
}

export async function getPendingProposal(bookingId: string): Promise<BookingProposalRow | null> {
  const { data, error } = await getSupabaseClient()
    .from('booking_time_proposals')
    .select('*')
    .eq('booking_id', bookingId)
    .eq('status', 'pending')
    .maybeSingle();
  if (error) throw mapBookingError(error);
  return (data as BookingProposalRow | null) ?? null;
}

/* ---------------- Transitions (all server-controlled) ---------------- */

async function transition(fn: string, args: Record<string, unknown>, failure: string): Promise<BookingRow> {
  const { data, error } = await getSupabaseClient().rpc(fn as never, args as never);
  if (error) throw mapBookingError(error, failure);
  return data as unknown as BookingRow;
}

export function acceptBooking(id: string): Promise<BookingRow> {
  return transition('accept_booking', { p_booking: id }, 'We couldn’t accept this request.');
}

export function declineBooking(id: string, reason?: string): Promise<BookingRow> {
  return transition('decline_booking', { p_booking: id, p_reason: reason ?? null }, 'We couldn’t decline this request.');
}

export function cancelBooking(id: string, reason?: string): Promise<BookingRow> {
  return transition('cancel_booking', { p_booking: id, p_reason: reason ?? null }, 'We couldn’t cancel this conversation.');
}

export async function proposeBookingTime(
  id: string,
  input: { startsAt: string; message?: string },
): Promise<BookingProposalRow> {
  const { data, error } = await getSupabaseClient().rpc('propose_booking_time', {
    p_booking: id,
    p_starts_at: input.startsAt,
    p_message: input.message ?? null,
  });
  if (error) throw mapBookingError(error, 'We couldn’t propose that time.');
  return data as unknown as BookingProposalRow;
}

export function acceptTimeProposal(proposalId: string): Promise<BookingRow> {
  return transition(
    'accept_booking_time_proposal',
    { p_proposal: proposalId },
    'We couldn’t confirm that time.',
  );
}

export function rejectTimeProposal(proposalId: string): Promise<BookingRow> {
  return transition(
    'reject_booking_time_proposal',
    { p_proposal: proposalId },
    'We couldn’t decline that time.',
  );
}

/* ============================================================
 * Stage 2E1A — completion confirmations and reconciliation.
 * NO payment, credit or rating side effects.
 * ============================================================ */

export type CompletionOutcome = 'completed' | 'did_not_happen' | 'report_concern';
export type ParticipantSide = 'member' | 'companion';

export interface SideConfirmation {
  outcome: CompletionOutcome;
  note: string | null;
  submittedAt: string;
}

export interface CompletionState {
  bookingId: string;
  status: BookingStatus2D;
  endsAt: string;
  /** The side the signed-in account represents (null: read-only viewer). */
  yourSide: ParticipantSide | null;
  member: SideConfirmation | null;
  companion: SideConfirmation | null;
}

export type CompletionErrorCode =
  | 'too_early'
  | 'unauthorised'
  | 'booking_not_eligible'
  | 'already_finalised'
  | 'invalid_outcome'
  | 'needs_review'
  | 'network_failure'
  | 'unknown';

/** RepoError specialised with a stable machine-readable code. */
export class CompletionError extends RepoError {
  constructor(message: string, kind: RepoErrorKind, public readonly code: CompletionErrorCode) {
    super(message, kind);
    this.name = 'CompletionError';
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapCompletionError(e: any): CompletionError {
  const msg = String(e?.message ?? '').toLowerCase();
  if (import.meta.env?.DEV) console.warn('[completion]', e?.code ?? '', e?.message ?? '');
  if (msg.includes('too_early')) {
    return new CompletionError('This conversation hasn’t finished yet — you can confirm once it has.', 'validation', 'too_early');
  }
  if (msg.includes('already_finalised')) {
    return new CompletionError('This conversation has already been confirmed by both sides.', 'conflict', 'already_finalised');
  }
  if (msg.includes('booking_not_eligible')) {
    return new CompletionError('Only confirmed conversations can be completed.', 'validation', 'booking_not_eligible');
  }
  if (msg.includes('invalid_outcome')) {
    return new CompletionError('Please choose a valid outcome.', 'validation', 'invalid_outcome');
  }
  if (msg.includes('cannot confirm') || msg.includes('row-level security') || msg.includes('permission denied') || msg.includes('not authenticated')) {
    return new CompletionError('You don’t have permission to confirm this conversation.', 'unauthorised', 'unauthorised');
  }
  if (msg.includes('not found')) {
    return new CompletionError('We couldn’t find that conversation.', 'not_found', 'unauthorised');
  }
  if (msg.includes('failed to fetch') || msg.includes('network')) {
    return new CompletionError('We couldn’t reach the server. Please check your connection.', 'network', 'network_failure');
  }
  return new CompletionError('Something went wrong. Please try again.', 'database', 'unknown');
}

/**
 * Pure mirror of the SERVER reconciliation rules (the database is the
 * authority; this exists for display/tests):
 * - any report_concern → needs_review (immediately, even one-sided)
 * - both completed → completed
 * - both present, any other combination → needs_review
 * - otherwise → still awaiting the other side (null)
 */
export function reconcileOutcomes(
  member: CompletionOutcome | null,
  companion: CompletionOutcome | null,
): 'completed' | 'needs_review' | null {
  if (member === 'report_concern' || companion === 'report_concern') return 'needs_review';
  if (member !== null && companion !== null) {
    return member === 'completed' && companion === 'completed' ? 'completed' : 'needs_review';
  }
  return null;
}

/** Eligible for a completion outcome: confirmed AND the scheduled end passed. */
export function canConfirmCompletion(
  b: Pick<MyBookingRow, 'status' | 'ends_at'> &
    Partial<Pick<MyBookingRow, 'member_outcome_submitted' | 'companion_outcome_submitted' | 'your_side'>>,
  now = new Date(),
): boolean {
  // The viewer may confirm ONLY while their own side's outcome is missing.
  return b.status === 'confirmed'
    && new Date(b.ends_at).getTime() <= now.getTime()
    && !myOutcomeConfirmed(b);
}

function payloadToState(p: CompletionStatePayload): CompletionState {
  const side = (s: CompletionStatePayload['member']): SideConfirmation | null =>
    s ? { outcome: s.outcome, note: s.note, submittedAt: s.submitted_at } : null;
  return {
    bookingId: p.booking_id,
    status: p.status,
    endsAt: p.ends_at,
    yourSide: p.your_side,
    member: side(p.member),
    companion: side(p.companion),
  };
}

export async function getCompletionState(bookingId: string): Promise<CompletionState> {
  const { data, error } = await getSupabaseClient().rpc('get_completion_state', {
    p_booking: bookingId,
  });
  if (error) throw mapCompletionError(error);
  return payloadToState(data as CompletionStatePayload);
}

/**
 * Record this account's side of the outcome. The SIDE IS NEVER SENT —
 * the server derives it from auth.uid(), reconciles both outcomes
 * atomically and audits any status change.
 */
export async function submitCompletionOutcome(
  bookingId: string,
  outcome: CompletionOutcome,
  note?: string,
): Promise<CompletionState> {
  const { data, error } = await getSupabaseClient().rpc('submit_completion_confirmation', {
    p_booking: bookingId,
    p_outcome: outcome,
    p_note: note ?? null,
  });
  if (error) throw mapCompletionError(error);
  return payloadToState(data as CompletionStatePayload);
}

/** Ended, still-confirmed conversations involving this profile. */
export async function listBookingsNeedingConfirmation(profileId: string): Promise<MyBookingRow[]> {
  const rows = await listBookingsForProfile(profileId);
  const now = new Date();
  return rows.filter((b) => canConfirmCompletion(b, now));
}
