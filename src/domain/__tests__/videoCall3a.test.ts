// @vitest-environment jsdom
/**
 * Sprint v1 (Block 1) — video-call adapter behaviour (livekit-client mocked).
 *
 * Proves the provider-neutral video surface: connect publishes the microphone
 * (respecting mute-on-entry) and the camera ONLY when asked; the camera is fully
 * toggleable; remote video/audio tracks attach; device switching delegates to
 * the SDK; disconnect tears everything down; state transitions surface to the
 * page; and the module uses NO screen-share / recording / data-channel APIs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ----------------------------- livekit-client mock -----------------------------
 * Everything the mock references must be created inside vi.hoisted, because the
 * vi.mock factory is hoisted above ordinary top-level declarations. */
interface FakeRoomLike {
  handlers: Record<string, (...a: unknown[]) => void>;
  remoteParticipants: Map<unknown, unknown>;
  canPlaybackAudio: boolean;
  camPub: { isMuted: boolean; track: { attach: () => HTMLElement } } | undefined;
  localParticipant: {
    setMicrophoneEnabled: ReturnType<typeof vi.fn>;
    setCameraEnabled: ReturnType<typeof vi.fn>;
    getTrackPublication: (src: string) => unknown;
  };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  switchActiveDevice: ReturnType<typeof vi.fn>;
  startAudio: ReturnType<typeof vi.fn>;
  on(ev: string, cb: (...a: unknown[]) => void): FakeRoomLike;
  emit(ev: string, ...args: unknown[]): void;
}

const lk = vi.hoisted(() => {
  const RoomEvent = {
    Reconnecting: 'reconnecting', Reconnected: 'reconnected', Disconnected: 'disconnected',
    ParticipantConnected: 'participantConnected', ParticipantDisconnected: 'participantDisconnected',
    TrackSubscribed: 'trackSubscribed', TrackUnsubscribed: 'trackUnsubscribed',
    TrackMuted: 'trackMuted', TrackUnmuted: 'trackUnmuted',
    ConnectionQualityChanged: 'connectionQualityChanged', MediaDevicesError: 'mediaDevicesError',
    LocalTrackUnpublished: 'localTrackUnpublished', AudioPlaybackStatusChanged: 'audioPlaybackStatusChanged',
  };
  const ConnectionQuality = { Excellent: 'excellent', Good: 'good', Poor: 'poor', Unknown: 'unknown' };
  const Track = { Kind: { Audio: 'audio', Video: 'video' }, Source: { Camera: 'camera', Microphone: 'microphone' } };
  const rooms: FakeRoomLike[] = [];

  class FakeRoom {
    handlers: Record<string, (...a: unknown[]) => void> = {};
    remoteParticipants = new Map();
    canPlaybackAudio = true;
    camPub: { isMuted: boolean; track: { attach: () => HTMLElement } } | undefined;
    localParticipant = {
      setMicrophoneEnabled: vi.fn(async () => {}),
      setCameraEnabled: vi.fn(async (on: boolean) => {
        this.camPub = { isMuted: !on, track: { attach: () => document.createElement('video') } };
      }),
      getTrackPublication: (_src: string) => this.camPub,
    };
    connect = vi.fn(async () => {});
    disconnect = vi.fn(async () => {});
    switchActiveDevice = vi.fn(async () => {});
    startAudio = vi.fn(async () => {});
    constructor(public opts: unknown) { rooms.push(this as unknown as FakeRoomLike); }
    on(ev: string, cb: (...a: unknown[]) => void) { this.handlers[ev] = cb; return this; }
    emit(ev: string, ...args: unknown[]) { this.handlers[ev]?.(...args); }
    static getLocalDevices = vi.fn(async () => [{ deviceId: 'd1', label: 'Device 1' }]);
  }
  return { RoomEvent, ConnectionQuality, Track, rooms, FakeRoom };
});

const rooms: FakeRoomLike[] = lk.rooms;
const RoomEvent = lk.RoomEvent;

vi.mock('livekit-client', () => ({
  Room: lk.FakeRoom, RoomEvent: lk.RoomEvent, ConnectionQuality: lk.ConnectionQuality, Track: lk.Track,
}));

import { connectVideoCall, listCameras, listMicrophones } from '../../calls/videoCall';

const prepared = { ok: true as const, token: 't', serverUrl: 'wss://x', callSessionId: 's1', role: 'member' as const };
function makeHandlers() {
  return {
    onState: vi.fn(), onRemotePresence: vi.fn(), onRemoteMuted: vi.fn(), onQuality: vi.fn(),
    onError: vi.fn(), onNeedsAudioStart: vi.fn(), onRemoteVideo: vi.fn(), onLocalVideo: vi.fn(),
    onLocalDeviceLost: vi.fn(),
  };
}

beforeEach(() => { rooms.length = 0; });
afterEach(() => { document.body.querySelectorAll('[data-call-audio]').forEach((e) => e.remove()); vi.clearAllMocks(); });

describe('videoCall adapter — connect + camera', () => {
  it('publishes mic (unmuted) and camera on entry when asked, and reflects the local preview', async () => {
    const h = makeHandlers();
    await connectVideoCall(prepared, { mutedOnEntry: false, cameraOnEntry: true }, h);
    const room = rooms[0];
    expect(room.connect).toHaveBeenCalledWith('wss://x', 't', { autoSubscribe: true });
    // mutedOnEntry false → setMicrophoneEnabled(true, …)
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, expect.anything());
    expect(room.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true, expect.anything());
    expect(h.onLocalVideo).toHaveBeenCalledWith(expect.any(HTMLElement));
    expect(h.onState).toHaveBeenCalledWith('connected');
  });

  it('does NOT enable the camera on entry when joining audio-only', async () => {
    const h = makeHandlers();
    await connectVideoCall(prepared, { mutedOnEntry: false, cameraOnEntry: false }, h);
    expect(rooms[0].localParticipant.setCameraEnabled).not.toHaveBeenCalled();
    expect(h.onLocalVideo).not.toHaveBeenCalledWith(expect.any(HTMLElement));
  });

  it('respects mute-on-entry', async () => {
    const h = makeHandlers();
    await connectVideoCall(prepared, { mutedOnEntry: true, cameraOnEntry: false }, h);
    expect(rooms[0].localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false, expect.anything());
  });

  it('toggling the camera on/off drives the SDK and the local preview', async () => {
    const h = makeHandlers();
    const call = await connectVideoCall(prepared, { mutedOnEntry: false, cameraOnEntry: false }, h);
    await call.setCameraEnabled(true);
    expect(rooms[0].localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(true, expect.anything());
    expect(call.cameraEnabled()).toBe(true);
    expect(h.onLocalVideo).toHaveBeenLastCalledWith(expect.any(HTMLElement));
    await call.setCameraEnabled(false);
    expect(call.cameraEnabled()).toBe(false);
    expect(h.onLocalVideo).toHaveBeenLastCalledWith(null);
  });

  it('switchMic / switchCamera delegate to the SDK device switch', async () => {
    const h = makeHandlers();
    const call = await connectVideoCall(prepared, { mutedOnEntry: false, cameraOnEntry: false }, h);
    await call.switchMic('m2');
    await call.switchCamera('c2');
    expect(rooms[0].switchActiveDevice).toHaveBeenCalledWith('audioinput', 'm2');
    expect(rooms[0].switchActiveDevice).toHaveBeenCalledWith('videoinput', 'c2');
  });
});

describe('videoCall adapter — remote media + lifecycle', () => {
  it('attaches a remote video track and detaches it when unsubscribed', async () => {
    const h = makeHandlers();
    await connectVideoCall(prepared, { mutedOnEntry: false, cameraOnEntry: false }, h);
    const room = rooms[0];
    const vtrack = { kind: 'video', attach: () => document.createElement('video') };
    room.emit(RoomEvent.TrackSubscribed, vtrack);
    expect(h.onRemoteVideo).toHaveBeenCalledWith(expect.any(HTMLElement));
    room.emit(RoomEvent.TrackUnsubscribed, vtrack);
    expect(h.onRemoteVideo).toHaveBeenLastCalledWith(null);
  });

  it('attaches remote audio hidden in the document (no visible element)', async () => {
    const h = makeHandlers();
    await connectVideoCall(prepared, { mutedOnEntry: false, cameraOnEntry: false }, h);
    const atrack = { kind: 'audio', attach: () => document.createElement('audio') };
    rooms[0].emit(RoomEvent.TrackSubscribed, atrack);
    const el = document.body.querySelector('[data-call-audio]') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.style.display).toBe('none');
  });

  it('maps state transitions and remote presence/mute to handlers', async () => {
    const h = makeHandlers();
    await connectVideoCall(prepared, { mutedOnEntry: false, cameraOnEntry: false }, h);
    const room = rooms[0];
    room.emit(RoomEvent.Reconnecting); expect(h.onState).toHaveBeenLastCalledWith('reconnecting');
    room.emit(RoomEvent.Reconnected); expect(h.onState).toHaveBeenLastCalledWith('connected');
    room.emit(RoomEvent.ParticipantConnected, { name: 'Alex', trackPublications: new Map() });
    expect(h.onRemotePresence).toHaveBeenLastCalledWith(true, 'Alex');
    room.emit(RoomEvent.TrackMuted, {}, { name: 'Alex' });
    expect(h.onRemoteMuted).toHaveBeenLastCalledWith(true);
  });

  it('offers autoplay recovery when playback is blocked', async () => {
    const h = makeHandlers();
    await connectVideoCall(prepared, { mutedOnEntry: false, cameraOnEntry: false }, h);
    rooms[0].canPlaybackAudio = false;
    rooms[0].emit(RoomEvent.AudioPlaybackStatusChanged);
    expect(h.onNeedsAudioStart).toHaveBeenCalledWith(expect.any(Function));
  });

  it('disconnect tears down the room and clears both video surfaces', async () => {
    const h = makeHandlers();
    const call = await connectVideoCall(prepared, { mutedOnEntry: false, cameraOnEntry: true }, h);
    await call.disconnect();
    expect(rooms[0].disconnect).toHaveBeenCalled();
    expect(h.onRemoteVideo).toHaveBeenLastCalledWith(null);
    expect(h.onLocalVideo).toHaveBeenLastCalledWith(null);
    expect(h.onState).toHaveBeenLastCalledWith('disconnected');
  });
});

describe('videoCall adapter — safety invariants (source)', () => {
  const SRC = readFileSync(join(__dirname, '..', '..', 'calls', 'videoCall.ts'), 'utf-8');
  it('uses NO screen-share, recording/egress or data-channel APIs', () => {
    expect(SRC).not.toMatch(/setScreenShareEnabled\s*\(/);
    expect(SRC).not.toMatch(/startScreenShare/);
    expect(SRC).not.toMatch(/Track\.Source\.ScreenShare|TrackSource\.SCREEN_SHARE/);
    expect(SRC).not.toMatch(/\bEgress\b|startRecording|roomRecord/i);
    expect(SRC).not.toMatch(/publishData|DataPacket|registerRpcMethod/);
  });
  it('only ever publishes microphone + camera, and the local preview is muted', () => {
    expect(SRC).toContain('setMicrophoneEnabled');
    expect(SRC).toContain('setCameraEnabled');
    expect(SRC).toContain('el.muted = true'); // never echo own audio in the local mirror
  });
});
