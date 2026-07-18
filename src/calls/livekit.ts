/**
 * Stage 2F1 — the LiveKit implementation of the CallProvider boundary.
 *
 * All LiveKit-specific objects stay inside src/calls; pages interact with
 * the provider-neutral surface (prepareSession / connect / disconnect /
 * toggleMicrophone / toggleCamera / switchDevice / getConnectionState).
 *
 * Credentials never touch this file: prepareSession asks the
 * livekit-token Edge Function, which verifies the session, authorises the
 * participant against the booking (RLS) and mints a short-lived token for
 * the server-derived room. The browser cannot choose rooms or identities.
 */
import {
  createLocalTracks,
  Room,
  RoomEvent,
  Track,
  type LocalTrack,
  type RemoteParticipant,
  type RemoteTrack,
} from 'livekit-client';
import { getSupabaseClient } from '../supabase/client';
import type { JoinState } from './joinRules';

/* ---------------- session preparation (token service) ---------------- */

export interface PreparedSession {
  state: JoinState;
  serverUrl?: string;
  token?: string;
  room?: string;
  opensAt?: string;
  /** Present when the server declined for a configuration reason. */
  reason?: string;
  bookingId?: string;
  startsAt?: string;
  endsAt?: string;
  timezone?: string;
  durationMinutes?: number;
  memberName?: string;
  companionName?: string;
  viewerSide?: 'member' | 'companion';
}

/** Ask the server for permission to join. Only the bookingId is sent. */
export async function prepareSession(bookingId: string): Promise<PreparedSession> {
  const { data, error } = await getSupabaseClient().functions.invoke('livekit-token', {
    body: { bookingId },
  });
  if (error || !data) {
    // The function answers unauthorised/ineligible with typed states; a
    // transport error here means we truly couldn't ask.
    throw new Error('We couldn’t check your conversation. Please try again.');
  }
  return data as PreparedSession;
}

/** Redesign Phase C — guest exchange: invitation token + access code in,
 * restricted short-lived room token out. Anonymous by design; the server
 * enforces hashing, expiry, revocation and attempt rate limits. */
export async function prepareGuestSession(
  invitationToken: string,
  accessCode: string,
): Promise<PreparedSession & { state: PreparedSession['state'] | 'invalid' | 'wrong_code' | 'rate_limited' }> {
  const { data, error } = await getSupabaseClient().functions.invoke('livekit-token', {
    body: { invitationToken, accessCode },
  });
  if (error || !data) {
    throw new Error('We couldn’t check your invitation. Please try again.');
  }
  return data as PreparedSession & { state: 'invalid' };
}

/* ---------------- devices ---------------- */

export interface MediaDeviceOption {
  deviceId: string;
  label: string;
}

export async function listDevices(kind: 'audioinput' | 'videoinput'): Promise<MediaDeviceOption[]> {
  try {
    const devices = await Room.getLocalDevices(kind);
    return devices.map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || (kind === 'audioinput' ? `Microphone ${i + 1}` : `Camera ${i + 1}`),
    }));
  } catch {
    return [];
  }
}

/* ---------------- pre-join preview (local only, never connected) ---------------- */

export interface PreviewHandle {
  attachVideo(el: HTMLVideoElement): void;
  stop(): void;
  hasVideo: boolean;
  hasAudio: boolean;
}

/**
 * Local device preview for the pre-join screen. Nothing connects to any
 * room; tracks are created locally and MUST be stopped via stop().
 */
export async function startPreview(options: {
  audio: boolean;
  video: boolean;
  audioDeviceId?: string;
  videoDeviceId?: string;
}): Promise<PreviewHandle> {
  const tracks: LocalTrack[] = await createLocalTracks({
    audio: options.audio ? { deviceId: options.audioDeviceId } : false,
    video: options.video ? { deviceId: options.videoDeviceId } : false,
  });
  const videoTrack = tracks.find((t) => t.kind === Track.Kind.Video);
  const audioTrack = tracks.find((t) => t.kind === Track.Kind.Audio);
  return {
    hasVideo: Boolean(videoTrack),
    hasAudio: Boolean(audioTrack),
    attachVideo(el: HTMLVideoElement) {
      videoTrack?.attach(el);
    },
    stop() {
      for (const t of tracks) {
        t.detach();
        t.stop();
      }
    },
  };
}

/* ---------------- the active call ---------------- */

export type CallConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

export interface ActiveCallHandlers {
  onConnectionState(state: CallConnectionState): void;
  onRemoteJoined(name: string): void;
  onRemoteLeft(): void;
  /** A remote audio/video track arrived — attach it to the given element. */
  onRemoteTrack(track: { attach(el: HTMLMediaElement): void; kind: 'audio' | 'video' }): void;
  onError(message: string): void;
}

export interface ActiveCall {
  disconnect(): Promise<void>;
  toggleMicrophone(enabled: boolean): Promise<void>;
  toggleCamera(enabled: boolean): Promise<void>;
  switchDevice(kind: 'audioinput' | 'videoinput', deviceId: string): Promise<void>;
  getConnectionState(): CallConnectionState;
  attachLocalVideo(el: HTMLVideoElement): void;
  /** Safe display name of the other person, once known. */
  remoteName(): string | null;
}

function safeParticipantName(p: RemoteParticipant): string {
  // The server sets name to "First L." — never fall back to the LiveKit
  // identity string, which encodes profile ids.
  return p.name && p.name.trim().length > 0 ? p.name : 'Your conversation partner';
}

/**
 * Connect to the prepared room. The user has already pressed "Join" —
 * nothing in this module connects automatically on page load.
 */
export async function connectCall(
  prepared: PreparedSession,
  options: { audioEnabled: boolean; videoEnabled: boolean; audioDeviceId?: string; videoDeviceId?: string },
  handlers: ActiveCallHandlers,
): Promise<ActiveCall> {
  if (prepared.state !== 'joinable' || !prepared.serverUrl || !prepared.token) {
    throw new Error('This conversation isn’t ready to join.');
  }
  const room = new Room({ adaptiveStream: true, dynacast: true });
  let state: CallConnectionState = 'connecting';
  const setState = (s: CallConnectionState) => {
    state = s;
    handlers.onConnectionState(s);
  };

  room
    .on(RoomEvent.Reconnecting, () => setState('reconnecting'))
    .on(RoomEvent.Reconnected, () => setState('connected'))
    .on(RoomEvent.Disconnected, () => setState('disconnected'))
    .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
      handlers.onRemoteJoined(safeParticipantName(p));
    })
    .on(RoomEvent.ParticipantDisconnected, () => handlers.onRemoteLeft())
    .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio || track.kind === Track.Kind.Video) {
        handlers.onRemoteTrack({
          attach: (el) => track.attach(el),
          kind: track.kind === Track.Kind.Audio ? 'audio' : 'video',
        });
      }
    });

  setState('connecting');
  try {
    await room.connect(prepared.serverUrl, prepared.token, { autoSubscribe: true });
  } catch {
    setState('disconnected');
    throw new Error('We couldn’t connect to the conversation. Please check your internet and try again.');
  }
  setState('connected');

  // Publish only what the user chose on the pre-join screen. Camera being
  // unavailable must never block an audio-only conversation.
  try {
    await room.localParticipant.setMicrophoneEnabled(options.audioEnabled, {
      deviceId: options.audioDeviceId,
    });
  } catch {
    handlers.onError('We couldn’t use your microphone. Check your browser permissions.');
  }
  if (options.videoEnabled) {
    try {
      await room.localParticipant.setCameraEnabled(true, { deviceId: options.videoDeviceId });
    } catch {
      handlers.onError('We couldn’t use your camera, so you’re joining with audio only.');
    }
  }

  // Anyone already in the room counts as present.
  for (const p of room.remoteParticipants.values()) {
    handlers.onRemoteJoined(safeParticipantName(p));
  }

  return {
    getConnectionState: () => state,
    remoteName: () => {
      const first = [...room.remoteParticipants.values()][0];
      return first ? safeParticipantName(first) : null;
    },
    attachLocalVideo(el: HTMLVideoElement) {
      const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      pub?.track?.attach(el);
    },
    async toggleMicrophone(enabled: boolean) {
      try {
        await room.localParticipant.setMicrophoneEnabled(enabled);
      } catch {
        handlers.onError('We couldn’t change your microphone. Check your browser permissions.');
      }
    },
    async toggleCamera(enabled: boolean) {
      try {
        await room.localParticipant.setCameraEnabled(enabled);
      } catch {
        handlers.onError('We couldn’t change your camera. Check your browser permissions.');
      }
    },
    async switchDevice(kind, deviceId) {
      try {
        await room.switchActiveDevice(kind, deviceId);
      } catch {
        handlers.onError('We couldn’t switch to that device.');
      }
    },
    async disconnect() {
      // Stop local capture first so camera lights go off immediately.
      try {
        await room.localParticipant.setCameraEnabled(false);
        await room.localParticipant.setMicrophoneEnabled(false);
      } catch {
        // device may already be gone
      }
      await room.disconnect();
      setState('disconnected');
    },
  };
}
