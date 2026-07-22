/**
 * Stage 3A — deterministic MOCK audio call.
 *
 * Mock mode NEVER mints a real LiveKit token or opens a real connection. This
 * adapter drives the same provider-neutral surface as the live one through a
 * scripted timeline (connecting → connected → remote present), and exposes
 * `simulate()` so the mock UI can demonstrate remote-muted, reconnecting and
 * disconnected states offline. Clearly isolated from the live adapter.
 */
import type { ActiveAudioCall, AudioCallHandlers, AudioConnectionState } from './audioCall';

export interface MockAudioCall extends ActiveAudioCall {
  simulate(event: 'remote_mute' | 'remote_unmute' | 'reconnecting' | 'reconnected' | 'remote_leave' | 'remote_return'): void;
}

export function connectMockAudioCall(
  _options: { mutedOnEntry: boolean },
  handlers: AudioCallHandlers,
): MockAudioCall {
  let state: AudioConnectionState = 'connecting';
  let remote = false;
  const REMOTE_NAME = 'Alex (demo)';
  const setState = (s: AudioConnectionState) => { state = s; handlers.onState(s); };

  setState('connecting');
  // Scripted, deterministic timeline.
  const t1 = setTimeout(() => setState('connected'), 300);
  const t2 = setTimeout(() => { remote = true; handlers.onRemotePresence(true, REMOTE_NAME); handlers.onQuality('good'); }, 800);

  return {
    state: () => state,
    remoteConnected: () => remote,
    remoteName: () => (remote ? REMOTE_NAME : null),
    async setMuted() { /* local mute is UI-only in the mock */ },
    async switchMic() { /* no devices in the mock */ },
    async disconnect() { clearTimeout(t1); clearTimeout(t2); setState('disconnected'); },
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
