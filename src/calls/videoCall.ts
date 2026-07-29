/**
 * Sprint v1 (Block 1) — audio/VIDEO call adapter (provider-neutral surface).
 *
 * Extends the Stage 3A audio foundation with an OPTIONAL camera. All LiveKit
 * specifics stay in this module so the call page talks to a mockable surface
 * and unit tests need no real media. Reuses the same authenticated Room model,
 * opaque tokens (CallTokenResult), participant identities and connection/
 * quality/recovery semantics as audioCall.ts. Still: no screen-share, no data
 * channel, no recording, no group calls. Nothing connects on import — only
 * after the user presses Join.
 */
import {
  ConnectionQuality,
  Room,
  RoomEvent,
  Track,
  type LocalVideoTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';
import type { CallTokenResult } from '../repositories/callRepository';

export interface DeviceOption { deviceId: string; label: string }

async function listDevices(kind: MediaDeviceKind, fallback: string): Promise<DeviceOption[]> {
  try {
    const devices = await Room.getLocalDevices(kind);
    return devices.map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
  } catch {
    return [];
  }
}
export const listMicrophones = () => listDevices('audioinput', 'Microphone');
export const listCameras = () => listDevices('videoinput', 'Camera');
export const listSpeakers = () => listDevices('audiooutput', 'Speaker');

export type VideoConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export type VideoQuality = 'excellent' | 'good' | 'poor' | 'unknown';

export interface VideoCallHandlers {
  onState(state: VideoConnectionState): void;
  onRemotePresence(connected: boolean, name: string | null): void;
  onRemoteMuted(muted: boolean): void;
  onQuality(quality: VideoQuality): void;
  onError(message: string): void;
  /** Browser autoplay blocked remote audio; call resume() from a click. */
  onNeedsAudioStart(resume: () => Promise<void>): void;
  /** Remote camera track arrived/left — the UI attaches/detaches the element. */
  onRemoteVideo(el: HTMLVideoElement | null): void;
  /** Local camera enabled/disabled reflected back for the mirror preview. */
  onLocalVideo(el: HTMLVideoElement | null): void;
  /** A local device (camera/mic) was lost mid-call. */
  onLocalDeviceLost(kind: 'camera' | 'microphone'): void;
}

export interface ActiveVideoCall {
  disconnect(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setCameraEnabled(on: boolean): Promise<void>;
  cameraEnabled(): boolean;
  switchMic(deviceId: string): Promise<void>;
  switchCamera(deviceId: string): Promise<void>;
  switchSpeaker(deviceId: string): Promise<void>;
  state(): VideoConnectionState;
  remoteConnected(): boolean;
  remoteName(): string | null;
}

function safeName(p: RemoteParticipant): string {
  return p.name && p.name.trim().length > 0 ? p.name : 'Your conversation partner';
}
function mapQuality(q: ConnectionQuality): VideoQuality {
  if (q === ConnectionQuality.Excellent) return 'excellent';
  if (q === ConnectionQuality.Good) return 'good';
  if (q === ConnectionQuality.Poor) return 'poor';
  return 'unknown';
}

/** Connect the prepared session with optional camera. */
export async function connectVideoCall(
  prepared: CallTokenResult,
  options: { micDeviceId?: string; cameraDeviceId?: string; mutedOnEntry: boolean; cameraOnEntry: boolean },
  handlers: VideoCallHandlers,
): Promise<ActiveVideoCall> {
  if (!prepared.ok || !prepared.serverUrl || !prepared.token) {
    throw new Error('This call isn’t ready to join.');
  }
  // 1:1 call: adaptiveStream is deliberately OFF. With adaptiveStream ON,
  // LiveKit pauses a remote video track whenever its attached element isn't
  // visibly sized yet — a very common cause of a permanently BLACK canvas when
  // the element is attached a frame before layout settles. For a two-person
  // call the bandwidth saving is negligible, so we take the always-on behaviour.
  // dynacast stays off too (no SFU simulcast fan-out needed for 1:1).
  const room = new Room({ adaptiveStream: false, dynacast: false });
  let state: VideoConnectionState = 'connecting';
  let cameraOn = false;
  const audioEls = new Set<HTMLAudioElement>();
  const setState = (s: VideoConnectionState) => { state = s; handlers.onState(s); };

  const attachRemote = (track: RemoteTrack) => {
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach() as HTMLAudioElement;
      el.setAttribute('data-call-audio', 'true');
      el.style.display = 'none';
      document.body.appendChild(el);
      audioEls.add(el);
    } else if (track.kind === Track.Kind.Video) {
      const el = track.attach() as HTMLVideoElement;
      el.setAttribute('data-call-remote-video', 'true');
      // Without playsInline + autoplay a mobile/Safari browser renders a black
      // frame (or tries to go fullscreen) instead of the live remote video.
      el.autoplay = true;
      el.playsInline = true;
      handlers.onRemoteVideo(el);
    }
  };

  room
    .on(RoomEvent.Reconnecting, () => setState('reconnecting'))
    .on(RoomEvent.Reconnected, () => setState('connected'))
    .on(RoomEvent.Disconnected, () => setState('disconnected'))
    .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => handlers.onRemotePresence(true, safeName(p)))
    .on(RoomEvent.ParticipantDisconnected, () => { handlers.onRemotePresence(false, null); handlers.onRemoteVideo(null); })
    .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => attachRemote(track))
    .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => { if (track.kind === Track.Kind.Video) handlers.onRemoteVideo(null); })
    .on(RoomEvent.TrackMuted, (_pub, p) => { if (p !== room.localParticipant) handlers.onRemoteMuted(true); })
    .on(RoomEvent.TrackUnmuted, (_pub, p) => { if (p !== room.localParticipant) handlers.onRemoteMuted(false); })
    .on(RoomEvent.ConnectionQualityChanged, (q, p) => { if (p === room.localParticipant) handlers.onQuality(mapQuality(q)); })
    .on(RoomEvent.MediaDevicesError, () => handlers.onError('A camera or microphone problem interrupted the call.'))
    .on(RoomEvent.LocalTrackUnpublished, () => { /* device state changes surface through toggles */ })
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

  const reflectLocalVideo = () => {
    const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    const track = pub?.track as LocalVideoTrack | undefined;
    if (track && !pub?.isMuted) {
      const el = track.attach() as HTMLVideoElement;
      el.setAttribute('data-call-local-video', 'true');
      el.muted = true; // never echo own audio; local preview is silent
      el.autoplay = true;
      el.playsInline = true; // otherwise the local mirror is black on mobile/Safari
      handlers.onLocalVideo(el);
    } else {
      handlers.onLocalVideo(null);
    }
  };

  try {
    await room.localParticipant.setMicrophoneEnabled(!options.mutedOnEntry, { deviceId: options.micDeviceId });
  } catch {
    handlers.onError('We couldn’t use your microphone. Check your browser permissions.');
  }
  if (options.cameraOnEntry) {
    try {
      await room.localParticipant.setCameraEnabled(true, { deviceId: options.cameraDeviceId });
      cameraOn = true;
      reflectLocalVideo();
    } catch {
      handlers.onError('We couldn’t use your camera. You can continue with audio only.');
    }
  }

  for (const p of room.remoteParticipants.values()) {
    handlers.onRemotePresence(true, safeName(p));
    for (const pub of p.trackPublications.values()) {
      const rp = pub as RemoteTrackPublication;
      if (rp.track) attachRemote(rp.track);
    }
  }

  return {
    state: () => state,
    cameraEnabled: () => cameraOn,
    remoteConnected: () => room.remoteParticipants.size > 0,
    remoteName: () => {
      const first = [...room.remoteParticipants.values()][0];
      return first ? safeName(first) : null;
    },
    async setMuted(muted: boolean) {
      try { await room.localParticipant.setMicrophoneEnabled(!muted); }
      catch { handlers.onError('We couldn’t change your microphone. Check your browser permissions.'); }
    },
    async setCameraEnabled(on: boolean) {
      try {
        await room.localParticipant.setCameraEnabled(on, { deviceId: options.cameraDeviceId });
        cameraOn = on;
        reflectLocalVideo();
      } catch {
        cameraOn = false;
        handlers.onLocalVideo(null);
        handlers.onError('We couldn’t change your camera. Check your browser permissions.');
      }
    },
    async switchMic(deviceId: string) {
      try { await room.switchActiveDevice('audioinput', deviceId); }
      catch { handlers.onError('We couldn’t switch to that microphone.'); }
    },
    async switchCamera(deviceId: string) {
      try { await room.switchActiveDevice('videoinput', deviceId); reflectLocalVideo(); }
      catch { handlers.onError('We couldn’t switch to that camera.'); }
    },
    async switchSpeaker(deviceId: string) {
      try { await room.switchActiveDevice('audiooutput', deviceId); }
      catch { /* output switching is best-effort; not all browsers support it */ }
    },
    async disconnect() {
      try { await room.localParticipant.setCameraEnabled(false); } catch { /* device may be gone */ }
      try { await room.localParticipant.setMicrophoneEnabled(false); } catch { /* device may be gone */ }
      await room.disconnect();
      for (const el of audioEls) { try { el.remove(); } catch { /* noop */ } }
      audioEls.clear();
      handlers.onRemoteVideo(null);
      handlers.onLocalVideo(null);
      setState('disconnected');
    },
  };
}
