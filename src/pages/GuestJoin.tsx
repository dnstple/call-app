/**
 * 0028 + Stage 3A + closeout Sec 6 — the managed Member's ONLY surface:
 * /join/:token.
 *
 * The secure link IS the credential (no account, no code). Opening the page
 * never activates media or joins a room — joining is always an intentional
 * press. Every rule (expiry, revocation, booking status, join window, rate
 * limits) stays server-side. The validated guest now joins the SAME two-person
 * VIDEO experience as authenticated participants (mic + camera), using the same
 * videoCall adapter and the same opaque call_ room as the Companion. Camera is
 * granted server-side ONLY after the invitation + booking relationship are
 * validated. No screen-share, no data channel, no recording.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Camera, CameraOff, Loader2, Mic, MicOff, PhoneOff, Volume2 } from 'lucide-react';
import { isSupabaseMode } from '../config/dataMode';
import { isSupabaseConfigured } from '../supabase/client';
import {
  guestInvitationRepository,
  type GuestValidation,
} from '../repositories/guestInvitationRepository';
import { prepareGuestSession } from '../calls/livekit';
import {
  connectVideoCall, listMicrophones,
  type ActiveVideoCall, type VideoConnectionState, type DeviceOption,
} from '../calls/videoCall';

type Phase =
  | 'checking' | 'invalid' | 'expired' | 'waiting' | 'ready'
  | 'rate_limited' | 'connecting' | 'in_call' | 'ended' | 'closed';

export default function GuestJoin() {
  const { token } = useParams();
  const [phase, setPhase] = useState<Phase>('checking');
  const [details, setDetails] = useState<GuestValidation | null>(null);
  const [mics, setMics] = useState<DeviceOption[]>([]);
  const [selectedMic, setSelectedMic] = useState('');
  const [micChecked, setMicChecked] = useState<boolean | null>(null);
  const [muteOnEntry, setMuteOnEntry] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cameraOnEntry, setCameraOnEntry] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [remoteHasVideo, setRemoteHasVideo] = useState(false);
  const [remoteName, setRemoteName] = useState<string | null>(null);
  const [remotePresent, setRemotePresent] = useState(false);
  const [remoteMuted, setRemoteMuted] = useState(false);
  const [connState, setConnState] = useState<VideoConnectionState>('connecting');
  const [resumeAudio, setResumeAudio] = useState<(() => Promise<void>) | null>(null);
  const callRef = useRef<ActiveVideoCall | null>(null);
  const remoteStageRef = useRef<HTMLDivElement | null>(null);
  const localInsetRef = useRef<HTMLDivElement | null>(null);

  // Attach/detach a LiveKit-provided <video> element to its host container,
  // replacing any previous element (React never owns these nodes).
  const attachTo = (hostRef: React.RefObject<HTMLDivElement | null>, el: HTMLVideoElement | null) => {
    const host = hostRef.current;
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    if (el) { el.style.width = '100%'; el.style.height = '100%'; el.style.objectFit = 'cover'; host.appendChild(el); }
  };

  const validate = useCallback(() => {
    if (!token || !isSupabaseMode() || !isSupabaseConfigured()) { setPhase('invalid'); return; }
    guestInvitationRepository()
      .validate(token)
      .then((v) => {
        setDetails(v);
        setPhase(v.state === 'open' ? 'ready' : v.state === 'waiting' ? 'waiting' : v.state);
      })
      .catch(() => setPhase('invalid'));
  }, [token]);

  useEffect(() => { validate(); }, [validate]);

  // Too early → re-check quietly until the room opens (nothing joins on its own).
  useEffect(() => {
    if (phase !== 'waiting') return;
    const t = setInterval(validate, 30_000);
    return () => clearInterval(t);
  }, [phase, validate]);

  // Clean up on unmount so a stale room + token never linger.
  useEffect(() => () => { void callRef.current?.disconnect().catch(() => {}); callRef.current = null; }, []);

  // Optional microphone check — requests permission + lists devices, never connects.
  const checkMic = useCallback(async () => {
    try {
      const md = navigator?.mediaDevices;
      if (!md?.getUserMedia) { setMicChecked(false); return; }
      const stream = await md.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      const list = await listMicrophones();
      setMics(list);
      setSelectedMic((prev) => prev || list[0]?.deviceId || '');
      setMicChecked(list.length > 0);
    } catch { setMicChecked(false); }
  }, []);

  const join = useCallback(async () => {
    if (!token) return;
    setPhase('connecting');
    try {
      const prepared = await prepareGuestSession(token);
      const state = prepared.state as string;
      if (state === 'rate_limited') { setPhase('rate_limited'); return; }
      if (state === 'too_early') { setPhase('waiting'); return; }
      if (state === 'ended') { setPhase('expired'); return; }
      if (state !== 'joinable' || !prepared.token || !prepared.serverUrl) { setPhase('invalid'); return; }

      const call = await connectVideoCall(
        { ok: true, token: prepared.token, serverUrl: prepared.serverUrl },
        { micDeviceId: selectedMic || undefined, mutedOnEntry: muteOnEntry, cameraOnEntry },
        {
          onState: (s) => { setConnState(s); if (s === 'disconnected') setPhase((p) => (p === 'in_call' ? 'ended' : p)); },
          onRemotePresence: (connected, name) => { setRemotePresent(connected); setRemoteName(name); if (!connected) { setRemoteMuted(false); setRemoteHasVideo(false); } },
          onRemoteMuted: setRemoteMuted,
          onQuality: () => {},
          onError: () => {},
          onNeedsAudioStart: (resume) => setResumeAudio(() => resume),
          onRemoteVideo: (el) => { setRemoteHasVideo(!!el); attachTo(remoteStageRef, el); },
          onLocalVideo: (el) => attachTo(localInsetRef, el),
          onLocalDeviceLost: () => {},
        },
      );
      callRef.current = call;
      setMuted(muteOnEntry);
      setCameraOn(cameraOnEntry);
      setPhase('in_call');
    } catch { setPhase('invalid'); }
  }, [token, selectedMic, muteOnEntry, cameraOnEntry]);

  const toggleMute = useCallback(async () => {
    const next = !muted; setMuted(next);
    try { await callRef.current?.setMuted(next); } catch { /* noop */ }
  }, [muted]);

  const toggleCamera = useCallback(async () => {
    const next = !cameraOn; setCameraOn(next);
    try { await callRef.current?.setCameraEnabled(next); } catch { setCameraOn(false); }
  }, [cameraOn]);

  const leave = useCallback(async () => {
    const active = callRef.current; callRef.current = null;
    if (active) { try { await active.disconnect(); } catch { /* already gone */ } }
    setResumeAudio(null);
    setPhase('ended');
  }, []);

  const timeLabel = details?.startsAt
    ? new Date(details.startsAt).toLocaleString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
      })
    : '';

  return (
    <div className="guest-shell">
      <main className="guest-card" aria-live="polite">
        {phase === 'checking' && (
          <div className="row" style={{ gap: 10, justifyContent: 'center' }}>
            <Loader2 size={22} aria-hidden="true" />
            <span className="muted">Checking your invitation…</span>
          </div>
        )}

        {(phase === 'invalid' || phase === 'expired') && (
          <div className="col" style={{ gap: 8, textAlign: 'center' }}>
            <h1 className="guest-title">This link isn’t available</h1>
            <p className="muted guest-body" style={{ margin: 0 }}>
              {phase === 'expired'
                ? 'This conversation has finished, so the link no longer works.'
                : 'The link may have been replaced or cancelled. Please ask the person who arranged the conversation to send a new one.'}
            </p>
          </div>
        )}

        {(phase === 'waiting' || phase === 'ready' || phase === 'rate_limited') && details && (
          <div className="col" style={{ gap: 16 }}>
            <div className="col" style={{ gap: 4, textAlign: 'center' }}>
              <h1 className="guest-title">Your conversation with {details.companionName}</h1>
              <p className="guest-body" style={{ margin: 0 }}>{timeLabel}</p>
              <p className="muted guest-body" style={{ margin: 0 }}>
                {details.durationMinutes} minutes · video call · not recorded
              </p>
            </div>

            {phase === 'waiting' ? (
              <p className="muted guest-body" style={{ textAlign: 'center', margin: 0 }}>
                This conversation is not open yet. Please return shortly before the scheduled time —
                or keep this page open and the Join button will appear by itself.
              </p>
            ) : (
              <>
                <button className="btn btn-primary guest-join-btn" disabled={phase === 'rate_limited'} onClick={() => void join()}>
                  Join conversation
                </button>
                {phase === 'rate_limited' && (
                  <p className="guest-body" role="status" style={{ textAlign: 'center', margin: 0, color: 'var(--color-warning-text)' }}>
                    This link has been tried many times just now. Please wait a few minutes and press Join again.
                  </p>
                )}
                <p className="muted small" style={{ textAlign: 'center', margin: 0 }}>
                  This is a video call — you can turn your camera off at any time. Calls are never recorded.
                </p>

                <div className="col" style={{ gap: 8 }}>
                  <div className="row wrap" style={{ gap: 8, justifyContent: 'center' }}>
                    <button className="btn btn-ghost btn-small" onClick={() => void checkMic()}>
                      Check my microphone
                    </button>
                  </div>
                  {mics.length > 1 && (
                    <select value={selectedMic} onChange={(e) => setSelectedMic(e.target.value)}
                      aria-label="Choose microphone"
                      className="btn btn-ghost btn-small" style={{ maxWidth: 320, margin: '0 auto' }}>
                      {mics.map((m) => <option key={m.deviceId} value={m.deviceId}>{m.label}</option>)}
                    </select>
                  )}
                  {micChecked === true && (
                    <p className="small muted" style={{ textAlign: 'center', margin: 0 }}>Your microphone is working.</p>
                  )}
                  {micChecked === false && (
                    <p className="small" style={{ textAlign: 'center', margin: 0, color: 'var(--color-warning-text)' }}>
                      We couldn’t reach your microphone. Check your browser permissions — you can still try joining.
                    </p>
                  )}
                  <label className="row small muted" style={{ gap: 6, justifyContent: 'center' }}>
                    <input type="checkbox" checked={muteOnEntry} onChange={(e) => setMuteOnEntry(e.target.checked)} />
                    Join with my microphone muted
                  </label>
                  <label className="row small muted" style={{ gap: 6, justifyContent: 'center' }}>
                    <input type="checkbox" checked={!cameraOnEntry} onChange={(e) => setCameraOnEntry(!e.target.checked)} />
                    Join with my camera off
                  </label>
                </div>
              </>
            )}
          </div>
        )}

        {phase === 'connecting' && (
          <div className="row" style={{ gap: 10, justifyContent: 'center' }}>
            <Loader2 size={22} aria-hidden="true" />
            <span className="muted">Joining your conversation…</span>
          </div>
        )}

        {phase === 'in_call' && (
          <div className="col" style={{ gap: 12 }}>
            {/* Remote video is the main canvas; a camera-off placeholder shows
                only when the far side genuinely has no video. The local inset
                mirrors the guest's own camera. */}
            <div className="guest-stage">
              <div ref={remoteStageRef} className="guest-remote" aria-label={`${remoteName ?? 'Your Companion'}’s video`} />
              {!remoteHasVideo && (
                <div className="guest-remote-placeholder">
                  {remotePresent
                    ? `${remoteName ?? 'Your Companion'}’s camera is off`
                    : connState === 'reconnecting' ? 'Reconnecting…' : 'Waiting for your Companion to join…'}
                </div>
              )}
              <div ref={localInsetRef} className="guest-local-inset" aria-label="Your video" hidden={!cameraOn} />
            </div>
            <p className="guest-body" style={{ textAlign: 'center', margin: 0 }} aria-live="polite">
              {remotePresent
                ? remoteMuted
                  ? <>Connected with <strong>{remoteName ?? 'your Companion'}</strong> · their microphone is muted</>
                  : <>You’re talking with <strong>{remoteName ?? 'your Companion'}</strong></>
                : connState === 'reconnecting'
                  ? 'Reconnecting…'
                  : 'Waiting for your Companion to join…'}
            </p>
            {resumeAudio && (
              <button className="btn btn-secondary btn-small" style={{ alignSelf: 'center' }}
                onClick={() => { void resumeAudio(); setResumeAudio(null); }}>
                <Volume2 size={16} aria-hidden="true" /> Tap to enable call audio
              </button>
            )}
            <div className="row wrap" style={{ gap: 8, justifyContent: 'center' }}>
              <button className="btn btn-secondary btn-small" aria-pressed={muted}
                aria-label={muted ? 'Unmute microphone' : 'Mute microphone'} onClick={() => void toggleMute()}>
                {muted ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
                {muted ? 'Unmute' : 'Mute'}
              </button>
              <button className="btn btn-secondary btn-small" aria-pressed={cameraOn}
                aria-label={cameraOn ? 'Turn camera off' : 'Turn camera on'} onClick={() => void toggleCamera()}>
                {cameraOn ? <Camera size={16} aria-hidden="true" /> : <CameraOff size={16} aria-hidden="true" />}
                {cameraOn ? 'Camera on' : 'Camera off'}
              </button>
              <button className="btn btn-danger btn-small" aria-label="Leave call" onClick={() => void leave()}>
                <PhoneOff size={16} aria-hidden="true" /> Leave
              </button>
            </div>
            <p className="muted small" style={{ textAlign: 'center', margin: 0 }}>
              Video and audio are live and <strong>not recorded</strong>. This service is not for emergencies.
            </p>
          </div>
        )}

        {phase === 'ended' && (
          <div className="col" style={{ gap: 8, textAlign: 'center' }}>
            <h1 className="guest-title">You’ve left the conversation</h1>
            <p className="muted guest-body" style={{ margin: 0 }}>
              If that was a mistake, you can rejoin with the same link while the conversation is still running.
            </p>
            <div className="row wrap" style={{ gap: 8, justifyContent: 'center' }}>
              <button className="btn btn-secondary" onClick={() => { setPhase('checking'); validate(); }}>
                Rejoin
              </button>
              <button className="btn btn-ghost" onClick={() => setPhase('closed')}>
                Close
              </button>
            </div>
          </div>
        )}

        {phase === 'closed' && (
          <div className="col" style={{ gap: 8, textAlign: 'center' }}>
            <h1 className="guest-title">Thank you</h1>
            <p className="muted guest-body" style={{ margin: 0 }}>
              You can close this window now. The link will still work until the conversation ends,
              if you need to return.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
