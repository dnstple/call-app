/**
 * Stage 3A — audio-only call adapter (provider-neutral surface).
 *
 * All LiveKit specifics stay in this module; the CallPage talks only to this
 * surface, so it can be unit-tested with a mocked adapter and no real media.
 * AUDIO ONLY: the microphone is the sole publish source. No camera, no
 * screen-share, no data channel, no recording. Nothing connects on import or on
 * page load — connection happens only after the user presses Join.
 */
import {
  ConnectionQuality,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';
import type { CallTokenResult } from '../repositories/callRepository';

export interface MicOption { deviceId: string; label: string }

export async function listMicrophones(): Promise<MicOption[]> {
  try {
    const devices = await Room.getLocalDevices('audioinput');
    return devices.map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  } catch {
    return [];
  }
}

export type AudioConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export type AudioQuality = 'excellent' | 'good' | 'poor' | 'unknown';

export interface AudioCallHandlers {
  onState(state: AudioConnectionState): void;
  onRemotePresence(connected: boolean, name: string | null): void;
  onRemoteMuted(muted: boolean): void;
  onQuality(quality: AudioQuality): void;
  onError(message: string): void;
  /** Browser autoplay blocked remote audio; call the provided resume() from a click. */
  onNeedsAudioStart(resume: () => Promise<void>): void;
}

export interface ActiveAudioCall {
  disconnect(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  switchMic(deviceId: string): Promise<void>;
  state(): AudioConnectionState;
  remoteConnected(): boolean;
  remoteName(): string | null;
}

function safeName(p: RemoteParticipant): string {
  return p.name && p.name.trim().length > 0 ? p.name : 'Your conversation partner';
}
function mapQuality(q: ConnectionQuality): AudioQuality {
  if (q === ConnectionQuality.Excellent) return 'excellent';
  if (q === ConnectionQuality.Good) return 'good';
  if (q === ConnectionQuality.Poor) return 'poor';
  return 'unknown';
}

/** Connect the prepared audio session. The user has already pressed Join. */
export async function connectAudioCall(
  prepared: CallTokenResult,
  options: { deviceId?: string; mutedOnEntry: boolean },
  handlers: AudioCallHandlers,
): Promise<ActiveAudioCall> {
  if (!prepared.ok || !prepared.serverUrl || !prepared.token) {
    throw new Error('This call isn’t ready to join.');
  }
  const room = new Room({ adaptiveStream: false, dynacast: false });
  let state: AudioConnectionState = 'connecting';
  const audioEls = new Set<HTMLAudioElement>();
  const setState = (s: AudioConnectionState) => { state = s; handlers.onState(s); };

  const attachRemoteAudio = (track: RemoteTrack) => {
    if (track.kind !== Track.Kind.Audio) return; // audio only — ignore anything else
    const el = track.attach() as HTMLAudioElement;
    el.setAttribute('data-call-audio', 'true');
    el.style.display = 'none';
    document.body.appendChild(el);
    audioEls.add(el);
  };

  room
    .on(RoomEvent.Reconnecting, () => setState('reconnecting'))
    .on(RoomEvent.Reconnected, () => setState('connected'))
    .on(RoomEvent.Disconnected, () => setState('disconnected'))
    .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => handlers.onRemotePresence(true, safeName(p)))
    .on(RoomEvent.ParticipantDisconnected, () => handlers.onRemotePresence(false, null))
    .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => attachRemoteAudio(track))
    .on(RoomEvent.TrackMuted, (_pub, p) => { if (p !== room.localParticipant) handlers.onRemoteMuted(true); })
    .on(RoomEvent.TrackUnmuted, (_pub, p) => { if (p !== room.localParticipant) handlers.onRemoteMuted(false); })
    .on(RoomEvent.ConnectionQualityChanged, (q, p) => { if (p === room.localParticipant) handlers.onQuality(mapQuality(q)); })
    .on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (!room.canPlaybackAudio) handlers.onNeedsAudioStart(() => room.startAudio());
    });

  setState('connecting');
  try {
    await room.connect(prepared.serverUrl, prepared.token, { autoSubscribe: true });
  } catch {
    setState('disconnected');
    throw new Error('We couldn’t connect to the call. Please check your internet and try again.');
  }
  setState('connected');

  // Publish the microphone only. Never a camera.
  try {
    await room.localParticipant.setMicrophoneEnabled(!options.mutedOnEntry, { deviceId: options.deviceId });
  } catch {
    handlers.onError('We couldn’t use your microphone. Check your browser permissions.');
  }

  // Anyone already present + their existing audio tracks.
  for (const p of room.remoteParticipants.values()) {
    handlers.onRemotePresence(true, safeName(p));
    for (const pub of p.trackPublications.values()) {
      const rp = pub as RemoteTrackPublication;
      if (rp.track) attachRemoteAudio(rp.track);
    }
  }

  return {
    state: () => state,
    remoteConnected: () => room.remoteParticipants.size > 0,
    remoteName: () => {
      const first = [...room.remoteParticipants.values()][0];
      return first ? safeName(first) : null;
    },
    async setMuted(muted: boolean) {
      try { await room.localParticipant.setMicrophoneEnabled(!muted); }
      catch { handlers.onError('We couldn’t change your microphone. Check your browser permissions.'); }
    },
    async switchMic(deviceId: string) {
      try { await room.switchActiveDevice('audioinput', deviceId); }
      catch { handlers.onError('We couldn’t switch to that microphone.'); }
    },
    async disconnect() {
      try { await room.localParticipant.setMicrophoneEnabled(false); } catch { /* device may be gone */ }
      await room.disconnect();
      for (const el of audioEls) { try { el.remove(); } catch { /* noop */ } }
      audioEls.clear();
      setState('disconnected');
    },
  };
}
