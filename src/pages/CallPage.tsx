/**
 * Sprint v1 (Block 1) — secure audio/VIDEO call page (/conversations/:bookingId/call).
 *
 * Extends the Stage 3A audio foundation into a complete one-to-one video call
 * with a first-class audio-only option. Three phases in one route:
 *  (1) an accessible pre-join screen with microphone + camera selection, a live
 *      self-preview, "join with camera on/off" and "join muted";
 *  (2) the in-call experience — a two-person video stage (remote large, local
 *      mirror inset), names, waiting/connected/remote-muted, quality, on-screen
 *      timer, reconnecting banner, autoplay recovery, mute, camera on/off,
 *      device switching, leave;
 *  (3) a post-call holding screen.
 * NEVER shows screen-share, recording or chat; never exposes the room name or a
 * provider id. Leaving does NOT complete the booking or move any money (Stage 3B
 * decides settlement). The camera is fully optional and always user-controlled.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Mic, MicOff, PhoneOff, Video, VideoOff, Volume2 } from 'lucide-react';
import { EmptyState, PageHeader } from '../components/ui';
import { isSupabaseMode } from '../config/dataMode';
import {
  getCallEligibility, requestCallToken, type CallEligibility, type CallTokenResult,
} from '../repositories/callRepository';
import {
  connectVideoCall, listCameras, listMicrophones,
  type ActiveVideoCall, type DeviceOption, type VideoConnectionState, type VideoQuality,
} from '../calls/videoCall';
import { connectMockVideoCall, type MockVideoCall } from '../calls/mockVideoCall';

type Phase = 'loading' | 'ineligible' | 'prejoin' | 'in_call' | 'left';
type Permission = 'unknown' | 'granted' | 'denied' | 'missing';

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
  const mock = !isSupabaseMode();

  const [phase, setPhase] = useState<Phase>('loading');
  const [elig, setElig] = useState<CallEligibility | null>(null);
  const [ineligibleReason, setIneligibleReason] = useState<string>('not_found');

  // Pre-join devices + permissions.
  const [mics, setMics] = useState<DeviceOption[]>([]);
  const [cameras, setCameras] = useState<DeviceOption[]>([]);
  const [selectedMic, setSelectedMic] = useState<string>('');
  const [selectedCamera, setSelectedCamera] = useState<string>('');
  const [micPermission, setMicPermission] = useState<Permission>(mock ? 'granted' : 'unknown');
  const [cameraPermission, setCameraPermission] = useState<Permission>(mock ? 'granted' : 'unknown');
  const [joinWithCamera, setJoinWithCamera] = useState(true);
  const [muteOnEntry, setMuteOnEntry] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // In-call state.
  const callRef = useRef<ActiveVideoCall | MockVideoCall | null>(null);
  const [connState, setConnState] = useState<VideoConnectionState>('connecting');
  const [remotePresent, setRemotePresent] = useState(false);
  const [remoteName, setRemoteName] = useState<string | null>(null);
  const [remoteMuted, setRemoteMuted] = useState(false);
  const [remoteHasVideo, setRemoteHasVideo] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [quality, setQuality] = useState<VideoQuality>('unknown');
  const [elapsed, setElapsed] = useState(0);
  const [resumeAudio, setResumeAudio] = useState<(() => Promise<void>) | null>(null);
  const [callError, setCallError] = useState<string | null>(null);

  // Containers the adapter attaches the <video> elements into.
  const remoteStageRef = useRef<HTMLDivElement | null>(null);
  const localInsetRef = useRef<HTMLDivElement | null>(null);

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

  /* ---------------- microphone + camera permission + devices ---------------- */
  const requestDevices = useCallback(async () => {
    if (mock) { setMicPermission('granted'); setCameraPermission('granted'); return; }
    const md = navigator?.mediaDevices;
    if (!md?.getUserMedia) { setMicPermission('missing'); setCameraPermission('missing'); return; }
    // Microphone is required — request it first and report precisely.
    try {
      const s = await md.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      const list = await listMicrophones();
      setMics(list);
      setSelectedMic((prev) => prev || list[0]?.deviceId || '');
      setMicPermission(list.length === 0 ? 'missing' : 'granted');
    } catch (err) {
      const name = (err as DOMException)?.name;
      setMicPermission(name === 'NotFoundError' ? 'missing' : 'denied');
    }
    // Camera is optional — a denial/absence just means audio-only, never a block.
    try {
      const s = await md.getUserMedia({ video: true });
      s.getTracks().forEach((t) => t.stop());
      const list = await listCameras();
      setCameras(list);
      setSelectedCamera((prev) => prev || list[0]?.deviceId || '');
      if (list.length === 0) { setCameraPermission('missing'); setJoinWithCamera(false); }
      else setCameraPermission('granted');
    } catch (err) {
      const name = (err as DOMException)?.name;
      setCameraPermission(name === 'NotFoundError' ? 'missing' : 'denied');
      setJoinWithCamera(false);
    }
  }, [mock]);

  useEffect(() => {
    if (phase === 'prejoin' && micPermission === 'unknown') void requestDevices();
  }, [phase, micPermission, requestDevices]);

  /* ---------------- elapsed timer (on-screen only, NOT settlement evidence) ---------------- */
  useEffect(() => {
    if (phase !== 'in_call' || connState !== 'connected') return;
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [phase, connState]);

  /* ---------------- adapter handlers ---------------- */
  const attachTo = (ref: React.RefObject<HTMLDivElement | null>, el: HTMLVideoElement | null) => {
    const host = ref.current;
    if (!host) return;
    host.replaceChildren();
    if (el) {
      el.setAttribute('playsinline', 'true');
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.objectFit = 'cover';
      host.appendChild(el);
    }
  };

  const handlers = {
    onState: setConnState,
    onRemotePresence: (connected: boolean, name: string | null) => {
      setRemotePresent(connected); setRemoteName(name);
      if (!connected) { setRemoteMuted(false); setRemoteHasVideo(false); attachTo(remoteStageRef, null); }
    },
    onRemoteMuted: setRemoteMuted,
    onQuality: setQuality,
    onError: (m: string) => setCallError(m),
    onNeedsAudioStart: (resume: () => Promise<void>) => setResumeAudio(() => resume),
    onRemoteVideo: (el: HTMLVideoElement | null) => { setRemoteHasVideo(!!el); attachTo(remoteStageRef, el); },
    onLocalVideo: (el: HTMLVideoElement | null) => attachTo(localInsetRef, el),
    onLocalDeviceLost: (kind: 'camera' | 'microphone') => {
      if (kind === 'camera') { setCameraOn(false); setCallError('Your camera was disconnected. You can continue with audio.'); }
      else setCallError('Your microphone was disconnected. Please reconnect it.');
    },
  };

  /* ---------------- join ---------------- */
  const join = useCallback(async () => {
    setJoining(true); setJoinError(null);
    const wantCamera = joinWithCamera && cameraPermission === 'granted';
    try {
      if (mock) {
        callRef.current = connectMockVideoCall({ mutedOnEntry: muteOnEntry, cameraOnEntry: wantCamera }, handlers);
        setMuted(muteOnEntry); setCameraOn(wantCamera); setElapsed(0); setPhase('in_call');
        return;
      }
      const prepared: CallTokenResult = await requestCallToken(bookingId);
      if (!prepared.ok) {
        setJoinError(INELIGIBLE_COPY[prepared.error ?? 'not_found']?.body ?? 'This call isn’t available right now.');
        return;
      }
      callRef.current = await connectVideoCall(
        prepared,
        {
          micDeviceId: selectedMic || undefined,
          cameraDeviceId: selectedCamera || undefined,
          mutedOnEntry: muteOnEntry,
          cameraOnEntry: wantCamera,
        },
        handlers,
      );
      setMuted(muteOnEntry); setCameraOn(wantCamera); setElapsed(0); setPhase('in_call');
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : 'We couldn’t join the call. Please try again.');
    } finally {
      setJoining(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId, mock, muteOnEntry, joinWithCamera, cameraPermission, selectedMic, selectedCamera]);

  /* ---------------- leave (clears token from memory; never completes booking) ---------------- */
  const leave = useCallback(async () => {
    const active = callRef.current;
    callRef.current = null;
    if (active) { try { await active.disconnect(); } catch { /* already gone */ } }
    setResumeAudio(null);
    attachTo(remoteStageRef, null);
    attachTo(localInsetRef, null);
    setPhase('left');
  }, []);

  // Clean up on unmount / route change so a stale room + token never linger.
  useEffect(() => () => { void callRef.current?.disconnect().catch(() => {}); callRef.current = null; }, []);

  const toggleMute = useCallback(async () => {
    const next = !muted; setMuted(next);
    try { await callRef.current?.setMuted(next); } catch { /* surfaced via handler */ }
  }, [muted]);

  const toggleCamera = useCallback(async () => {
    const next = !cameraOn; setCameraOn(next);
    try { await callRef.current?.setCameraEnabled(next); } catch { setCameraOn(false); }
  }, [cameraOn]);

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
    const camReady = cameraPermission === 'granted';
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-8">
        <BackLink bookingId={bookingId} />
        <PageHeader title="Get ready for your call" subtitle="This is a video call. You choose whether to turn your camera on." />
        {mock && <MockBanner />}

        {/* Self-preview */}
        {!mock && camReady && joinWithCamera && (
          <div className="mt-4 overflow-hidden rounded-2xl bg-stone-900">
            <CameraPreview deviceId={selectedCamera} />
          </div>
        )}

        <section className="mt-4 rounded-2xl border border-stone-200 bg-white p-5">
          <h2 className="text-base font-semibold text-stone-800">Your microphone</h2>

          {micPermission === 'unknown' && (
            <p className="mt-2 text-sm text-stone-500" aria-live="polite">Checking your microphone…</p>
          )}
          {micPermission === 'denied' && (
            <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800" role="alert">
              Your browser is blocking the microphone. Select the padlock in the address bar, allow the
              microphone, then choose <button className="underline" onClick={() => void requestDevices()}>Try again</button>.
            </div>
          )}
          {micPermission === 'missing' && (
            <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800" role="alert">
              We couldn’t find a microphone. Please connect one, then
              <button className="ml-1 underline" onClick={() => void requestDevices()}>check again</button>.
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

          <h2 className="mt-5 text-base font-semibold text-stone-800">Your camera</h2>
          {cameraPermission === 'denied' && (
            <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800" role="alert">
              Your browser is blocking the camera. You can still join with audio only, or allow the camera in
              the address bar and <button className="underline" onClick={() => void requestDevices()}>try again</button>.
            </div>
          )}
          {cameraPermission === 'missing' && (
            <p className="mt-2 text-sm text-stone-500">No camera found — you can join with audio only.</p>
          )}
          {camReady && !mock && (
            <>
              <label className="mt-3 flex items-center gap-2 text-sm text-stone-700">
                <input type="checkbox" checked={joinWithCamera} onChange={(e) => setJoinWithCamera(e.target.checked)} />
                Join with my camera on
              </label>
              {joinWithCamera && cameras.length > 1 && (
                <div className="mt-3">
                  <label htmlFor="cam-select" className="block text-sm font-medium text-stone-600">Choose camera</label>
                  <select
                    id="cam-select" value={selectedCamera} onChange={(e) => setSelectedCamera(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-base"
                  >
                    {cameras.map((c) => <option key={c.deviceId} value={c.deviceId}>{c.label}</option>)}
                  </select>
                </div>
              )}
            </>
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
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <PageHeader title="Your conversation" subtitle="Video call · not recorded" />
      {mock && <MockBanner controls={(ev) => (callRef.current as MockVideoCall | null)?.simulate?.(ev)} />}

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

      {/* Two-person video stage. */}
      <section className="relative mt-4 aspect-video w-full overflow-hidden rounded-2xl bg-stone-900">
        <div ref={remoteStageRef} className="absolute inset-0" aria-label="Your conversation partner’s video" />
        {(waiting || !remoteHasVideo) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-orange-100 text-2xl font-semibold text-orange-700">
              {(remoteName ?? 'A').trim().charAt(0).toUpperCase()}
            </div>
            <p className="mt-3 text-lg font-semibold text-white">{remoteName ?? 'Your conversation partner'}</p>
            <p className="mt-1 text-sm" aria-live="polite">
              {waiting
                ? <span className="text-stone-300">Waiting for them to join…</span>
                : remoteMuted
                  ? <span className="text-stone-300">Connected · their microphone is muted · camera off</span>
                  : <span className="text-green-300">Connected · their camera is off</span>}
            </p>
          </div>
        )}
        {/* Local mirror inset (hidden when the camera is off). */}
        <div
          ref={localInsetRef}
          className={`absolute bottom-3 right-3 h-24 w-32 overflow-hidden rounded-lg border-2 border-white/70 bg-stone-800 ${cameraOn ? '' : 'hidden'}`}
          aria-label="Your camera preview"
        />
      </section>

      <p className="mt-2 text-center text-sm text-stone-400">
        <span aria-hidden="true">⏱ </span>
        <span aria-label="on-screen call timer">{fmtTime(elapsed)}</span>
        <span className="ml-2">· signal: {quality}</span>
        {!waiting && remoteMuted && <span className="ml-2">· their mic is muted</span>}
      </p>

      <div className="mt-5 flex items-center justify-center gap-4">
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
          onClick={() => void toggleCamera()}
          aria-pressed={!cameraOn}
          aria-label={cameraOn ? 'Turn my camera off' : 'Turn my camera on'}
          className={`flex h-16 w-16 flex-col items-center justify-center rounded-full text-xs font-medium ${cameraOn ? 'bg-stone-100 text-stone-700' : 'bg-stone-800 text-white'}`}
        >
          {cameraOn ? <Video size={22} /> : <VideoOff size={22} />}
          {cameraOn ? 'Camera' : 'Camera off'}
        </button>
        <button
          onClick={() => void leave()}
          aria-label="Leave the call"
          className="flex h-16 w-16 flex-col items-center justify-center rounded-full bg-red-600 text-xs font-medium text-white"
        >
          <PhoneOff size={22} /> Leave
        </button>
      </div>

      {!mock && (mics.length > 1 || cameras.length > 1) && (
        <div className="mt-5 flex flex-wrap justify-center gap-4">
          {mics.length > 1 && (
            <div>
              <label htmlFor="mic-switch" className="block text-center text-xs text-stone-500">Microphone</label>
              <select
                id="mic-switch" value={selectedMic}
                onChange={(e) => { setSelectedMic(e.target.value); void callRef.current?.switchMic(e.target.value); }}
                className="mt-1 block rounded-lg border border-stone-300 px-3 py-2 text-sm"
              >
                {mics.map((m) => <option key={m.deviceId} value={m.deviceId}>{m.label}</option>)}
              </select>
            </div>
          )}
          {cameras.length > 1 && (
            <div>
              <label htmlFor="cam-switch" className="block text-center text-xs text-stone-500">Camera</label>
              <select
                id="cam-switch" value={selectedCamera}
                onChange={(e) => { setSelectedCamera(e.target.value); void callRef.current?.switchCamera(e.target.value); }}
                className="mt-1 block rounded-lg border border-stone-300 px-3 py-2 text-sm"
              >
                {cameras.map((c) => <option key={c.deviceId} value={c.deviceId}>{c.label}</option>)}
              </select>
            </div>
          )}
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
      Your call is live and is <strong>not recorded</strong> by the app. You can turn your camera off at any time,
      leave the call if you feel uncomfortable, and report a problem from the booking page. This service is not for emergencies.
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

/** Local self-preview for the pre-join screen. Never connects to a room. */
function CameraPreview({ deviceId }: { deviceId: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null; let live = true;
    (async () => {
      try {
        const md = navigator?.mediaDevices;
        if (!md?.getUserMedia) return;
        stream = await md.getUserMedia({ video: deviceId ? { deviceId } : true });
        if (!live) { stream.getTracks().forEach((t) => t.stop()); return; }
        if (ref.current) { ref.current.srcObject = stream; ref.current.muted = true; void ref.current.play().catch(() => {}); }
      } catch { /* preview is best-effort */ }
    })();
    return () => { live = false; stream?.getTracks().forEach((t) => t.stop()); };
  }, [deviceId]);
  return (
    <video
      ref={ref} playsInline muted
      className="aspect-video w-full -scale-x-100 object-cover"
      aria-label="Your camera preview"
    />
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
