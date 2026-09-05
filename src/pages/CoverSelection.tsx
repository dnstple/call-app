/**
 * Cover selection (/cover/:bookingId) — a member's replacement companion is
 * unavailable, and companions who accepted the invite are offered here. The
 * member can pick one (the call transfers to them), reschedule, or cancel.
 * Companions are shown alphabetically with no ranking exposed.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { CalendarClock, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { PageHeader } from '../components/ui';
import { getMyCoverOptions, selectCover, cancelMyBooking, rescheduleMyBooking, type CoverInfo } from '../repositories/coverRepository';

function whenLabel(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: tz || 'Europe/London',
      weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
    });
  } catch { return new Date(iso).toLocaleString(); }
}

export default function CoverSelection() {
  const { bookingId } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = useState<CoverInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showReschedule, setShowReschedule] = useState(false);
  const [newTime, setNewTime] = useState('');

  const load = useCallback(() => {
    if (!bookingId) return;
    setLoading(true);
    getMyCoverOptions(bookingId)
      .then(setInfo)
      .catch(() => setInfo(null))
      .finally(() => setLoading(false));
  }, [bookingId]);
  useEffect(() => { load(); }, [load]);

  const pick = async (offerId: string) => {
    if (!bookingId) return;
    setBusy(offerId); setErr(null); setMsg(null);
    const r = await selectCover(bookingId, offerId);
    setBusy(null);
    if (r.ok) {
      setMsg('Your call has been moved to your chosen companion. You’re all set.');
      setTimeout(() => navigate(`/conversations/${bookingId}`), 1400);
    } else {
      setErr(r.outcome === 'offer_unavailable'
        ? 'That companion is no longer available — please choose another.'
        : 'We couldn’t transfer the call. Please try another companion.');
      load();
    }
  };

  const reschedule = async () => {
    if (!bookingId || !newTime) return;
    setBusy('reschedule'); setErr(null); setMsg(null);
    const r = await rescheduleMyBooking(bookingId, new Date(newTime).toISOString());
    setBusy(null);
    if (r.ok) {
      setMsg('Your call has been moved. Your credit stays with the new time.');
      setTimeout(() => navigate(`/conversations/${bookingId}`), 1400);
    } else {
      setErr(
        r.reason === 'too_late' ? 'That’s too close to the start — calls can only be moved 2+ hours ahead.'
        : r.reason === 'too_soon' ? 'Please choose a time a little further out.'
        : r.reason === 'slot_taken' ? 'That time isn’t free — please pick another.'
        : 'We couldn’t move the call. Please try another time.',
      );
    }
  };

  const cancel = async () => {
    if (!bookingId) return;
    if (!window.confirm('Cancel this call? If it’s 2+ hours away your credit is refunded; inside 2 hours the credit is used.')) return;
    setBusy('cancel'); setErr(null);
    const r = await cancelMyBooking(bookingId, 'Cancelled from cover selection');
    setBusy(null);
    if (r.ok) { setMsg('Your call has been cancelled.'); setTimeout(() => navigate('/conversations'), 1200); }
    else setErr('We couldn’t cancel just now. Please try again.');
  };

  return (
    <div>
      <PageHeader
        title="Choose a companion"
        subtitle={info?.originalCompanion
          ? `${info.originalCompanion} can no longer take your call — here are companions available instead.`
          : 'Your companion can no longer take your call — here are others available instead.'}
      />

      {loading && <p className="muted small"><Loader2 size={15} className="spin" aria-hidden="true" /> Loading…</p>}

      {!loading && info && (
        <>
          <p className="small muted" style={{ marginTop: 0 }}>
            <CalendarClock size={14} aria-hidden="true" /> {whenLabel(info.startsAt, info.timezone)}
          </p>

          {msg && <p className="small" role="status" style={{ color: 'var(--color-success-text)' }}>{msg}</p>}
          {err && <p className="small" role="alert" style={{ color: 'var(--color-danger-text)' }}>{err}</p>}

          {info.options.length === 0 ? (
            <p className="muted">No companions have accepted yet. Please check back shortly, or reschedule/cancel below.</p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14, marginTop: 8 }}>
              {info.options.map((c) => (
                <div key={c.offer_id} className="card col" style={{ gap: 8, padding: 16 }}>
                  <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                    {c.photo_url ? (
                      <img src={c.photo_url} alt="" width={44} height={44} style={{ borderRadius: '50%', objectFit: 'cover' }} />
                    ) : (
                      <span aria-hidden="true" style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--color-brand-soft, #FBE9DE)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: 'var(--color-brand-strong, #C8643D)' }}>
                        {(c.first_name || '?').charAt(0).toUpperCase()}
                      </span>
                    )}
                    <strong>{c.first_name}{c.last_name ? ` ${c.last_name.charAt(0)}.` : ''}</strong>
                  </div>
                  {c.bio && <span className="muted small" style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{c.bio}</span>}
                  <div className="row wrap" style={{ gap: 8, marginTop: 4, alignItems: 'center' }}>
                    <button className="btn btn-primary btn-small"
                            disabled={busy !== null} onClick={() => void pick(c.offer_id)}>
                      {busy === c.offer_id ? <Loader2 size={14} className="spin" aria-hidden="true" /> : null} Choose {c.first_name}
                    </button>
                    <Link className="btn btn-ghost btn-small" to={`/people/${c.companion_profile_id}`}>
                      View full profile
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="row wrap" style={{ gap: 8, marginTop: 20 }}>
            <button className="btn btn-secondary btn-small" disabled={busy !== null}
                    onClick={() => setShowReschedule((s) => !s)}>
              <RotateCcw size={14} aria-hidden="true" /> Reschedule instead
            </button>
            <button className="btn btn-ghost btn-small" disabled={busy !== null} onClick={() => void cancel()}>
              <XCircle size={14} aria-hidden="true" /> Cancel this call
            </button>
          </div>

          {showReschedule && (
            <div className="col" style={{ gap: 8, marginTop: 12, maxWidth: 320 }}>
              <label className="small muted" htmlFor="cover-new-time">Pick a new time (2+ hours from now)</label>
              <input
                id="cover-new-time"
                type="datetime-local"
                className="input"
                value={newTime}
                onChange={(e) => setNewTime(e.target.value)}
              />
              <p className="small muted" style={{ margin: 0 }}>Your credit stays with the call — no extra credit is used.</p>
              <button className="btn btn-primary btn-small" disabled={busy !== null || !newTime}
                      onClick={() => void reschedule()}>
                Confirm new time
              </button>
            </div>
          )}
        </>
      )}

      {!loading && !info && (
        <p className="muted">We couldn’t load this call’s cover options. It may already be sorted, or the link may have expired.</p>
      )}
    </div>
  );
}
