/**
 * Permanent feedback button for Companion accounts — fixed bottom-right, opens a
 * form with a star rating, feedback, "ideas to improve the platform", and a
 * "may we reach out?" tickbox. Submissions are stored, mirrored to the contact
 * inbox, and emailed to support. Renders only for owners of a companion profile.
 */
import { useState } from 'react';
import { MessageSquarePlus, Star, X, Loader2, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { submitCompanionFeedback } from '../repositories/feedbackRepository';

export function FeedbackWidget() {
  const auth = useAuth();
  const isCompanion = auth.profiles.some(
    (p) => p.access.access_role === 'owner' && p.profile.role === 'companion',
  );

  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [ideas, setIdeas] = useState('');
  const [contactOk, setContactOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!isCompanion) return null;

  const reset = () => {
    setRating(0); setHover(0); setFeedback(''); setIdeas(''); setContactOk(false); setDone(false); setErr(null);
  };
  const close = () => { setOpen(false); reset(); };

  const submit = async () => {
    if (rating === 0 && !feedback.trim() && !ideas.trim()) {
      setErr('Please add a rating or a note before sending.');
      return;
    }
    setBusy(true); setErr(null);
    const r = await submitCompanionFeedback({ rating, feedback, ideas, contactOk });
    setBusy(false);
    if (r.ok) setDone(true);
    else setErr('We couldn’t send that just now — please try again.');
  };

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Give feedback"
          style={{
            position: 'fixed', right: 18, bottom: 84, zIndex: 900,
            display: 'inline-flex', alignItems: 'center', gap: 8,
            background: 'var(--deep-apricot, #C8643D)', color: '#fff', border: 'none',
            borderRadius: 999, padding: '11px 16px', fontWeight: 600, cursor: 'pointer',
            boxShadow: '0 4px 14px rgba(32,28,25,0.28)',
          }}
        >
          <MessageSquarePlus size={18} aria-hidden="true" /> Feedback
        </button>
      )}

      {open && (
        <div role="dialog" aria-modal="true" aria-label="Give feedback" onClick={close}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(32,28,25,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} className="card"
            style={{ maxWidth: 460, width: '100%', position: 'relative', padding: 24, borderRadius: 16, maxHeight: '90vh', overflowY: 'auto' }}>
            <button aria-label="Close" onClick={close}
              style={{ position: 'absolute', top: 12, right: 12, background: 'none', border: 'none', cursor: 'pointer' }}>
              <X size={20} aria-hidden="true" />
            </button>

            {done ? (
              <div className="col" style={{ gap: 12, alignItems: 'center', textAlign: 'center', padding: '8px 0' }}>
                <CheckCircle2 size={30} aria-hidden="true" style={{ color: 'var(--deep-apricot, #C8643D)' }} />
                <strong>Thank you for your feedback.</strong>
                <p className="muted small" style={{ margin: 0 }}>It really helps us improve Apricoti.</p>
                <button className="btn btn-primary" onClick={close}>Close</button>
              </div>
            ) : (
              <div className="col" style={{ gap: 14 }}>
                <h2 style={{ margin: 0, fontSize: '1.2rem' }}>Share your feedback</h2>
                {err && <p className="banner banner-danger" role="alert" style={{ margin: 0 }}>{err}</p>}

                <div className="col" style={{ gap: 4 }}>
                  <span style={{ fontSize: 13 }}>How would you rate your experience?</span>
                  <div className="row" style={{ gap: 4 }}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button key={n} type="button" aria-label={`${n} star${n === 1 ? '' : 's'}`}
                        onClick={() => setRating(n)} onMouseEnter={() => setHover(n)} onMouseLeave={() => setHover(0)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}>
                        <Star size={28} aria-hidden="true"
                          fill={(hover || rating) >= n ? 'var(--deep-apricot, #C8643D)' : 'none'}
                          color={(hover || rating) >= n ? 'var(--deep-apricot, #C8643D)' : 'var(--muted, #b8ada5)'} />
                      </button>
                    ))}
                  </div>
                </div>

                <label className="col" style={{ gap: 4, fontSize: 13 }}>
                  Your feedback
                  <textarea className="input" rows={4} value={feedback} onChange={(e) => setFeedback(e.target.value)}
                    placeholder="How are you finding Apricoti?" />
                </label>

                <label className="col" style={{ gap: 4, fontSize: 13 }}>
                  Your ideas to improve the platform
                  <textarea className="input" rows={4} value={ideas} onChange={(e) => setIdeas(e.target.value)}
                    placeholder="Anything you'd change or add?" />
                </label>

                <label className="row" style={{ gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
                  <input type="checkbox" checked={contactOk} onChange={(e) => setContactOk(e.target.checked)} style={{ marginTop: 3 }} />
                  <span>I’m happy for the Apricoti team to reach out to me about this.</span>
                </label>

                <div className="row" style={{ gap: 8 }}>
                  <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
                    {busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : null} Send feedback
                  </button>
                  <button className="btn btn-ghost" disabled={busy} onClick={close}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
