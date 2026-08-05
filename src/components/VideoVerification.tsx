/**
 * Companion video verification — profile section (allowlisted companions only).
 *
 * Records a short identity video in-browser (30–90s), uploads it to the private
 * verification-videos bucket and registers it for support review. Renders
 * nothing unless the server says this account is enabled. Status is
 * authoritative from the server: pending (under review), approved, or rejected
 * (with notes) → allow a re-record.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Video, Circle, Square, RefreshCw, CheckCircle2, Clock, AlertTriangle, Loader2 } from 'lucide-react';
import {
  getMyVideoVerification,
  submitVerificationVideo,
  type MyVideoVerification,
} from '../repositories/verificationRepository';
import { pushToast } from '../state/store';

const SCRIPT = 'Please introduce yourself and tell us why you’d like to become a Companion.';

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function pickMime(): string {
  const candidates = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(c)) return c;
  }
  return '';
}

export function VideoVerification({ profileId }: { profileId: string }) {
  const [info, setInfo] = useState<MyVideoVerification | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    getMyVideoVerification()
      .then(setInfo)
      .catch(() => setInfo(null))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  if (loading) {
    return (
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <Loader2 size={18} aria-hidden="true" />
        <span className="muted">Checking verification…</span>
      </div>
    );
  }
  if (!info || !info.enabled) return null;

  const status = info.status;

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <span className="icon-btn" style={{ background: 'var(--surface-muted)', pointerEvents: 'none' }} aria-hidden="true">
          <Video size={20} />
        </span>
        <div className="col" style={{ gap: 2 }}>
          <h2 style={{ margin: 0 }}>Video verification</h2>
          <span className="faint">A short recorded video helps us confirm you’re a real person before your profile goes live.</span>
        </div>
      </div>

      {status === 'approved' && (
        <div className="banner banner-success" role="status">
          <CheckCircle2 size={18} aria-hidden="true" /> Your verification video has been approved.
        </div>
      )}

      {status === 'pending' && (
        <div className="card card-tight">
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <Clock size={18} aria-hidden="true" />
            <strong>Under review</strong>
          </div>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            Thanks — we’ve received your {info.video ? fmt(info.video.duration_seconds) : ''} video and our team will review it shortly.
          </p>
        </div>
      )}

      {(status === 'none' || status === 'rejected') && (
        <>
          {status === 'rejected' && (
            <div className="banner banner-danger" role="alert">
              <AlertTriangle size={18} aria-hidden="true" /> Your previous video wasn’t accepted
              {info.video?.review_notes ? `: ${info.video.review_notes}` : '.'} Please record a new one.
            </div>
          )}
          <Recorder
            profileId={profileId}
            minSeconds={info.min_seconds}
            maxSeconds={info.max_seconds}
            onSubmitted={() => { pushToast('Video submitted for review', 'ok'); refresh(); }}
          />
        </>
      )}
    </div>
  );
}

type Phase = 'idle' | 'live' | 'recording' | 'recorded' | 'submitting';

function Recorder({
  profileId, minSeconds, maxSeconds, onSubmitted,
}: {
  profileId: string; minSeconds: number; maxSeconds: number; onSubmitted: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const clearTimer = () => { if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; } };

  useEffect(() => () => {
    clearTimer();
    stopTracks();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl, stopTracks]);

  async function enableCamera() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: true,
      });
      streamRef.current = stream;
      setPhase('live');
      // Attach after render.
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.muted = true;
          void videoRef.current.play().catch(() => {});
        }
      }, 0);
    } catch {
      setError('We couldn’t access your camera and microphone. Please allow access and try again.');
    }
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream) return;
    chunksRef.current = [];
    const mime = pickMime();
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    recRef.current = rec;
    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      clearTimer();
      const secs = (Date.now() - startRef.current) / 1000;
      setDuration(secs);
      const blob = new Blob(chunksRef.current, { type: mime || 'video/webm' });
      blobRef.current = blob;
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
      setPhase('recorded');
      // Detach live stream from the element and show the recording.
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = null;
          videoRef.current.muted = false;
          videoRef.current.src = url;
          videoRef.current.controls = true;
        }
      }, 0);
    };
    rec.start();
    startRef.current = Date.now();
    setElapsed(0);
    setPhase('recording');
    timerRef.current = window.setInterval(() => {
      const secs = (Date.now() - startRef.current) / 1000;
      setElapsed(secs);
      if (secs >= maxSeconds) stopRecording();
    }, 200);
  }

  function stopRecording() {
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop();
  }

  function reRecord() {
    if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }
    blobRef.current = null;
    setDuration(0);
    setElapsed(0);
    setPhase('live');
    setTimeout(() => {
      if (videoRef.current && streamRef.current) {
        videoRef.current.controls = false;
        videoRef.current.src = '';
        videoRef.current.srcObject = streamRef.current;
        videoRef.current.muted = true;
        void videoRef.current.play().catch(() => {});
      }
    }, 0);
  }

  async function submit() {
    if (!blobRef.current) return;
    setPhase('submitting');
    setError(null);
    try {
      await submitVerificationVideo(profileId, blobRef.current, duration);
      stopTracks();
      onSubmitted();
    } catch (e) {
      const msg = String((e as { message?: string })?.message ?? '');
      setError(/duration_out_of_range/.test(msg)
        ? `The video must be between ${minSeconds} and ${maxSeconds} seconds.`
        : 'We couldn’t submit your video. Please try again.');
      setPhase('recorded');
    }
  }

  const tooShort = duration > 0 && duration < minSeconds;
  const showVideo = phase !== 'idle';

  return (
    <div className="card card-tight col" style={{ gap: 12 }}>
      <div>
        <strong>What to say</strong>
        <p className="muted" style={{ margin: '6px 0 0' }}>{SCRIPT}</p>
        <p className="faint" style={{ margin: '8px 0 0' }}>
          Please record between {minSeconds} and {maxSeconds} seconds in a quiet, well-lit place.
        </p>
      </div>

      {error && <div className="banner banner-danger" role="alert">{error}</div>}

      {showVideo && (
        <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', background: '#000' }}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={videoRef} playsInline style={{ width: '100%', display: 'block', maxHeight: 360 }} />
          {phase === 'recording' && (
            <span
              style={{ position: 'absolute', top: 10, left: 10, display: 'inline-flex', alignItems: 'center', gap: 6,
                background: 'rgba(0,0,0,0.6)', color: '#fff', padding: '4px 10px', borderRadius: 999, fontVariantNumeric: 'tabular-nums' }}
            >
              <Circle size={12} fill="#e5484d" color="#e5484d" /> {fmt(elapsed)} / {fmt(maxSeconds)}
            </span>
          )}
        </div>
      )}

      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        {phase === 'idle' && (
          <button className="btn btn-primary" onClick={enableCamera}>
            <Video size={16} aria-hidden="true" /> Enable camera
          </button>
        )}
        {phase === 'live' && (
          <button className="btn btn-primary" onClick={startRecording}>
            <Circle size={14} aria-hidden="true" /> Start recording
          </button>
        )}
        {phase === 'recording' && (
          <button className="btn btn-danger" onClick={stopRecording} disabled={elapsed < 1}>
            <Square size={14} aria-hidden="true" /> Stop
          </button>
        )}
        {(phase === 'recorded' || phase === 'submitting') && (
          <>
            <button className="btn btn-secondary" onClick={reRecord} disabled={phase === 'submitting'}>
              <RefreshCw size={16} aria-hidden="true" /> Re-record
            </button>
            <button className="btn btn-primary" onClick={submit} disabled={phase === 'submitting' || tooShort}>
              {phase === 'submitting' ? <><Loader2 size={16} aria-hidden="true" /> Submitting…</> : 'Submit for review'}
            </button>
          </>
        )}
      </div>

      {phase === 'recorded' && (
        <span className={tooShort ? '' : 'faint'} style={tooShort ? { color: 'var(--danger)' } : undefined}>
          {tooShort
            ? `That was ${fmt(duration)} — please record at least ${minSeconds} seconds.`
            : `Recorded ${fmt(duration)}. Review it above, then submit.`}
        </span>
      )}
    </div>
  );
}
