/**
 * Sprint v1 (Block 1) — deterministic MOCK video call.
 *
 * Mock mode NEVER mints a real LiveKit token or opens a real connection. This
 * adapter drives the same provider-neutral surface as the live video adapter
 * through a scripted timeline (connecting → connected → remote present) and
 * exposes `simulate()` so the demo UI can show remote-muted, camera on/off,
 * reconnecting and leave/return states offline. Clearly isolated from the live
 * adapter. It never touches getUserMedia, so no camera/mic is ever accessed.
 */
import type { ActiveVideoCall, VideoCallHandlers, VideoConnectionState } from './videoCall';

export interface MockVideoCall extends ActiveVideoCall {
  simulate(
    event:
      | 'remote_mute' | 'remote_unmute'
      | 'reconnecting' | 'reconnected'
      | 'remote_leave' | 'remote_return',
  ): void;
}

export function connectMockVideoCall(
  options: { mutedOnEntry: boolean; cameraOnEntry: boolean },
  handlers: VideoCallHandlers,
): MockVideoCall {
  let state: VideoConnectionState = 'connecting';
  let remote = false;
  let cameraOn = options.cameraOnEntry;
  const REMOTE_NAME = 'Alex (demo)';
  const setState = (s: VideoConnectionState) => { state = s; handlers.onState(s); };

  setState('connecting');
  // Scripted, deterministic timeline.
  const t1 = setTimeout(() => setState('connected'), 300);
  const t2 = setTimeout(() => { remote = true; handlers.onRemotePresence(true, REMOTE_NAME); handlers.onQuality('good'); }, 800);

  return {
    state: () => state,
    cameraEnabled: () => cameraOn,
    remoteConnected: () => remote,
    remoteName: () => (remote ? REMOTE_NAME : null),
    async setMuted() { /* local mute is UI-only in the mock */ },
    async setCameraEnabled(on: boolean) { cameraOn = on; /* no real preview in the mock */ },
    async switchMic() { /* no devices in the mock */ },
    async switchCamera() { /* no devices in the mock */ },
    async switchSpeaker() { /* no devices in the mock */ },
    async disconnect() { clearTimeout(t1); clearTimeout(t2); cameraOn = false; setState('disconnected'); },
    simulate(event) {
      switch (event) {
        case 'remote_mute': handlers.onRemoteMuted(true); break;
        case 'remote_unmute': handlers.onRemoteMuted(false); break;
        case 'reconnecting': setState('reconnecting'); break;
        case 'reconnected': setState('connected'); break;
        case 'remote_leave': remote = false; handlers.onRemotePresence(false, null); break;
        case 'remote_return': remote = true; handlers.onRemotePresence(true, REMOTE_NAME); break;
      }
    },
  };
}
