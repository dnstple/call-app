/**
 * 0028 + Stage 3A — the managed Member's ONLY surface: /join/:token.
 *
 * Audio-only. The secure link IS the credential (no account, no code). Opening
 * the page never activates media or joins a room — joining is always an
 * intentional press. Every rule (expiry, revocation, booking status, join
 * window, rate limits) stays server-side. This flow uses the SAME Stage 3A audio
 * adapter as authenticated calls: microphone only, no camera, no video, no
 * screen-share, no recording, and it joins the same opaque call_ room as the
 * Companion (the Edge Function provisions the guest into the Member slot).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, Mic, MicOff, PhoneOff, Volume2 } from 'lucide-react';
import { isSupabaseMode } from '../config/dataMode';
import { isSupabaseConfigured } from '../supabase/client';
import {
  guestInvitationRepository,
  type GuestValidation,
} from '../repositories/guestInvitationRepository';
import { prepareGuestSession } from '../calls/livekit';
import {
  connectAudioCall, listMicrophones,
  type ActiveAudioCall, type AudioConnectionState, type MicOption,
} from '../calls/audioCall';

type Phase =
  | 'checking' | 'invalid' | 'expired' | 'waiting' | 'ready'
  | 'rate_limited' | 'connecting' | 'in_call' | 'ended' | 'closed';

export default function GuestJoin() {
  const { token } = useParams();
  const [phase, setPhase] = useState<Phase>('checking');
  const [details, setDetails] = useState<GuestValidation | null>(null);
  const [mics, setMics] = useState<MicOption[]>([]);
  const [selectedMic, setSelectedMic] = useState('');
  const [micChecked, setMicChecked] = useState<boolean | null>(null);
  const [muteOnEntry, setMuteOnEntry] = useState(false);
  const [muted, setMuted] = useState(false);
  const [remoteName, setRemoteName] = useState<string | null>(null);
  const [remotePresent, setRemotePresent] = useState(false);
  const [remoteMuted, setRemoteMuted] = useState(false);
  const [connState, setConnState] = useState<AudioConnectionState>('connecting');
  const [resumeAudio, setResumeAudio] = useState<(() => Promise<void>) | null>(null);
  const callRef = useRef<ActiveAudioCall | null>(null);

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

      const call = await connectAudioCall(
        { ok: true, token: prepared.token, serverUrl: prepared.serverUrl },
        { deviceId: selectedMic || undefined, mutedOnEntry: muteOnEntry },
        {
          onState: (s) => { setConnState(s); if (s === 'disconnected') setPhase((p) => (p === 'in_call' ? 'ended' : p)); },
          onRemotePresence: (connected, name) => { setRemotePresent(connected); setRemoteName(name); if (!connected) setRemoteMuted(false); },
          onRemoteMuted: setRemoteMuted,
          onQuality: () => {},
          onError: () => {},
          onNeedsAudioStart: (resume) => setResumeAudio(() => resume),
        },
      );
      callRef.current = call;
      setMuted(muteOnEntry);
      setPhase('in_call');
    } catch { setPhase('invalid'); }
  }, [token, selectedMic, muteOnEntry]);

  const toggleMute = useCallback(async () => {
    const next = !muted; setMuted(next);
    try { await callRef.current?.setMuted(next); } catch { /* noop */ }
  }, [muted]);

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
                {details.durationMinutes} minutes · audio call · not recorded
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
                  This is an audio call. Your camera is never used.
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
              <button className="btn btn-secondary btn-small" aria-pressed={muted} onClick={() => void toggleMute()}>
                {muted ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
                {muted ? 'Unmute' : 'Mute'}
              </button>
              <button className="btn btn-danger btn-small" onClick={() => void leave()}>
                <PhoneOff size={16} aria-hidden="true" /> Leave
              </button>
            </div>
            <p className="muted small" style={{ textAlign: 'center', margin: 0 }}>
              Audio is live and is <strong>not recorded</strong>. This service is not for emergencies.
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
