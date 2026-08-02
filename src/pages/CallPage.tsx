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
import {
  ArrowLeft, Calendar, Loader2, Mic, MicOff, Phone, PhoneOff, Settings, ShieldCheck,
  Video, VideoOff, Volume2, X,
} from 'lucide-react';
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
function fmtDateTime(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
}

const INELIGIBLE_COPY: Record<string, { title: string; body: string }> = {
  not_found: { title: 'Call not available', body: 'We couldn’t find this call for your account.' },
  not_confirmed: { title: 'Not confirmed yet', body: 'This conversation can be joined once the booking is confirmed.' },
  too_early: { title: 'Not open yet', body: 'You can join a few minutes before the start time.' },
  join_window_closed: { title: 'This call has ended', body: 'The joining time for this conversation has passed.' },
  call_closed: { title: 'Call closed', body: 'This call is no longer available.' },
  coordinator_not_permitted: {
    title: 'The Member joins this call',
    body: 'You arranged this conversation, and the person you arranged it for joins the call itself. You can follow the booking status here at any time.',
  },
  seat_taken: {
    title: 'Someone is already in this call',
    body: 'Only one of you can join for the Member at a time. When the person currently in the call leaves, you’ll be able to join.',
  },
  blocked: {
    title: 'This call isn’t available',
    body: 'This conversation can’t be joined because a block is in place. Contact support if you think this is a mistake.',
  },
  companion_unavailable: {
    title: 'This call isn’t available',
    body: 'This companion isn’t available for calls at the moment. Please contact support for help.',
  },
  consent_required: {
    title: 'Please accept the terms first',
    body: 'The current terms must be accepted before joining a call. You can do this from your settings.',
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
  const [showLobbySettings, setShowLobbySettings] = useState(false);
  const [showCallSettings, setShowCallSettings] = useState(false);

  // In-call state.
  const callRef = useRef<ActiveVideoCall | MockVideoCall | null>(null);
  const [connState, setConnState] = useState<VideoConnectionState>('connecting');
  const [remotePresent, setRemotePresent] = useState(false);
  const [remoteName, setRemoteName] = useState<string | null>(null);
  const [remoteMuted, setRemoteMuted] = useState(false);
  const [remoteHasVideo, setRemoteHasVideo] = useState(false);
  const [remoteVideoExpected, setRemoteVideoExpected] = useState(false);
  const [remoteVideoStalled, setRemoteVideoStalled] = useState(false);
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
      if (!connected) { setRemoteMuted(false); setRemoteHasVideo(false); setRemoteVideoExpected(false); attachTo(remoteStageRef, null); }
    },
    onRemoteMuted: setRemoteMuted,
    onQuality: setQuality,
    onError: (m: string) => setCallError(m),
    onNeedsAudioStart: (resume: () => Promise<void>) => setResumeAudio(() => resume),
    onRemoteVideo: (el: HTMLVideoElement | null) => { setRemoteHasVideo(!!el); attachTo(remoteStageRef, el); },
    onRemoteVideoExpected: (expected: boolean) => setRemoteVideoExpected(expected),
    onLocalVideo: (el: HTMLVideoElement | null) => attachTo(localInsetRef, el),
    onLocalDeviceLost: (kind: 'camera' | 'microphone') => {
      if (kind === 'camera') { setCameraOn(false); setCallError('Your camera was disconnected. You can continue with audio.'); }
      else setCallError('Your microphone was disconnected. Please reconnect it.');
    },
  };

  /* ---------------- join ---------------- */
  const join = useCallback(async (opts?: { camera?: boolean }) => {
    setJoining(true); setJoinError(null);
    const wantCamera = (opts?.camera ?? joinWithCamera) && cameraPermission === 'granted';
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

  // One-way video guard: the remote is publishing a camera but its frames aren't
  // arriving after a few seconds. Surface it instead of a silent black frame.
  useEffect(() => {
    if (!(connState === 'connected' && remotePresent && remoteVideoExpected && !remoteHasVideo)) {
      setRemoteVideoStalled(false);
      return;
    }
    const t = setTimeout(() => setRemoteVideoStalled(true), 6000);
    return () => clearTimeout(t);
  }, [connState, remotePresent, remoteVideoExpected, remoteHasVideo]);

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
      <div className="call-lobby" style={{ textAlign: 'center', paddingTop: 'var(--space-7)' }}>
        <Loader2 size={26} className="call-waiting-pulse" aria-hidden="true" style={{ color: 'var(--color-brand-strong)' }} />
        <p className="muted mt-2" aria-live="polite">Checking your call…</p>
      </div>
    );
  }

  if (phase === 'ineligible') {
    const copy = INELIGIBLE_COPY[ineligibleReason] ?? INELIGIBLE_COPY.not_found;
    return (
      <div className="call-lobby">
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
      <div className="call-lobby" style={{ textAlign: 'center', paddingTop: 'var(--space-6)' }}>
        <div className="call-avatar call-avatar-lg" aria-hidden="true" style={{ margin: '0 auto var(--space-4)' }}>
          <PhoneOff size={40} />
        </div>
        <PageHeader title="You’ve left the call" subtitle="Your conversation is not recorded." />
        <p className="muted small" style={{ maxWidth: 420, margin: '0 auto' }}>
          You can re-join while the call is still open. Leaving does not complete the booking.
        </p>
        <div className="call-actions" style={{ maxWidth: 320, margin: 'var(--space-5) auto 0' }}>
          <button className="btn btn-primary" onClick={() => { setElapsed(0); setPhase('prejoin'); }}>Re-join call</button>
          <Link to={`/conversations/${bookingId}`} className="btn btn-secondary">Back to booking</Link>
        </div>
      </div>
    );
  }

  if (phase === 'prejoin') {
    const camReady = cameraPermission === 'granted';
    const micReady = mock || micPermission === 'granted';
    const showPreview = !mock && camReady && joinWithCamera;
    const hasDeviceChoice = !mock && (mics.length > 1 || (camReady && cameras.length > 1));
    return (
      <div className="call-lobby">
        <BackLink bookingId={bookingId} />
        {mock && <MockBanner />}

        {/* Large camera preview */}
        <div className="call-preview">
          {showPreview
            ? <CameraPreview deviceId={selectedCamera} />
            : (
              <div className="call-preview-off">
                <div className="call-avatar call-avatar-lg" aria-hidden="true"><VideoOff size={40} /></div>
                <p style={{ margin: 0 }}>
                  {mock ? 'Camera preview appears here' : camReady ? 'Your camera is off' : 'Joining with audio only'}
                </p>
              </div>
            )}
          <span className="call-not-recorded"><ShieldCheck size={14} aria-hidden="true" /> Not recorded</span>
        </div>

        {/* Call info */}
        <div className="call-meta">
          <h1>Ready when you are</h1>
          {elig?.scheduled_start
            ? <span className="call-meta-when"><Calendar size={15} aria-hidden="true" /> {fmtDateTime(elig.scheduled_start)}</span>
            : <span className="muted small">This is a video call — you choose whether your camera is on.</span>}
        </div>

        {/* Simple mic + camera controls */}
        <div className="call-toggles">
          <button
            type="button"
            className={`call-ctrl call-toggle${muteOnEntry ? ' is-off' : ''}`}
            aria-pressed={!muteOnEntry}
            aria-label="Join with my microphone muted"
            disabled={!micReady}
            onClick={() => setMuteOnEntry((v) => !v)}
          >
            <span className="call-ctrl-ico">{muteOnEntry ? <MicOff size={20} /> : <Mic size={20} />}</span>
            <span className="call-ctrl-label">{muteOnEntry ? 'Mic off' : 'Mic on'}</span>
          </button>
          <button
            type="button"
            className={`call-ctrl call-toggle${!joinWithCamera ? ' is-off' : ''}`}
            aria-pressed={joinWithCamera}
            aria-label="Join with my camera on"
            disabled={!camReady}
            onClick={() => setJoinWithCamera((v) => !v)}
          >
            <span className="call-ctrl-ico">{joinWithCamera ? <Video size={20} /> : <VideoOff size={20} />}</span>
            <span className="call-ctrl-label">{joinWithCamera ? 'Camera on' : 'Camera off'}</span>
          </button>
        </div>

        {/* Permission guidance */}
        {micPermission === 'unknown' && (
          <p className="muted small" aria-live="polite" style={{ textAlign: 'center' }}>Checking your microphone…</p>
        )}
        {micPermission === 'denied' && (
          <div className="call-hint call-hint-warn" role="alert">
            <MicOff size={18} aria-hidden="true" />
            <span>Your browser is blocking the microphone. Select the padlock in the address bar, allow the
              microphone, then <button onClick={() => void requestDevices()}>try again</button>.</span>
          </div>
        )}
        {micPermission === 'missing' && (
          <div className="call-hint call-hint-warn" role="alert">
            <MicOff size={18} aria-hidden="true" />
            <span>We couldn’t find a microphone. Please connect one, then
              <button style={{ marginLeft: 4 }} onClick={() => void requestDevices()}>check again</button>.</span>
          </div>
        )}
        {cameraPermission === 'denied' && (
          <div className="call-hint call-hint-info">
            <VideoOff size={18} aria-hidden="true" />
            <span>Your camera is blocked — you can still join with audio, or allow it in the address bar and
              <button style={{ marginLeft: 4 }} onClick={() => void requestDevices()}>try again</button>.</span>
          </div>
        )}

        {/* Device settings behind a compact disclosure */}
        {hasDeviceChoice && (
          <div>
            <button
              type="button"
              className="call-settings-toggle"
              aria-expanded={showLobbySettings}
              onClick={() => setShowLobbySettings((v) => !v)}
            >
              <Settings size={16} aria-hidden="true" /> Audio and video settings
            </button>
            {showLobbySettings && (
              <div className="call-settings-panel">
                {mics.length > 1 && (
                  <div className="field">
                    <label htmlFor="mic-select">Microphone</label>
                    <select id="mic-select" value={selectedMic} onChange={(e) => setSelectedMic(e.target.value)}>
                      {mics.map((m) => <option key={m.deviceId} value={m.deviceId}>{m.label}</option>)}
                    </select>
                    <MicLevelMeter deviceId={selectedMic} />
                  </div>
                )}
                {camReady && cameras.length > 1 && (
                  <div className="field">
                    <label htmlFor="cam-select">Camera</label>
                    <select id="cam-select" value={selectedCamera} onChange={(e) => setSelectedCamera(e.target.value)}>
                      {cameras.map((c) => <option key={c.deviceId} value={c.deviceId}>{c.label}</option>)}
                    </select>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {joinError && (
          <div className="call-hint" role="alert" style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-text)' }}>
            {joinError}
          </div>
        )}

        {/* Actions — primary Join, secondary audio-only */}
        <div className="call-actions">
          <button
            className="btn btn-primary call-join-primary"
            disabled={joining || (!mock && micPermission !== 'granted')}
            onClick={() => void join()}
          >
            {joining ? <Loader2 size={18} aria-hidden="true" /> : <Phone size={18} aria-hidden="true" />}
            {joining ? 'Connecting…' : joinWithCamera ? 'Join call' : 'Join call (audio only)'}
          </button>
          {joinWithCamera && (
            <button
              className="btn btn-secondary"
              disabled={joining || (!mock && micPermission !== 'granted')}
              onClick={() => void join({ camera: false })}
            >
              Join with audio only
            </button>
          )}
        </div>

        <SafetyNote />
      </div>
    );
  }

  /* -------- in_call -------- */
  const waiting = !remotePresent;
  const statusText = connState === 'connecting' ? 'Connecting…'
    : connState === 'reconnecting' ? 'Reconnecting…'
    : waiting ? 'Waiting for them to join'
    : remoteMuted ? 'Connected · microphone muted'
    : 'Connected';
  return (
    <div className="call-stage-full">
      <div className="call-stage">
        {/* Remote video canvas (dominant) */}
        <div ref={remoteStageRef} className="call-remote" aria-label="Your conversation partner’s video" />
        {(waiting || !remoteHasVideo) && (
          <div className="call-remote-placeholder">
            <div className={`call-avatar call-avatar-lg${waiting ? ' call-waiting-pulse' : ''}`} aria-hidden="true">
              {(remoteName ?? 'A').trim().charAt(0).toUpperCase()}
            </div>
            <div>
              <p className="call-peer-title">{remoteName ?? 'Your conversation partner'}</p>
              <p className="call-peer-sub" aria-live="polite">
                {waiting
                  ? 'Waiting for them to join…'
                  : remoteVideoExpected
                    ? 'Connected · their video isn’t coming through yet…'
                    : remoteMuted
                      ? 'Connected · their microphone is muted · camera off'
                      : 'Connected · their camera is off'}
              </p>
            </div>
          </div>
        )}

        {/* Top overlay: name, live state, timer, not-recorded */}
        <div className="call-topbar">
          <div className="call-peer">
            <span className="call-peer-name">{remoteName ?? 'Your conversation'}</span>
            {/* Purely visual status; spoken state comes from the placeholder (polite)
                and the reconnecting/error toasts (assertive) to avoid double announcements. */}
            <span className="call-peer-state">{statusText}</span>
          </div>
          <span className="call-timer">
            <span className="call-recdot"><ShieldCheck size={13} aria-hidden="true" /> Not recorded</span>
            <span aria-label="on-screen call timer" style={{ marginLeft: 8 }}>{fmtTime(elapsed)}</span>
          </span>
        </div>

        {/* Local self inset (hidden when camera is off) */}
        <div ref={localInsetRef} className="call-local" hidden={!cameraOn} aria-label="Your camera preview" />

        {/* Transient overlays */}
        <div className="call-overlays">
          {mock && <MockBanner controls={(ev) => (callRef.current as MockVideoCall | null)?.simulate?.(ev)} />}
          {connState === 'reconnecting' && (
            <div className="call-toast call-toast-warn" role="status" aria-live="assertive">
              Reconnecting… please stay on this screen.
            </div>
          )}
          {resumeAudio && (
            <button
              className="call-toast-action"
              onClick={() => { void resumeAudio(); setResumeAudio(null); }}
            >
              <Volume2 size={18} aria-hidden="true" /> Tap to enable call audio
            </button>
          )}
          {callError && <div className="call-toast call-toast-danger" role="alert">{callError}</div>}
          {remoteVideoStalled && !remoteHasVideo && (
            <div className="call-toast call-toast-warn" role="status">
              You’re connected, but their video isn’t coming through. They may need to check their camera
              permission or connection — you can keep talking on audio.
            </div>
          )}
          {!waiting && connState === 'connected' && quality === 'poor' && (
            <div className="call-toast" role="status">Weak connection — video may pause briefly.</div>
          )}
        </div>

        {/* In-call device settings sheet */}
        {showCallSettings && (
          <>
            <div className="call-sheet-backdrop" onClick={() => setShowCallSettings(false)} aria-hidden="true" />
            <div className="call-sheet" role="dialog" aria-label="Audio and video settings">
              <div className="row between">
                <h2>Audio and video settings</h2>
                <button className="icon-btn" aria-label="Close settings" onClick={() => setShowCallSettings(false)}>
                  <X size={20} />
                </button>
              </div>
              <div className="field">
                <label htmlFor="mic-switch">Microphone</label>
                <select
                  id="mic-switch" value={selectedMic} disabled={mock || mics.length <= 1}
                  onChange={(e) => { setSelectedMic(e.target.value); void callRef.current?.switchMic(e.target.value); }}
                >
                  {mics.length > 0
                    ? mics.map((m) => <option key={m.deviceId} value={m.deviceId}>{m.label}</option>)
                    : <option>Default microphone</option>}
                </select>
              </div>
              <div className="field">
                <label htmlFor="cam-switch">Camera</label>
                <select
                  id="cam-switch" value={selectedCamera} disabled={mock || cameras.length <= 1}
                  onChange={(e) => { setSelectedCamera(e.target.value); void callRef.current?.switchCamera(e.target.value); }}
                >
                  {cameras.length > 0
                    ? cameras.map((c) => <option key={c.deviceId} value={c.deviceId}>{c.label}</option>)
                    : <option>Default camera</option>}
                </select>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Restrained bottom control bar */}
      <div className="call-bar">
        <button
          onClick={() => void toggleMute()}
          aria-pressed={muted}
          aria-label={muted ? 'Unmute my microphone' : 'Mute my microphone'}
          className={`call-ctrl${muted ? ' is-active' : ''}`}
        >
          {muted ? <MicOff size={22} /> : <Mic size={22} />}
          <span className="call-ctrl-label">{muted ? 'Muted' : 'Mute'}</span>
        </button>
        <button
          onClick={() => void toggleCamera()}
          aria-pressed={!cameraOn}
          aria-label={cameraOn ? 'Turn my camera off' : 'Turn my camera on'}
          className={`call-ctrl${cameraOn ? '' : ' is-active'}`}
        >
          {cameraOn ? <Video size={22} /> : <VideoOff size={22} />}
          <span className="call-ctrl-label">{cameraOn ? 'Camera' : 'Off'}</span>
        </button>
        <button
          onClick={() => setShowCallSettings((v) => !v)}
          aria-label="Audio and video settings"
          aria-expanded={showCallSettings}
          className="call-ctrl"
        >
          <Settings size={22} />
          <span className="call-ctrl-label">Settings</span>
        </button>
        <button
          onClick={() => void leave()}
          aria-label="Leave the call"
          className="call-ctrl is-danger"
        >
          <PhoneOff size={22} />
          <span className="call-ctrl-label">Leave</span>
        </button>
      </div>
    </div>
  );
}

function BackLink({ bookingId }: { bookingId: string }) {
  return (
    <Link to={`/conversations/${bookingId}`} className="call-lobby-back">
      <ArrowLeft size={16} aria-hidden="true" /> Back to booking
    </Link>
  );
}

function SafetyNote() {
  return (
    <p className="call-safety">
      Your call is live and is <strong>not recorded</strong> by the app. You can turn your camera off at any time,
      leave the call if you feel uncomfortable, and report a problem from the booking page. This service is not for emergencies.
    </p>
  );
}

function MockBanner({ controls }: { controls?: (ev: 'remote_mute' | 'remote_unmute' | 'reconnecting' | 'reconnected' | 'remote_leave' | 'remote_return') => void }) {
  return (
    <div className="banner banner-info small" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <span>Demo mode — no real call is connected and no token is issued.</span>
      {controls && (
        <div className="row-wrap" style={{ marginTop: 8 }}>
          <button className="btn btn-small btn-secondary" onClick={() => controls('remote_mute')}>Remote mute</button>
          <button className="btn btn-small btn-secondary" onClick={() => controls('remote_unmute')}>Remote unmute</button>
          <button className="btn btn-small btn-secondary" onClick={() => controls('reconnecting')}>Reconnecting</button>
          <button className="btn btn-small btn-secondary" onClick={() => controls('reconnected')}>Reconnected</button>
          <button className="btn btn-small btn-secondary" onClick={() => controls('remote_leave')}>Remote leave</button>
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
  return <video ref={ref} playsInline muted aria-label="Your camera preview" />;
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
    <div style={{ marginTop: 10 }}>
      <div className="muted small" style={{ marginBottom: 6 }}>Speak to test your microphone</div>
      <div className="call-mic-meter">
        <div className="track" role="meter" aria-label="Microphone level" aria-valuenow={level} aria-valuemin={0} aria-valuemax={100}>
          <div className="fill" style={{ width: `${level}%` }} />
        </div>
      </div>
    </div>
  );
}
