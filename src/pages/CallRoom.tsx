/**
 * Stage 2F1 — /calls/:bookingId: the in-app conversation room (LiveKit).
 *
 * A calm, personal two-person call — not a corporate meeting screen.
 * Flow: authorised booking loads (RLS) → countdown before the waiting
 * room opens (starts − 10 min) → pre-join screen with device previews
 * (media never connects automatically) → the server mints a token only
 * inside its own window (starts − 5 min → ends + 30 min) → warm two-tile
 * call → leaving stops every local track and never marks completion.
 *
 * Mock mode shows a safe demo room; no LiveKit credentials are required
 * to run the app or its tests.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Clock, Loader2, Mic, MicOff, PhoneOff, Settings2, ShieldQuestion,
  Video, VideoOff,
} from 'lucide-react';
import { isSupabaseMode } from '../config/dataMode';
import { getBookingById } from '../repositories/bookingRepository';
import type { MyBookingRow } from '../supabase/database.types';
import { browserTimezone } from '../domain/timezones';
import { EmptyState } from '../components/ui';
import { IN_APP_CALL_EXPLAINER } from '../components/FlowModal';
import {
  callProvider,
  callWindowState,
  type ActiveCall,
  type CallConnectionState,
  type MediaDeviceOption,
  type PreviewHandle,
} from '../calls/CallProvider';
import { MEDIA_OPEN_MINUTES } from '../calls/joinRules';

type Phase = 'countdown' | 'prejoin' | 'connecting' | 'incall' | 'left' | 'over';

function fmtWhen(iso: string, viewerTz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: viewerTz, weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

function useCountdown(target: number | null): string | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (target === null) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [target]);
  if (target === null) return null;
  const ms = target - Date.now();
  if (ms <= 0) return null;
  const totalS = Math.floor(ms / 1000);
  const d = Math.floor(totalS / 86400);
  const h = Math.floor((totalS % 86400) / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  if (d > 0) return `${d} day${d === 1 ? '' : 's'} ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function names(b: MyBookingRow) {
  return {
    member: `${b.member_first_name}${b.member_last_initial ? ` ${b.member_last_initial}.` : ''}`,
    companion: `${b.companion_first_name}${b.companion_last_initial ? ` ${b.companion_last_initial}.` : ''}`,
  };
}

export default function CallRoom() {
  const { bookingId } = useParams();
  const navigate = useNavigate();
  const viewerTz = browserTimezone();

  const [booking, setBooking] = useState<MyBookingRow | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [phase, setPhase] = useState<Phase>('countdown');
  const [notice, setNotice] = useState<string | null>(null);

  // Pre-join device choices — the user decides BEFORE anything connects.
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [mics, setMics] = useState<MediaDeviceOption[]>([]);
  const [cams, setCams] = useState<MediaDeviceOption[]>([]);
  const [micId, setMicId] = useState<string | undefined>();
  const [camId, setCamId] = useState<string | undefined>();
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewRef = useRef<PreviewHandle | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);

  // In-call state.
  const callRef = useRef<ActiveCall | null>(null);
  const [connection, setConnection] = useState<CallConnectionState>('connecting');
  const [remoteName, setRemoteName] = useState<string | null>(null);
  const [remoteHasVideo, setRemoteHasVideo] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [joinedAt, setJoinedAt] = useState<number | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  const supabase = isSupabaseMode();

  /* ---------------- load the booking (RLS = participants only) ---------------- */

  useEffect(() => {
    if (!supabase || !bookingId) {
      setLoadState(supabase ? 'unavailable' : 'ready');
      return;
    }
    let live = true;
    getBookingById(bookingId)
      .then((b) => {
        if (!live) return;
        setBooking(b);
        setLoadState(b ? 'ready' : 'unavailable');
        if (b) {
          const w = callWindowState(b.starts_at, b.ends_at);
          setPhase(w === 'before' ? 'countdown' : w === 'open' ? 'prejoin' : 'over');
        }
      })
      .catch(() => live && setLoadState('unavailable'));
    return () => {
      live = false;
    };
  }, [bookingId, supabase]);

  // Countdown flips into the waiting room automatically.
  const waitingOpensAt = booking ? Date.parse(booking.starts_at) - 10 * 60_000 : null;
  const countdown = useCountdown(phase === 'countdown' ? waitingOpensAt : null);
  useEffect(() => {
    if (phase === 'countdown' && booking && countdown === null && waitingOpensAt !== null) {
      setPhase('prejoin');
    }
  }, [countdown, phase, booking, waitingOpensAt]);

  /* ---------------- pre-join preview (local only) ---------------- */

  const stopPreview = useCallback(() => {
    previewRef.current?.stop();
    previewRef.current = null;
  }, []);

  useEffect(() => {
    if (phase !== 'prejoin' || !supabase) return;
    let live = true;
    setPreviewError(null);
    (async () => {
      try {
        const handle = await callProvider.startPreview({
          audio: micOn, video: camOn, audioDeviceId: micId, videoDeviceId: camId,
        });
        if (!live) {
          handle.stop();
          return;
        }
        previewRef.current?.stop();
        previewRef.current = handle;
        if (previewVideoRef.current && handle.hasVideo) handle.attachVideo(previewVideoRef.current);
        // Device labels become available after permission is granted.
        callProvider.listDevices('audioinput').then((d) => live && setMics(d));
        callProvider.listDevices('videoinput').then((d) => live && setCams(d));
      } catch {
        if (!live) return;
        setPreviewError(
          camOn
            ? 'We couldn’t use your camera or microphone. Check your browser permissions — you can still join with audio only, or with everything off.'
            : 'We couldn’t use your microphone. Check your browser permissions — you can still join and turn it on later.',
        );
      }
    })();
    return () => {
      live = false;
      stopPreview();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, micOn, camOn, micId, camId, supabase]);

  /* ---------------- joining (explicit, never automatic) ---------------- */

  const mediaOpensAt = booking ? Date.parse(booking.starts_at) - MEDIA_OPEN_MINUTES * 60_000 : null;
  const mediaCountdown = useCountdown(
    phase === 'prejoin' && mediaOpensAt && mediaOpensAt > Date.now() ? mediaOpensAt : null,
  );

  const join = useCallback(async () => {
    if (!bookingId || callRef.current) return;
    setPhase('connecting');
    setNotice(null);
    stopPreview(); // the room takes over the devices
    try {
      const prepared = await callProvider.prepareSession(bookingId);
      if (prepared.state !== 'joinable') {
        setPhase('prejoin');
        if (prepared.state === 'too_early') {
          setNotice('The conversation opens five minutes before the start time. Hold on — the join button will be ready shortly.');
        } else if (prepared.state === 'ended') {
          setPhase('over');
        } else if (prepared.reason === 'calling_not_configured') {
          setNotice('In-app calling isn’t switched on for this environment yet.');
        } else {
          setNotice('This conversation can’t be joined — it may have been cancelled. Check the conversation page.');
        }
        return;
      }
      const call = await callProvider.connect(
        prepared,
        { audioEnabled: micOn, videoEnabled: camOn, audioDeviceId: micId, videoDeviceId: camId },
        {
          onConnectionState: setConnection,
          onRemoteJoined: (name) => setRemoteName(name),
          onRemoteLeft: () => {
            setRemoteName(null);
            setRemoteHasVideo(false);
          },
          onRemoteTrack: (track) => {
            if (track.kind === 'video') {
              setRemoteHasVideo(true);
              if (remoteVideoRef.current) track.attach(remoteVideoRef.current);
            } else if (remoteAudioRef.current) {
              track.attach(remoteAudioRef.current);
            }
          },
          onError: (message) => setNotice(message),
        },
      );
      callRef.current = call;
      setJoinedAt(Date.now());
      setPhase('incall');
      // Local tile once the camera publishes.
      setTimeout(() => {
        if (localVideoRef.current) call.attachLocalVideo(localVideoRef.current);
      }, 400);
    } catch (e) {
      setPhase('prejoin');
      setNotice(e instanceof Error ? e.message : 'We couldn’t join the conversation. Please try again.');
    }
  }, [bookingId, micOn, camOn, micId, camId, stopPreview]);

  /* ---------------- leaving ---------------- */

  const leave = useCallback(async () => {
    const call = callRef.current;
    callRef.current = null;
    await call?.disconnect().catch(() => undefined);
    setPhase('left'); // completion stays the two-sided confirmation flow
  }, []);

  // Always release devices when navigating away.
  useEffect(
    () => () => {
      previewRef.current?.stop();
      void callRef.current?.disconnect().catch(() => undefined);
    },
    [],
  );

  const elapsed = useMemo(() => {
    if (!joinedAt) return '';
    return '';
  }, [joinedAt]);
  void elapsed;

  /* ---------------- mock mode: safe demo room ---------------- */

  if (!supabase) {
    return (
      <div className="col" style={{ gap: 14, maxWidth: 640 }}>
        <button className="btn btn-ghost btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => navigate(-1)}>
          <ArrowLeft size={18} aria-hidden="true" /> Back
        </button>
        <section className="card col" style={{ gap: 10, alignItems: 'center', textAlign: 'center', padding: 32 }}>
          <Video size={40} aria-hidden="true" />
          <h1 style={{ margin: 0, fontSize: 22 }}>Demo call room</h1>
          <p className="muted longform" style={{ margin: 0 }}>
            This is the prototype’s mock data mode, so no real call connects and no camera or
            microphone is used. In Supabase mode this page becomes the live in-app conversation.
          </p>
          <p className="faint longform" style={{ margin: 0 }}>{IN_APP_CALL_EXPLAINER}</p>
          <Link to="/conversations" className="btn btn-primary">Back to Conversations</Link>
        </section>
      </div>
    );
  }

  /* ---------------- loading / unauthorised ---------------- */

  if (loadState === 'loading') {
    return (
      <div className="row" style={{ gap: 10, padding: 48, justifyContent: 'center' }}>
        <Loader2 size={22} aria-hidden="true" />
        <span className="muted">Preparing your conversation…</span>
      </div>
    );
  }

  if (loadState === 'unavailable' || !booking) {
    return (
      <EmptyState
        icon={<ShieldQuestion size={36} aria-hidden="true" />}
        title="This call isn’t available"
        body="The conversation doesn’t exist, or you’re not one of its participants."
        action={<Link to="/conversations" className="btn btn-primary">Go to Conversations</Link>}
      />
    );
  }

  const { member, companion } = names(booking);
  const title = `${member} & ${companion}`;
  const when = fmtWhen(booking.starts_at, viewerTz);
  const cancelled = ['cancelled', 'declined'].includes(booking.status);

  /* ---------------- before the window ---------------- */

  if (cancelled || phase === 'over') {
    return (
      <CallShell title={title} onBack={() => navigate(-1)}>
        <h2 style={{ margin: 0 }}>
          {cancelled ? 'This conversation was cancelled' : 'This conversation has ended'}
        </h2>
        <p className="muted longform" style={{ margin: 0 }}>
          {cancelled
            ? 'There is nothing to join — check the conversation page for details.'
            : 'Thank you for talking. After the scheduled end, you’ll be asked whether it took place.'}
        </p>
        <Link to={`/conversations/${booking.id}`} className="btn btn-primary">View this conversation</Link>
      </CallShell>
    );
  }

  if (phase === 'countdown') {
    return (
      <CallShell title={title} onBack={() => navigate(-1)}>
        <span className="muted row" style={{ gap: 6 }}>
          <Clock size={16} aria-hidden="true" /> {when} · {booking.duration_minutes} minutes ·
          shown in your timezone ({viewerTz})
        </span>
        <h2 style={{ margin: '6px 0 0' }}>Your conversation has not started yet</h2>
        {countdown && (
          <p style={{ margin: 0, fontSize: '1.6em', fontWeight: 700 }} aria-live="polite">
            {countdown}
          </p>
        )}
        <p className="faint longform" style={{ margin: 0 }}>
          The room opens ten minutes before the start.
        </p>
        <Link to={`/conversations/${booking.id}`} className="btn btn-secondary">
          Back to the conversation page
        </Link>
      </CallShell>
    );
  }

  /* ---------------- pre-join ---------------- */

  if (phase === 'prejoin' || phase === 'connecting') {
    const joinDisabled = phase === 'connecting' || Boolean(mediaCountdown);
    return (
      <CallShell title={title} onBack={() => navigate(-1)}>
        <span className="muted row" style={{ gap: 6 }}>
          <Clock size={16} aria-hidden="true" /> {when} ({viewerTz})
        </span>
        {notice && <div className="banner banner-info" role="status">{notice}</div>}
        {previewError && <div className="banner banner-warning" role="alert">{previewError}</div>}

        <div className="call-preview" style={{
          width: '100%', maxWidth: 420, aspectRatio: '4 / 3', borderRadius: 16,
          background: 'var(--surface-muted)', overflow: 'hidden', position: 'relative',
        }}>
          {camOn && !previewError ? (
            <video ref={previewVideoRef} autoPlay muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <div className="col" style={{ height: '100%', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <VideoOff size={32} aria-hidden="true" />
              <span className="muted">Camera off — audio-only is fine</span>
            </div>
          )}
        </div>

        <div className="row wrap" style={{ gap: 8, justifyContent: 'center' }}>
          <button
            className={`btn btn-small ${micOn ? 'btn-secondary' : 'btn-danger'}`}
            aria-pressed={micOn}
            onClick={() => setMicOn((v) => !v)}
          >
            {micOn ? <Mic size={16} aria-hidden="true" /> : <MicOff size={16} aria-hidden="true" />}
            {micOn ? 'Microphone on' : 'Microphone off'}
          </button>
          <button
            className={`btn btn-small ${camOn ? 'btn-secondary' : 'btn-danger'}`}
            aria-pressed={camOn}
            onClick={() => setCamOn((v) => !v)}
          >
            {camOn ? <Video size={16} aria-hidden="true" /> : <VideoOff size={16} aria-hidden="true" />}
            {camOn ? 'Camera on' : 'Camera off'}
          </button>
        </div>

        {(mics.length > 1 || cams.length > 1) && (
          <div className="row wrap" style={{ gap: 10, justifyContent: 'center' }}>
            {mics.length > 1 && (
              <label className="col" style={{ gap: 4 }}>
                <span className="faint">Microphone</span>
                <select value={micId ?? ''} onChange={(e) => setMicId(e.target.value || undefined)}>
                  {mics.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                </select>
              </label>
            )}
            {cams.length > 1 && (
              <label className="col" style={{ gap: 4 }}>
                <span className="faint">Camera</span>
                <select value={camId ?? ''} onChange={(e) => setCamId(e.target.value || undefined)}>
                  {cams.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                </select>
              </label>
            )}
          </div>
        )}

        {mediaCountdown && (
          <p className="faint" style={{ margin: 0 }} aria-live="polite">
            You can join in {mediaCountdown}
          </p>
        )}
        <button className="btn btn-primary" disabled={joinDisabled} onClick={() => void join()}>
          {phase === 'connecting' ? 'Joining…' : 'Join conversation'}
        </button>
        <p className="faint longform" style={{ margin: 0 }}>
          Nothing connects until you choose to join. {IN_APP_CALL_EXPLAINER}
        </p>
      </CallShell>
    );
  }

  /* ---------------- after leaving ---------------- */

  if (phase === 'left') {
    return (
      <CallShell title={title} onBack={() => navigate(`/conversations/${booking.id}`)}>
        <h2 style={{ margin: 0 }}>You have left the conversation</h2>
        <p className="muted longform" style={{ margin: 0 }}>
          After the scheduled end, you’ll be asked whether it took place.
        </p>
        <Link to={`/conversations/${booking.id}`} className="btn btn-primary">View this conversation</Link>
      </CallShell>
    );
  }

  /* ---------------- in the call ---------------- */

  return (
    <InCallView
      title={title}
      remoteName={remoteName}
      remoteHasVideo={remoteHasVideo}
      connection={connection}
      notice={notice}
      joinedAt={joinedAt}
      micOn={micOn}
      camOn={camOn}
      mics={mics}
      cams={cams}
      showSettings={showSettings}
      onToggleSettings={() => setShowSettings((v) => !v)}
      onToggleMic={() => {
        const next = !micOn;
        setMicOn(next);
        void callRef.current?.toggleMicrophone(next);
      }}
      onToggleCam={() => {
        const next = !camOn;
        setCamOn(next);
        void callRef.current?.toggleCamera(next);
        if (next) {
          setTimeout(() => {
            if (localVideoRef.current) callRef.current?.attachLocalVideo(localVideoRef.current);
          }, 400);
        }
      }}
      onSwitchMic={(id) => {
        setMicId(id);
        void callRef.current?.switchDevice('audioinput', id);
      }}
      onSwitchCam={(id) => {
        setCamId(id);
        void callRef.current?.switchDevice('videoinput', id);
      }}
      onLeave={() => void leave()}
      localVideoRef={localVideoRef}
      remoteVideoRef={remoteVideoRef}
      remoteAudioRef={remoteAudioRef}
    />
  );
}

/* ---------------- presentation pieces ---------------- */

function CallShell({ title, onBack, children }: {
  title: string;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="col" style={{ gap: 14, maxWidth: 640, margin: '0 auto' }}>
      <button className="btn btn-ghost btn-small" style={{ alignSelf: 'flex-start' }} onClick={onBack}>
        <ArrowLeft size={18} aria-hidden="true" /> Back
      </button>
      <section
        className="card col"
        style={{ gap: 12, alignItems: 'center', textAlign: 'center', padding: 28 }}
      >
        <h1 style={{ margin: 0, fontSize: 22 }}>{title}</h1>
        {children}
      </section>
    </div>
  );
}

function ElapsedTime({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const m = Math.floor(s / 60);
  return <span className="faint">{m}:{String(s % 60).padStart(2, '0')}</span>;
}

function InCallView(props: {
  title: string;
  remoteName: string | null;
  remoteHasVideo: boolean;
  connection: CallConnectionState;
  notice: string | null;
  joinedAt: number | null;
  micOn: boolean;
  camOn: boolean;
  mics: MediaDeviceOption[];
  cams: MediaDeviceOption[];
  showSettings: boolean;
  onToggleSettings: () => void;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onSwitchMic: (id: string) => void;
  onSwitchCam: (id: string) => void;
  onLeave: () => void;
  localVideoRef: React.RefObject<HTMLVideoElement>;
  remoteVideoRef: React.RefObject<HTMLVideoElement>;
  remoteAudioRef: React.RefObject<HTMLAudioElement>;
}) {
  const {
    title, remoteName, remoteHasVideo, connection, notice, joinedAt, micOn, camOn,
    mics, cams, showSettings,
  } = props;
  return (
    <div className="col" style={{ gap: 12, maxWidth: 760, margin: '0 auto' }}>
      <div className="row between wrap" style={{ gap: 8 }}>
        <span className="bold">{title}</span>
        <span className="row" style={{ gap: 10 }}>
          {joinedAt && <ElapsedTime since={joinedAt} />}
          {connection === 'reconnecting' && (
            <span className="badge badge-pending" role="status">Reconnecting…</span>
          )}
          {connection === 'disconnected' && (
            <span className="badge badge-danger" role="status">Connection lost</span>
          )}
        </span>
      </div>
      {notice && <div className="banner banner-warning" role="alert">{notice}</div>}

      <div style={{
        position: 'relative', width: '100%', aspectRatio: '4 / 3', borderRadius: 20,
        background: 'var(--surface-muted)', overflow: 'hidden',
      }}>
        {/* the other person */}
        <video
          ref={props.remoteVideoRef}
          autoPlay
          playsInline
          style={{
            width: '100%', height: '100%', objectFit: 'cover',
            display: remoteHasVideo ? 'block' : 'none',
          }}
        />
        <audio ref={props.remoteAudioRef} autoPlay />
        {!remoteHasVideo && (
          <div className="col" style={{ height: '100%', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <span className="avatar" aria-hidden="true" style={{ width: 84, height: 84, fontSize: 30, background: 'var(--color-warning-bg)' }}>
              {(remoteName ?? '?')[0]}
            </span>
            <span className="muted" role="status" aria-live="polite">
              {remoteName ? `${remoteName} — audio only` : 'Waiting for the other person to join'}
            </span>
          </div>
        )}
        {remoteName && (
          <span style={{
            position: 'absolute', left: 12, bottom: 12, padding: '4px 10px', borderRadius: 10,
            background: 'rgba(0,0,0,0.45)', color: '#fff', fontSize: 14,
          }}>
            {remoteName}
          </span>
        )}
        {/* you, small and unobtrusive */}
        <div style={{
          position: 'absolute', right: 12, bottom: 12, width: 128, aspectRatio: '4 / 3',
          borderRadius: 12, overflow: 'hidden', background: 'rgba(0,0,0,0.35)',
          border: '2px solid rgba(255,255,255,0.7)',
        }}>
          {camOn ? (
            <video ref={props.localVideoRef} autoPlay muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <div className="col" style={{ height: '100%', alignItems: 'center', justifyContent: 'center' }}>
              <VideoOff size={20} aria-hidden="true" style={{ color: '#fff' }} />
            </div>
          )}
        </div>
      </div>

      {!remoteName && (
        <p className="muted" style={{ margin: 0, textAlign: 'center' }} role="status">
          Waiting for the other person to join — stay on this page.
        </p>
      )}

      <div className="row wrap" style={{ gap: 10, justifyContent: 'center' }}>
        <button
          className={`btn ${micOn ? 'btn-secondary' : 'btn-danger'}`}
          aria-pressed={micOn}
          aria-label={micOn ? 'Turn microphone off' : 'Turn microphone on'}
          onClick={props.onToggleMic}
        >
          {micOn ? <Mic size={18} aria-hidden="true" /> : <MicOff size={18} aria-hidden="true" />}
        </button>
        <button
          className={`btn ${camOn ? 'btn-secondary' : 'btn-danger'}`}
          aria-pressed={camOn}
          aria-label={camOn ? 'Turn camera off' : 'Turn camera on'}
          onClick={props.onToggleCam}
        >
          {camOn ? <Video size={18} aria-hidden="true" /> : <VideoOff size={18} aria-hidden="true" />}
        </button>
        <button className="btn btn-secondary" aria-label="Device settings" onClick={props.onToggleSettings}>
          <Settings2 size={18} aria-hidden="true" />
        </button>
        <button className="btn btn-danger" onClick={props.onLeave}>
          <PhoneOff size={18} aria-hidden="true" /> Leave
        </button>
      </div>

      {showSettings && (
        <div className="card card-tight row wrap" style={{ gap: 12, justifyContent: 'center' }}>
          {mics.length > 0 && (
            <label className="col" style={{ gap: 4 }}>
              <span className="faint">Microphone</span>
              <select onChange={(e) => props.onSwitchMic(e.target.value)}>
                {mics.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
              </select>
            </label>
          )}
          {cams.length > 0 && (
            <label className="col" style={{ gap: 4 }}>
              <span className="faint">Camera</span>
              <select onChange={(e) => props.onSwitchCam(e.target.value)}>
                {cams.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
              </select>
            </label>
          )}
          {mics.length === 0 && cams.length === 0 && (
            <span className="faint">No other devices found.</span>
          )}
        </div>
      )}
    </div>
  );
}
