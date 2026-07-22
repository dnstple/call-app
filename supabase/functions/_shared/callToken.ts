/**
 * Stage 3A — shared call-token contract (runtime-agnostic).
 *
 * Imported BOTH by the Supabase Edge Function (Deno) and by the Node/vitest
 * unit tests, so the security-critical token shape is defined and tested in
 * exactly ONE place. This module is intentionally dependency-free: it never
 * imports the LiveKit SDK, Deno APIs or Supabase — only pure values.
 *
 * The Edge Function feeds `buildCallGrant()` into the official
 * `AccessToken.addGrant()` (mapping the microphone source string to the SDK's
 * TrackSource enum); the resulting JWT `video` claim is byte-equivalent to the
 * object returned here.
 */

/** Short-lived: enough to establish the initial connection, not the call length. */
export const TOKEN_TTL_SECONDS = 10 * 60; // 10 minutes

/** Server-controlled join window (single source of truth; mirrored client-side for countdowns only). */
export const JOIN_OPENS_BEFORE_START_MINUTES = 10;
export const JOIN_CLOSES_AFTER_END_MINUTES = 30;

/**
 * Participant identity is ALWAYS derived from the authenticated account — never
 * from the browser. `account:<uuid>` is opaque and carries no personal data.
 */
export function participantIdentity(accountId: string): string {
  return `account:${accountId}`;
}

/** Reverse of participantIdentity: extract the account id from a provider identity. */
export function accountIdFromIdentity(identity: string): string | null {
  const m = /^account:([0-9a-fA-F-]{36})$/.exec(identity ?? '');
  return m ? m[1] : null;
}

/**
 * The narrowest possible grant for a one-to-one AUDIO call:
 *  - join exactly one server-derived room;
 *  - subscribe + publish audio only (microphone source);
 *  - no data channel, no camera, no screen-share;
 *  - no room create/list/admin, no recording, no ingress/egress/SIP.
 *
 * `canPublishSources` is the string `'microphone'`; the Edge Function maps it
 * to `TrackSource.MICROPHONE` before handing it to the SDK.
 */
export function buildCallGrant(roomName: string): {
  roomJoin: boolean;
  room: string;
  canSubscribe: boolean;
  canPublish: boolean;
  canPublishData: boolean;
  canPublishSources: string[];
  canUpdateOwnMetadata: boolean;
  roomCreate: boolean;
  roomList: boolean;
  roomAdmin: boolean;
  roomRecord: boolean;
  ingressAdmin: boolean;
} {
  return {
    roomJoin: true,
    room: roomName,
    canSubscribe: true,
    canPublish: true,
    canPublishData: false,
    canPublishSources: ['microphone'],
    canUpdateOwnMetadata: false,
    roomCreate: false,
    roomList: false,
    roomAdmin: false,
    roomRecord: false,
    ingressAdmin: false,
  };
}

/** Safe, structured error codes returned by the token endpoint (never raw SDK/DB text). */
export type CallTokenError =
  | 'unauthenticated'
  | 'not_found'
  | 'not_eligible'
  | 'too_early'
  | 'join_window_closed'
  | 'configuration_missing'
  | 'token_generation_failed';
