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
  MyBookingRow,
  SlotRow,
} from '../supabase/database.types';
import { RepoError } from './profileRepository';

/** Statuses that keep a slot reserved (mirrors the DB exclusion constraints). */
export const ACTIVE_BOOKING_STATUSES = ['requested', 'confirmed', 'change_proposed'] as const;

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
  if (b.status === 'declined' || b.status === 'cancelled') return false;
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

/** Derived display state — completion persistence arrives in a later stage. */
export function derivedStatusLabel(b: MyBookingRow, now = new Date()): string {
  if (b.status === 'confirmed' && new Date(b.ends_at).getTime() <= now.getTime()) {
    return 'Conversation ended — confirmation will be added in a later stage.';
  }
  const labels: Record<string, string> = {
    requested: 'Awaiting the companion’s reply',
    confirmed: 'Confirmed',
    declined: 'Declined',
    change_proposed: 'New time proposed',
    cancelled: 'Cancelled',
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
