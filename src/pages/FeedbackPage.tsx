/**
 * Post-call feedback page (/feedback/:bookingId). A 1–5 star rating and a notes
 * box for either participant. Reached from the after-call in-app note / SMS.
 */
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Star, Loader2, CheckCircle2 } from 'lucide-react';
import { getFeedbackContext, submitCallFeedback, type FeedbackContext } from '../repositories/feedbackRepository';

function fmt(iso?: string): string {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
  } catch { return iso; }
}

export default function FeedbackPage() {
  const { bookingId } = useParams();
  const [ctx, setCtx] = useState<FeedbackContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [stars, setStars] = useState(0);
  const [hover, setHover] = useState(0);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (!bookingId) { setLoading(false); return; }
    getFeedbackContext(bookingId).then((c) => {
      if (!live) return;
      setCtx(c);
      if (c.alreadySubmitted) setDone(true);
      setLoading(false);
    });
    return () => { live = false; };
  }, [bookingId]);

  const submit = async () => {
    if (!bookingId || stars < 1) { setErr('Please choose a star rating.'); return; }
    setBusy(true); setErr(null);
    const r = await submitCallFeedback(bookingId, stars, notes.trim());
    setBusy(false);
    if (r.ok) setDone(true);
    else setErr('We couldn’t save your feedback just now. Please try again.');
  };

  const shell = (children: React.ReactNode) => (
    <div className="col" style={{ maxWidth: 460, margin: '0 auto', gap: 16, padding: '24px 0' }}>
      <header className="col" style={{ gap: 4 }}>
        <span className="section-label">Your feedback</span>
      </header>
      {children}
      <p className="muted small" style={{ textAlign: 'center' }}><Link to="/">Go to Apricoti</Link></p>
    </div>
  );

  if (loading) return shell(<div className="row" style={{ justifyContent: 'center', padding: 24 }}><Loader2 size={22} className="spin" aria-hidden="true" /></div>);

  if (!bookingId || (ctx && !ctx.ok)) {
    return shell(<div className="card"><p style={{ margin: 0 }}>We couldn’t find this call, or it isn’t yours to review.</p></div>);
  }

  if (done) {
    return shell(
      <div className="card col" style={{ gap: 12, alignItems: 'center', textAlign: 'center', padding: '24px 20px' }}>
        <CheckCircle2 size={32} aria-hidden="true" style={{ color: 'var(--deep-apricot, #C8643D)' }} />
        <strong style={{ fontSize: '1.1em' }}>Thank you for your feedback</strong>
        <p className="muted" style={{ margin: 0 }}>
          We’ll take it on board to improve Apricoti. We’re still in a pilot development phase and are making
          improvements rapidly to give everyone a better experience.
        </p>
      </div>,
    );
  }

  return shell(
    <div className="card col" style={{ gap: 16 }}>
      <div className="col" style={{ gap: 4 }}>
        <h1 style={{ margin: 0, fontSize: '1.2rem' }}>How was your call?</h1>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {ctx?.counterpart ? `Your ${ctx.durationMinutes ?? 45}-minute call with ${ctx.counterpart}` : 'Your recent call'}
          {ctx?.startsAt ? ` · ${fmt(ctx.startsAt)}` : ''}
        </p>
      </div>

      {err && <p className="banner banner-danger" role="alert" style={{ margin: 0 }}>{err}</p>}

      <div className="row" style={{ gap: 6, justifyContent: 'center' }} role="radiogroup" aria-label="Star rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`${n} star${n === 1 ? '' : 's'}`}
            aria-pressed={stars === n}
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(0)}
            onClick={() => setStars(n)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}
          >
            <Star
              size={40}
              aria-hidden="true"
              fill={(hover || stars) >= n ? 'var(--deep-apricot, #C8643D)' : 'none'}
              color={(hover || stars) >= n ? 'var(--deep-apricot, #C8643D)' : 'var(--color-text-muted, #9a9)'}
            />
          </button>
        ))}
      </div>

      <label className="col" style={{ gap: 4, fontSize: 14 }}>
        Anything you’d like to tell us? (optional)
        <textarea
          className="input"
          rows={4}
          maxLength={2000}
          value={notes}
          disabled={busy}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What went well, or what could be better?"
          style={{ width: '100%', resize: 'vertical' }}
        />
      </label>

      <button className="btn btn-primary btn-large" disabled={busy || stars < 1} onClick={submit}>
        {busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : null} Submit feedback
      </button>
    </div>,
  );
}
