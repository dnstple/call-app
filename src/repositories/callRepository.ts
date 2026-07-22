/**
 * Stage 3A — call repository.
 *
 * The provider-neutral data surface for secure audio calls. Eligibility and
 * call-state come from server RPCs (server clock + server-derived role); the
 * token comes from the livekit-token Edge Function (booking_id in, short-lived
 * mic-only token out). Mock mode NEVER touches Supabase or LiveKit — it returns
 * a deterministic, always-eligible fixture so the whole flow is demonstrable
 * offline without minting a real token.
 */
import { getSupabaseClient } from '../supabase/client';
import { isSupabaseMode } from '../config/dataMode';

/* The 0064 RPCs are not in the generated types until the migration is applied
 * and types are regenerated; use an untyped accessor (same pattern as the other
 * post-0063 repositories). */
/* eslint-disable @typescript-eslint/no-explicit-any */
type UntypedRpc = { rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: unknown }> };
function db(): UntypedRpc { return getSupabaseClient() as unknown as UntypedRpc; }

export type EligibilityReason =
  | 'ok' | 'unauthenticated' | 'not_found' | 'not_confirmed'
  | 'too_early' | 'join_window_closed' | 'coordinator_not_permitted' | 'call_closed';

export interface CallEligibility {
  eligible: boolean;
  reason: EligibilityReason;
  your_role?: 'member' | 'companion' | 'observer';
  opens_at?: string;
  closes_at?: string;
  scheduled_start?: string;
  scheduled_end?: string;
  call_session_id?: string | null;
}

export interface CallState {
  your_role: 'member' | 'companion' | 'observer';
  booking_status: string;
  call_state: 'none' | 'pending' | 'active' | 'ended' | 'failed';
  scheduled_start: string;
  scheduled_end: string;
  both_connected_at: string | null;
  other_participant_connected: boolean;
}

/** Result of the token request (Stage 3A contract). */
export interface CallTokenResult {
  ok: boolean;
  error?: string;
  reason?: string;
  token?: string;
  serverUrl?: string;
  callSessionId?: string;
  expiresAt?: string;
  role?: 'member' | 'companion';
  opensAt?: string;
  closesAt?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
}

export class CallError extends Error {}

/** Authoritative eligibility for joining a booking's call. */
export async function getCallEligibility(bookingId: string): Promise<CallEligibility> {
  if (!isSupabaseMode()) {
    const start = new Date(Date.now() - 60_000).toISOString();
    const end = new Date(Date.now() + 29 * 60_000).toISOString();
    return {
      eligible: true, reason: 'ok', your_role: 'member',
      opens_at: new Date(Date.now() - 11 * 60_000).toISOString(),
      closes_at: new Date(Date.now() + 59 * 60_000).toISOString(),
      scheduled_start: start, scheduled_end: end, call_session_id: 'mock-session',
    };
  }
  const { data, error } = await db().rpc('call_join_eligibility', { p_booking: bookingId });
  if (error || !data) throw new CallError('We couldn’t check this call. Please try again.');
  return data as CallEligibility;
}

/** Safe call state for a booking (hides room/provider diagnostics). */
export async function getCallState(bookingId: string): Promise<CallState | null> {
  if (!isSupabaseMode()) return null;
  const { data, error } = await db().rpc('call_state_for_booking', { p_booking: bookingId });
  if (error || !data) return null;
  return data as CallState;
}

/**
 * Request a short-lived, microphone-only token. Only bookingId is sent; the
 * server derives room, identity, role, permissions and TTL. The token is held
 * in memory by the caller and never persisted here.
 */
export async function requestCallToken(bookingId: string): Promise<CallTokenResult> {
  const { data, error } = await getSupabaseClient().functions.invoke('livekit-token', {
    body: { bookingId },
  });
  if (error || !data) throw new CallError('We couldn’t reach the call service. Please try again.');
  const d = data as Record<string, unknown>;
  if (typeof d.token === 'string' && typeof d.serverUrl === 'string') {
    return { ok: true, ...(d as object) } as CallTokenResult;
  }
  return { ok: false, error: (d.error as string) ?? 'not_eligible', reason: d.reason as string,
    opensAt: d.opensAt as string, closesAt: d.closesAt as string,
    scheduledStart: d.scheduledStart as string, scheduledEnd: d.scheduledEnd as string };
}
