/**
 * Stage 2F1 — provider-neutral calling boundary (now implemented).
 *
 * Pages talk to this surface; the LiveKit specifics live in
 * src/calls/livekit.ts and never leak into unrelated pages. Swapping the
 * provider later means re-implementing livekit.ts and the livekit-token
 * Edge Function — nothing else.
 *
 * Integration rules (enforced by the Edge Function):
 * - join tokens are minted SERVER-side for authorised booking participants
 *   only, scoped to the booking's room and time window; the browser never
 *   holds provider secrets and cannot choose rooms or identities;
 * - joining or leaving a call never changes booking state — completion
 *   remains the two-sided confirmation flow (Stage 2E1A);
 * - no provider identifiers are stored on bookings.
 */
import {
  connectCall,
  listDevices,
  prepareSession,
  startPreview,
  type ActiveCall,
  type ActiveCallHandlers,
  type CallConnectionState,
  type MediaDeviceOption,
  type PreparedSession,
  type PreviewHandle,
} from './livekit';
import {
  ROOM_CLOSE_AFTER_END_MINUTES,
  WAITING_ROOM_OPEN_MINUTES,
} from './joinRules';

export type {
  ActiveCall,
  ActiveCallHandlers,
  CallConnectionState,
  MediaDeviceOption,
  PreparedSession,
  PreviewHandle,
};

/**
 * The provider surface. prepareSession asks the server for permission and
 * a token; connect joins with the user's explicit device choices — never
 * automatically on page load.
 */
export const callProvider = {
  prepareSession,
  connect: connectCall,
  startPreview,
  listDevices,
};

/** Minutes before the scheduled start when the waiting room opens. */
export const CALL_JOIN_WINDOW_MINUTES = WAITING_ROOM_OPEN_MINUTES;

export type CallWindowState = 'before' | 'open' | 'ended';

/** Where a booking sits relative to the waiting-room window (page state;
 * the media window itself is enforced server-side — see joinRules.ts). */
export function callWindowState(
  startsAt: string,
  endsAt: string,
  now: Date = new Date(),
): CallWindowState {
  const open = Date.parse(startsAt) - CALL_JOIN_WINDOW_MINUTES * 60_000;
  const close = Date.parse(endsAt) + ROOM_CLOSE_AFTER_END_MINUTES * 60_000;
  if (now.getTime() < open) return 'before';
  if (now.getTime() <= close) return 'open';
  return 'ended';
}

/** @deprecated 2F1: the real provider exists; kept for older imports. */
export const placeholderCallProvider = {
  async createSession(): Promise<never> {
    throw new Error('In-app calling is not integrated yet.');
  },
  async joinSession(): Promise<never> {
    throw new Error('In-app calling is not integrated yet.');
  },
  async leaveSession(): Promise<void> {
    // nothing to leave
  },
};
