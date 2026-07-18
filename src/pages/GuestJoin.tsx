/**
 * 0028 — the managed Member's ONLY surface: /join/:token.
 *
 * Accessibility-first: the secure link IS the credential. No account, no
 * six-digit code, one dominant "Join conversation" action, large text,
 * calm states. Opening the page never activates media or joins a room —
 * joining is always an intentional press. Every rule (expiry, revocation,
 * booking status, join window, rate limits) stays server-side.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, Mic, MicOff, PhoneOff, Video, VideoOff } from 'lucide-react';
import { isSupabaseMode } from '../config/dataMode';
import { isSupabaseConfigured } from '../supabase/client';
import {
  guestInvitationRepository,
  type GuestValidation,
} from '../repositories/guestInvitationRepository';
import {
  connectCall,
  prepareGuestSession,
  startPreview,
  type ActiveCall,
  type CallConnectionState,
  type PreparedSession,
  type PreviewHandle,
} from '../calls/livekit';

type Phase =
  | 'checking'      // validating the link
  | 'invalid'       // unknown / revoked / ineligible — one neutral state
  | 'expired'
  | 'waiting'       // valid but too early — calm, never error-styled
  | 'ready'         // open: one dominant Join action
  | 'rate_limited'
  | 'connecting'
  | 'in_call'
  | 'ended';

export default function GuestJoin() {
  const { token } = useParams();
  const [phase, setPhase] = useState<Phase>('checking');
  const [details, setDetails] = useState<GuestValidation | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(false);
  const [deviceOk, setDeviceOk] = useState<boolean | null>(null);
  const [remoteName, setRemoteName] = useState<string | null>(null);
  const [connState, setConnState] = useState<CallConnectionState>('connecting');
  const previewRef = useRef<PreviewHandle | null>(null);
  const callRef = useRef<ActiveCall | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLDivElement>(null);

  const validate = useCallback(() => {
    if (!token || !isSupabaseMode() || !isSupabaseConfigured()) {
      setPhase('invalid');
      return;
    }
    guestInvitationRepository()
      .validate(token)
      .then((v) => {
        setDetails(v);
        setPhase(v.state === 'open' ? 'ready' : v.state === 'waiting' ? 'waiting' : v.state);
      })
      .catch(() => setPhase('invalid'));
  }, [token]);

  useEffect(() => {
    validate();
  }, [validate]);

  // Too early → re-check quietly until the room opens. Nothing joins
  // automatically; the page simply swaps to the Join button when ready.
  useEffect(() => {
    if (phase !== 'waiting') return;
    const t = setInterval(validate, 30_000);
    return () => clearInterval(t);
  }, [phase, validate]);

  // Optional local device check — never connects anywhere.
  const runDeviceCheck = useCallback(async () => {
    previewRef.current?.stop();
    try {
      const preview = await startPreview({ audio: true, video: camOn });
      previewRef.current = preview;
      if (camOn && videoRef.current) preview.attachVideo(videoRef.current);
      setDeviceOk(preview.hasAudio);
    } catch {
      setDeviceOk(false);
    }
  }, [camOn]);

  useEffect(() => () => {
    previewRef.current?.stop();
    void callRef.current?.disconnect();
  }, []);

  // Joining is ALWAYS an intentional button press.
  const join = useCallback(async () => {
    if (!token) return;
    setPhase('connecting');
    previewRef.current?.stop();
    previewRef.current = null;
    try {
      const prepared = await prepareGuestSession(token);
      const state = prepared.state as string;
      if (state === 'rate_limited') { setPhase('rate_limited'); return; }
      if (state === 'too_early') { setPhase('waiting'); return; }
      if (state === 'ended') { setPhase('expired'); return; }
      if (state !== 'joinable') { setPhase('invalid'); return; }

      const call = await connectCall(prepared as PreparedSession, {
        audioEnabled: micOn,
        videoEnabled: camOn,
      }, {
        onConnectionState: (s) => {
          setConnState(s);
          if (s === 'disconnected') setPhase((p) => (p === 'in_call' ? 'ended' : p));
        },
        onRemoteJoined: (name) => setRemoteName(name),
        onRemoteLeft: () => setRemoteName(null),
        onRemoteTrack: (t) => {
          const host = remoteAudioRef.current;
          if (!host) return;
          const el = document.createElement(t.kind === 'video' ? 'video' : 'audio') as HTMLMediaElement;
          el.autoplay = true;
          if (t.kind === 'video') { (el as HTMLVideoElement).playsInline = true; el.className = 'guest-remote-video'; }
          host.appendChild(el);
          t.attach(el);
        },
        onError: () => setPhase('ended'),
      });
      callRef.current = call;
      if (camOn && videoRef.current) call.attachLocalVideo(videoRef.current);
      setPhase('in_call');
    } catch {
      setPhase('invalid');
    }
  }, [token, micOn, camOn]);

  const leave = useCallback(async () => {
    await callRef.current?.disconnect();
    callRef.current = null;
    setPhase('ended');
  }, []);

  /* ---------------- render ---------------- */

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
              <h1 className="guest-title">
                Your conversation with {details.companionName}
              </h1>
              <p className="guest-body" style={{ margin: 0 }}>{timeLabel}</p>
              <p className="muted guest-body" style={{ margin: 0 }}>
                {details.durationMinutes} minutes
              </p>
            </div>

            {phase === 'waiting' ? (
              <p className="muted guest-body" style={{ textAlign: 'center', margin: 0 }}>
                This conversation is not open yet. Please return shortly before
                the scheduled time — or keep this page open and the Join button
                will appear by itself.
              </p>
            ) : (
              <>
                <button
                  className="btn btn-primary guest-join-btn"
                  disabled={phase === 'rate_limited'}
                  onClick={() => void join()}
                >
                  Join conversation
                </button>
                {phase === 'rate_limited' && (
                  <p className="guest-body" role="status" style={{ textAlign: 'center', margin: 0, color: 'var(--color-warning-text)' }}>
                    This link has been tried many times just now. Please wait a
                    few minutes and press Join again.
                  </p>
                )}
                <p className="muted small" style={{ textAlign: 'center', margin: 0 }}>
                  Camera and microphone can be checked before joining.
                </p>

                <div className="col" style={{ gap: 8 }}>
                  <div className="row wrap" style={{ gap: 8, justifyContent: 'center' }}>
                    <button
                      className={`btn btn-small ${micOn ? 'btn-secondary' : 'btn-ghost'}`}
                      onClick={() => setMicOn((v) => !v)}
                      aria-pressed={micOn}
                    >
                      {micOn ? <Mic size={16} aria-hidden="true" /> : <MicOff size={16} aria-hidden="true" />}
                      Microphone {micOn ? 'on' : 'off'}
                    </button>
                    <button
                      className={`btn btn-small ${camOn ? 'btn-secondary' : 'btn-ghost'}`}
                      onClick={() => setCamOn((v) => !v)}
                      aria-pressed={camOn}
                    >
                      {camOn ? <Video size={16} aria-hidden="true" /> : <VideoOff size={16} aria-hidden="true" />}
                      Camera {camOn ? 'on' : 'off'}
                    </button>
                    <button className="btn btn-ghost btn-small" onClick={() => void runDeviceCheck()}>
                      Check camera and microphone
                    </button>
                  </div>
                  {deviceOk === true && (
                    <p className="small muted" style={{ textAlign: 'center', margin: 0 }}>Your microphone is working.</p>
                  )}
                  {deviceOk === false && (
                    <p className="small" style={{ textAlign: 'center', margin: 0, color: 'var(--color-warning-text)' }}>
                      We couldn’t reach your microphone. Check your browser
                      permissions — you can still try joining.
                    </p>
                  )}
                  <video ref={videoRef} className="guest-self-video" muted playsInline style={{ display: camOn ? 'block' : 'none' }} />
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
            <p className="guest-body" style={{ textAlign: 'center', margin: 0 }}>
              {remoteName
                ? <>You’re talking with <strong>{remoteName}</strong></>
                : connState === 'reconnecting'
                  ? 'Reconnecting…'
                  : 'Waiting for your Companion to join…'}
            </p>
            <div ref={remoteAudioRef} className="guest-remote-media" />
            <video ref={videoRef} className="guest-self-video" muted playsInline style={{ display: camOn ? 'block' : 'none' }} />
            <div className="row wrap" style={{ gap: 8, justifyContent: 'center' }}>
              <button
                className="btn btn-secondary btn-small"
                onClick={() => { setMicOn((v) => { void callRef.current?.toggleMicrophone(!v); return !v; }); }}
              >
                {micOn ? <Mic size={16} aria-hidden="true" /> : <MicOff size={16} aria-hidden="true" />}
                {micOn ? 'Mute' : 'Unmute'}
              </button>
              <button className="btn btn-danger btn-small" onClick={() => void leave()}>
                <PhoneOff size={16} aria-hidden="true" /> Leave
              </button>
            </div>
          </div>
        )}

        {phase === 'ended' && (
          <div className="col" style={{ gap: 8, textAlign: 'center' }}>
            <h1 className="guest-title">You’ve left the conversation</h1>
            <p className="muted guest-body" style={{ margin: 0 }}>
              If that was a mistake, you can rejoin with the same link while
              the conversation is still running.
            </p>
            <button className="btn btn-secondary" onClick={() => { setPhase('checking'); validate(); }}>
              Rejoin
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
