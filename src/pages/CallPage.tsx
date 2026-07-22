/**
 * Stage 3A — secure audio-call page (/conversations/:bookingId/call).
 *
 * Audio ONLY. Three phases in one route: (1) an accessible pre-join screen with
 * microphone selection + level test + mute-on-entry; (2) the in-call audio
 * experience (names, waiting/connected, remote-muted, quality, on-screen timer,
 * reconnecting banner, mute, mic switch, leave, autoplay recovery); (3) a
 * post-call holding screen. NEVER shows camera, screen-share, chat, recording,
 * the room name or any provider id. Leaving does NOT complete the booking or
 * move any money (Stage 3B decides settlement).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Mic, MicOff, PhoneOff, Volume2 } from 'lucide-react';
import { EmptyState, PageHeader } from '../components/ui';
import { isSupabaseMode } from '../config/dataMode';
import {
  getCallEligibility, requestCallToken, type CallEligibility, type CallTokenResult,
} from '../repositories/callRepository';
import {
  connectAudioCall, listMicrophones, type ActiveAudioCall, type AudioConnectionState,
  type AudioQuality, type MicOption,
} from '../calls/audioCall';
import { connectMockAudioCall, type MockAudioCall } from '../calls/mockAudioCall';

type Phase = 'loading' | 'ineligible' | 'prejoin' | 'in_call' | 'left';
type MicPermission = 'unknown' | 'granted' | 'denied' | 'no_mic';

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60); const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtWhen(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

const INELIGIBLE_COPY: Record<string, { title: string; body: string }> = {
  not_found: { title: 'Call not available', body: 'We couldn’t find this call for your account.' },
  not_confirmed: { title: 'Not confirmed yet', body: 'This conversation can be joined once the booking is confirmed.' },
  too_early: { title: 'Not open yet', body: 'You can join a few minutes before the start time.' },
  join_window_closed: { title: 'This call has ended', body: 'The joining time for this conversation has passed.' },
  call_closed: { title: 'Call closed', body: 'This call is no longer available.' },
  coordinator_not_permitted: {
    title: 'Only the two people talking can join',
    body: 'As the coordinator you arrange the conversation, but only the member and companion join the call itself.',
  },
};

export default function CallPage() {
  const { bookingId = '' } = useParams();
  const navigate = useNavigate();
  const mock = !isSupabaseMode();

  const [phase, setPhase] = useState<Phase>('loading');
  const [elig, setElig] = useState<CallEligibility | null>(null);
  const [ineligibleReason, setIneligibleReason] = useState<string>('not_found');

  // Pre-join.
  const [mics, setMics] = useState<MicOption[]>([]);
  const [selectedMic, setSelectedMic] = useState<string>('');
  const [micPermission, setMicPermission] = useState<MicPermission>(mock ? 'granted' : 'unknown');
  const [muteOnEntry, setMuteOnEntry] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // In-call.
  const callRef = useRef<ActiveAudioCall | MockAudioCall | null>(null);
  const [connState, setConnState] = useState<AudioConnectionState>('connecting');
  const [remotePresent, setRemotePresent] = useState(false);
  const [remoteName, setRemoteName] = useState<string | null>(null);
  const [remoteMuted, setRemoteMuted] = useState(false);
  const [muted, setMuted] = useState(false);
  const [quality, setQuality] = useState<AudioQuality>('unknown');
  const [elapsed, setElapsed] = useState(0);
  const [resumeAudio, setResumeAudio] = useState<(() => Promise<void>) | null>(null);
  const [callError, setCallError] = useState<string | null>(null);

  /* ---------------- eligibility ---------------- */
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const e = await getCallEligibility(bookingId);
        if (!live) return;
        setElig(e);
        if (e.eligible) setPhase('prejoin');
        else { setIneligibleReason(e.reason ?? 'not_found'); setPhase('ineligible'); }
      } catch {
        if (!live) return;
        setIneligibleReason('not_found'); setPhase('ineligible');
      }
    })();
    return () => { live = false; };
  }, [bookingId]);

  /* ---------------- microphone permission + devices ---------------- */
  const requestMic = useCallback(async () => {
    if (mock) { setMicPermission('granted'); return; }
    try {
      const md = navigator?.mediaDevices;
      if (!md?.getUserMedia) { setMicPermission('no_mic'); return; }
      const stream = await md.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop()); // release immediately; we only needed permission
      const list = await listMicrophones();
      setMics(list);
      setSelectedMic((prev) => prev || list[0]?.deviceId || '');
      setMicPermission(list.length === 0 ? 'no_mic' : 'granted');
    } catch (err) {
      const name = (err as DOMException)?.name;
      setMicPermission(name === 'NotFoundError' ? 'no_mic' : 'denied');
    }
  }, [mock]);

  useEffect(() => {
    if (phase === 'prejoin' && micPermission === 'unknown') void requestMic();
  }, [phase, micPermission, requestMic]);

  /* ---------------- elapsed timer (on-screen only, NOT settlement evidence) ---------------- */
  useEffect(() => {
    if (phase !== 'in_call' || connState !== 'connected') return;
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [phase, connState]);

  /* ---------------- join ---------------- */
  const handlers = {
    onState: setConnState,
    onRemotePresence: (connected: boolean, name: string | null) => { setRemotePresent(connected); setRemoteName(name); if (!connected) setRemoteMuted(false); },
    onRemoteMuted: setRemoteMuted,
    onQuality: setQuality,
    onError: (m: string) => setCallError(m),
    onNeedsAudioStart: (resume: () => Promise<void>) => setResumeAudio(() => resume),
  };

  const join = useCallback(async () => {
    setJoining(true); setJoinError(null);
    try {
      if (mock) {
        callRef.current = connectMockAudioCall({ mutedOnEntry: muteOnEntry }, handlers);
        setMuted(muteOnEntry); setElapsed(0); setPhase('in_call');
        return;
      }
      const prepared: CallTokenResult = await requestCallToken(bookingId);
      if (!prepared.ok) {
        // The window may have changed since eligibility; surface a safe message.
        setJoinError(INELIGIBLE_COPY[prepared.error ?? 'not_found']?.body ?? 'This call isn’t available right now.');
        return;
      }
      callRef.current = await connectAudioCall(prepared, { deviceId: selectedMic || undefined, mutedOnEntry: muteOnEntry }, handlers);
      setMuted(muteOnEntry); setElapsed(0); setPhase('in_call');
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : 'We couldn’t join the call. Please try again.');
    } finally {
      setJoining(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId, mock, muteOnEntry, selectedMic]);

  /* ---------------- leave (clears token from memory; never completes booking) ---------------- */
  const leave = useCallback(async () => {
    const active = callRef.current;
    callRef.current = null;
    if (active) { try { await active.disconnect(); } catch { /* already gone */ } }
    setResumeAudio(null);
    setPhase('left');
  }, []);

  // Clean up on unmount / route change so a stale room + token never linger.
  useEffect(() => () => { void callRef.current?.disconnect().catch(() => {}); callRef.current = null; }, []);

  const toggleMute = useCallback(async () => {
    const next = !muted; setMuted(next);
    try { await callRef.current?.setMuted(next); } catch { /* surfaced via handler */ }
  }, [muted]);

  /* ========================= render ========================= */
  if (phase === 'loading') {
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-10 text-center">
        <Loader2 size={24} className="mx-auto animate-spin text-stone-400" aria-hidden="true" />
        <p className="mt-2 text-stone-500" aria-live="polite">Checking your call…</p>
      </div>
    );
  }

  if (phase === 'ineligible') {
    const copy = INELIGIBLE_COPY[ineligibleReason] ?? INELIGIBLE_COPY.not_found;
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-8">
        <BackLink bookingId={bookingId} />
        <EmptyState
          title={copy.title}
          body={ineligibleReason === 'too_early' && elig?.opens_at
            ? `${copy.body} You can join from ${fmtWhen(elig.opens_at)}.` : copy.body}
          action={<Link to={`/conversations/${bookingId}`} className="btn btn-primary">Back to booking</Link>}
        />
      </div>
    );
  }

  if (phase === 'left') {
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-10 text-center">
        <PageHeader title="You’ve left the call" subtitle="Your conversation is not recorded." />
        <p className="mt-2 text-sm text-stone-500">
          You can re-join while the call is still open. Leaving does not complete the booking.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <button className="btn btn-primary" onClick={() => { setElapsed(0); setPhase('prejoin'); }}>Re-join</button>
          <Link to={`/conversations/${bookingId}`} className="btn btn-ghost">Back to booking</Link>
        </div>
      </div>
    );
  }

  if (phase === 'prejoin') {
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-8">
        <BackLink bookingId={bookingId} />
        <PageHeader title="Get ready for your call" subtitle="This is an audio call. Your camera is never used." />
        {mock && <MockBanner />}

        <section className="mt-4 rounded-2xl border border-stone-200 bg-white p-5">
          <h2 className="text-base font-semibold text-stone-800">Your microphone</h2>

          {micPermission === 'unknown' && (
            <p className="mt-2 text-sm text-stone-500" aria-live="polite">Checking your microphone…</p>
          )}
          {micPermission === 'denied' && (
            <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800" role="alert">
              Your browser is blocking the microphone. Select the padlock in the address bar, allow the
              microphone, then choose <button className="underline" onClick={() => void requestMic()}>Try again</button>.
            </div>
          )}
          {micPermission === 'no_mic' && (
            <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800" role="alert">
              We couldn’t find a microphone. Please connect one, then
              <button className="ml-1 underline" onClick={() => void requestMic()}>check again</button>.
            </div>
          )}
          {micPermission === 'granted' && !mock && (
            <div className="mt-3">
              <label htmlFor="mic-select" className="block text-sm font-medium text-stone-600">Choose microphone</label>
              <select
                id="mic-select" value={selectedMic} onChange={(e) => setSelectedMic(e.target.value)}
                className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-base"
              >
                {mics.map((m) => <option key={m.deviceId} value={m.deviceId}>{m.label}</option>)}
              </select>
              <MicLevelMeter deviceId={selectedMic} />
            </div>
          )}

          <label className="mt-4 flex items-center gap-2 text-sm text-stone-700">
            <input type="checkbox" checked={muteOnEntry} onChange={(e) => setMuteOnEntry(e.target.checked)} />
            Join with my microphone muted
          </label>
        </section>

        {joinError && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{joinError}</div>}

        <div className="mt-6 flex flex-col gap-3">
          <button
            className="btn btn-primary w-full py-3 text-lg"
            disabled={joining || (!mock && micPermission !== 'granted')}
            onClick={() => void join()}
          >
            {joining ? 'Connecting…' : 'Join call'}
          </button>
          <Link to={`/conversations/${bookingId}`} className="btn btn-ghost w-full text-center">Back to booking</Link>
        </div>

        <SafetyNote />
      </div>
    );
  }

  /* -------- in_call -------- */
  const waiting = !remotePresent;
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6">
      <PageHeader title="Your conversation" subtitle="Audio call · not recorded" />
      {mock && <MockBanner controls={(ev) => (callRef.current as MockAudioCall | null)?.simulate?.(ev)} />}

      {connState === 'reconnecting' && (
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status" aria-live="assertive">
          Reconnecting… please stay on this screen.
        </div>
      )}
      {resumeAudio && (
        <button
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-stone-800 px-3 py-2 text-sm font-medium text-white"
          onClick={() => { void resumeAudio(); setResumeAudio(null); }}
        >
          <Volume2 size={16} /> Tap to enable call audio
        </button>
      )}
      {callError && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{callError}</div>}

      <section className="mt-4 rounded-2xl border border-stone-200 bg-white p-6 text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-orange-100 text-2xl font-semibold text-orange-700">
          {(remoteName ?? 'A').trim().charAt(0).toUpperCase()}
        </div>
        <p className="mt-3 text-lg font-semibold text-stone-800">{remoteName ?? 'Your conversation partner'}</p>
        <p className="mt-1 text-sm" aria-live="polite">
          {waiting
            ? <span className="text-stone-500">Waiting for them to join…</span>
            : remoteMuted
              ? <span className="text-stone-500">Connected · their microphone is muted</span>
              : <span className="text-green-700">Connected</span>}
        </p>
        <p className="mt-2 text-sm text-stone-400">
          <span aria-hidden="true">⏱ </span>
          <span aria-label="on-screen call timer">{fmtTime(elapsed)}</span>
          <span className="ml-2">· signal: {quality}</span>
        </p>
      </section>

      <div className="mt-6 flex items-center justify-center gap-4">
        <button
          onClick={() => void toggleMute()}
          aria-pressed={muted}
          aria-label={muted ? 'Unmute my microphone' : 'Mute my microphone'}
          className={`flex h-16 w-16 flex-col items-center justify-center rounded-full text-xs font-medium ${muted ? 'bg-stone-800 text-white' : 'bg-stone-100 text-stone-700'}`}
        >
          {muted ? <MicOff size={22} /> : <Mic size={22} />}
          {muted ? 'Muted' : 'Mute'}
        </button>
        <button
          onClick={() => void leave()}
          aria-label="Leave the call"
          className="flex h-16 w-16 flex-col items-center justify-center rounded-full bg-red-600 text-xs font-medium text-white"
        >
          <PhoneOff size={22} /> Leave
        </button>
      </div>

      {!mock && mics.length > 1 && (
        <div className="mt-5">
          <label htmlFor="mic-switch" className="block text-center text-xs text-stone-500">Microphone</label>
          <select
            id="mic-switch" value={selectedMic}
            onChange={(e) => { setSelectedMic(e.target.value); void callRef.current?.switchMic(e.target.value); }}
            className="mx-auto mt-1 block rounded-lg border border-stone-300 px-3 py-2 text-sm"
          >
            {mics.map((m) => <option key={m.deviceId} value={m.deviceId}>{m.label}</option>)}
          </select>
        </div>
      )}

      <SafetyNote />
    </div>
  );
}

function BackLink({ bookingId }: { bookingId: string }) {
  return (
    <Link to={`/conversations/${bookingId}`} className="mb-4 inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-700">
      <ArrowLeft size={14} /> Back to booking
    </Link>
  );
}

function SafetyNote() {
  return (
    <p className="mt-6 text-center text-xs leading-relaxed text-stone-400">
      Audio is live and is <strong>not recorded</strong> by the app. Leave the call if you feel uncomfortable, and
      report a problem from the booking page. This service is not for emergencies.
    </p>
  );
}

function MockBanner({ controls }: { controls?: (ev: 'remote_mute' | 'remote_unmute' | 'reconnecting' | 'reconnected' | 'remote_leave' | 'remote_return') => void }) {
  return (
    <div className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800">
      Demo mode — no real call is connected and no token is issued.
      {controls && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button className="rounded bg-white px-2 py-1" onClick={() => controls('remote_mute')}>Remote mute</button>
          <button className="rounded bg-white px-2 py-1" onClick={() => controls('remote_unmute')}>Remote unmute</button>
          <button className="rounded bg-white px-2 py-1" onClick={() => controls('reconnecting')}>Reconnecting</button>
          <button className="rounded bg-white px-2 py-1" onClick={() => controls('reconnected')}>Reconnected</button>
          <button className="rounded bg-white px-2 py-1" onClick={() => controls('remote_leave')}>Remote leave</button>
        </div>
      )}
    </div>
  );
}

/** Local mic level meter for the pre-join test. Never connects to a room. */
function MicLevelMeter({ deviceId }: { deviceId: string }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    let ctx: AudioContext | null = null; let raf = 0; let stream: MediaStream | null = null; let live = true;
    (async () => {
      try {
        const md = navigator?.mediaDevices;
        if (!md?.getUserMedia || typeof AudioContext === 'undefined') return;
        stream = await md.getUserMedia({ audio: deviceId ? { deviceId } : true });
        if (!live) { stream.getTracks().forEach((t) => t.stop()); return; }
        ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser(); analyser.fftSize = 256; src.connect(analyser);
        const buf = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteFrequencyData(buf);
          const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
          setLevel(Math.min(100, Math.round((avg / 160) * 100)));
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch { /* preview is best-effort */ }
    })();
    return () => {
      live = false; if (raf) cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => {});
    };
  }, [deviceId]);
  return (
    <div className="mt-3">
      <div className="mb-1 text-xs text-stone-500">Speak to test your microphone</div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-stone-100" role="meter" aria-label="Microphone level" aria-valuenow={level} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-green-500 transition-all" style={{ width: `${level}%` }} />
      </div>
    </div>
  );
}
