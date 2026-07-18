/**
 * Stage 2E4D — provider-neutral calling boundary. NOT an implementation.
 *
 * /calls/:bookingId renders around this interface; when a real provider
 * (LiveKit, Daily, Twilio…) is chosen, only an implementation of
 * CallProvider and its server-side token endpoint are added — no booking
 * logic changes.
 *
 * Integration rules (see also ARCHITECTURE.md):
 * - join tokens are minted SERVER-side for authorised booking participants
 *   only, scoped to the booking's time window; the browser never holds
 *   provider secrets;
 * - joining or leaving a call must not change booking state — completion
 *   remains the two-sided confirmation flow (Stage 2E1A);
 * - no provider identifiers are stored on bookings until the milestone
 *   genuinely lands.
 */

export interface CallSession {
  /** Provider session/room identifier (opaque to the app). */
  readonly id: string;
  /** Detach the local participant and release devices. */
  leave(): Promise<void>;
}

export interface CallProvider {
  /** Ask the SERVER to create (or fetch) the session for a booking. */
  createSession(bookingId: string): Promise<{ sessionId: string; joinToken: string }>;
  /** Join with a server-minted token, rendering into the given element. */
  joinSession(target: HTMLElement, joinToken: string): Promise<CallSession>;
  /** Leave and clean up. Safe to call twice. */
  leaveSession(session: CallSession): Promise<void>;
}

/** Minutes before the scheduled start when joining becomes possible. */
export const CALL_JOIN_WINDOW_MINUTES = 10;

export type CallWindowState = 'before' | 'open' | 'ended';

/** Where a booking sits relative to its (future) join window. */
export function callWindowState(
  startsAt: string,
  endsAt: string,
  now: Date = new Date(),
): CallWindowState {
  const open = new Date(startsAt).getTime() - CALL_JOIN_WINDOW_MINUTES * 60_000;
  if (now.getTime() < open) return 'before';
  if (now.getTime() <= new Date(endsAt).getTime()) return 'open';
  return 'ended';
}

/**
 * The only provider that exists today. It is honest about that: nothing
 * connects, and the UI copy says so.
 */
export const placeholderCallProvider: CallProvider = {
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
