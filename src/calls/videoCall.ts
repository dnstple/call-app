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
  VideoPresets,
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
  /**
   * The remote has a camera track PUBLISHED (whether or not its frames have
   * arrived yet). Lets the UI tell "their camera is off" apart from "their video
   * isn't coming through" (a one-way media/relay problem) instead of failing
   * silently.
   */
  onRemoteVideoExpected?(expected: boolean): void;
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

/**
 * Choose a CAPTURE tier from the device's capability, so a weaker or mobile
 * device encodes at a lower resolution (less CPU, heat and stutter) while a
 * capable desktop still captures 1080p. This is about the DEVICE; the network
 * side is handled separately by simulcast/congestion control. Best-effort — the
 * signals aren't available in every browser, so we fall back to a safe middle.
 */
function pickVideoTier(): { resolution: typeof VideoPresets.h720.resolution; encoding: typeof VideoPresets.h720.encoding; layers: (typeof VideoPresets.h360)[] } {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const mem = (nav as unknown as { deviceMemory?: number } | undefined)?.deviceMemory;
  const cores = nav?.hardwareConcurrency ?? 4;
  const coarsePointer = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const shortEdge = typeof window !== 'undefined' && window.screen
    ? Math.min(window.screen.width || 9999, window.screen.height || 9999)
    : 9999;
  const mobileish = coarsePointer && shortEdge <= 900;

  // Tiers are deliberately conservative: real trial calls ran on shaky
  // connections and a lower publish resolution/bitrate means less uplink to
  // sustain, so brief network dips degrade gracefully instead of dropping. The
  // simulcast ladder still lets a strong downlink pull a sharper layer; we just
  // stop asking every sender to push 1080p by default.
  //
  // Low-power device → 360p, minimal extra layer.
  if ((mem !== undefined && mem <= 2) || cores <= 2) {
    return { resolution: VideoPresets.h360.resolution, encoding: VideoPresets.h360.encoding, layers: [VideoPresets.h180] };
  }
  // Modest laptop / any phone or tablet → 540p.
  if ((mem !== undefined && mem <= 4) || cores <= 4 || mobileish) {
    return { resolution: VideoPresets.h540.resolution, encoding: VideoPresets.h540.encoding, layers: [VideoPresets.h180] };
  }
  // Capable desktop → 720p with a two-step simulcast ladder (down from 1080p).
  return { resolution: VideoPresets.h720.resolution, encoding: VideoPresets.h720.encoding, layers: [VideoPresets.h180, VideoPresets.h360] };
}

/**
 * All iOS browsers (and desktop Safari) run on Apple WebKit, which cannot
 * reliably ENCODE VP8 simulcast — the camera publishes a track that produces no
 * frames, so the far side sees black with no error while our side still decodes
 * their VP8 fine (one-way video). WebKit hardware-encodes H.264, so those
 * senders publish a single H.264 layer instead. Receiving is unaffected.
 */
function isAppleWebkit(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const nav = navigator as Navigator & { maxTouchPoints?: number };
  const iOS = /iPad|iPhone|iPod/.test(ua) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1);
  const desktopSafari = /^((?!chrome|crios|chromium|android|fxios|edg).)*safari/i.test(ua);
  return iOS || desktopSafari;
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
  // Quality that adapts to each person's connection.
  //
  // We capture at up to 1080p and publish SIMULCAST layers (1080p / 720p / 360p).
  // The server then sends each viewer the highest layer their DOWNLINK can take,
  // while the sender's congestion control scales its UPLINK automatically — so a
  // fast connection gets crisp 1080p and a weak one steps down gracefully to
  // 720p/360p instead of freezing. dynacast pauses layers nobody is watching, to
  // save the sender's upload.
  //
  // adaptiveStream stays OFF: that feature pauses a remote track when its <video>
  // element isn't visibly sized yet, which was a cause of a permanently BLACK
  // canvas. Network adaptation above does not depend on it.
  const tier = pickVideoTier();
  // Apple WebKit senders must publish H.264 (single layer) — see isAppleWebkit.
  // Everyone else publishes a VP8 simulcast ladder for graceful downlink scaling.
  const appleWebkit = isAppleWebkit();
  const room = new Room({
    adaptiveStream: false,
    dynacast: true,
    videoCaptureDefaults: {
      resolution: tier.resolution,
    },
    publishDefaults: {
      simulcast: !appleWebkit,
      videoCodec: appleWebkit ? 'h264' : 'vp8',
      videoEncoding: tier.encoding,
      videoSimulcastLayers: appleWebkit ? [] : tier.layers,
    },
  });
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
      // This element carries ONLY video — the remote audio plays through a
      // separate hidden <audio>. Muting the video element is therefore silent,
      // and it lets iOS Safari autoplay it inline (it blocks unmuted autoplay
      // outside a user gesture, which is why the remote showed black on iPhone).
      el.muted = true;
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

  // Whether any remote participant is currently publishing a camera track. The
  // UI uses this to distinguish a deliberate camera-off from video that has been
  // published but isn't arriving (a one-way media problem).
  const remoteHasCameraPub = () => {
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        if (pub.source === Track.Source.Camera) return true;
      }
    }
    return false;
  };
  const emitExpected = () => handlers.onRemoteVideoExpected?.(remoteHasCameraPub());
  // Only NEW events here — the existing chain already handles subscribe/presence,
  // and re-registering those would replace their handlers under a single-listener
  // emitter. TrackPublished/TrackUnpublished tell us a camera exists before (or
  // without) its frames arriving; the connect loop below emits the initial state.
  room
    .on(RoomEvent.TrackPublished, emitExpected)
    .on(RoomEvent.TrackUnpublished, emitExpected);

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
  emitExpected();

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
