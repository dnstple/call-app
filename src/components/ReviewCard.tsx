/**
 * 2G4C — Coordinator post-call review card.
 *
 * "How was Mary's conversation with Daniel?" — optional keyboard-
 * accessible stars, "Everything was fine" approval without stars,
 * private platform feedback, one optional private message to the
 * Companion (sent once under the Coordinator's own identity), a 24-hour
 * edit window for stars/feedback, and open-issue suppression. The RPC is
 * authoritative; the card renders only what get_review_state permits.
 *
 * NOTE: the 0034 RPC signature is fixed, so the 4th argument
 * (p_message_idempotency) carries the message TEXT on initial
 * submission; the server derives the deterministic idempotency key and
 * never resends on edits.
 */
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Star } from 'lucide-react';
import { getSupabaseClient } from '../supabase/client';
import { isSupabaseMode } from '../config/dataMode';

const STAR_LABELS = ['1 Poor', '2 Fair', '3 Good', '4 Very good', '5 Excellent'];

interface ReviewState {
  ended: boolean;
  eligible: boolean;
  reviewSubmitted: boolean;
  editable: boolean;
  editableUntil: string | null;
  rating: number | null;
  privateFeedback: string | null;
  messageSent: boolean;
  issueExists: boolean;
  attendanceConfirmed: boolean;
  earningState: string;
}

export function ReviewCard({ bookingId, memberName, companionName, onConfirmed }: {
  bookingId: string; memberName: string; companionName: string; onConfirmed?: () => void;
}) {
  const [state, setState] = useState<ReviewState | null>(null);
  const [stars, setStars] = useState<number | null>(null);
  const [feedback, setFeedback] = useState('');
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!isSupabaseMode()) return;
    getSupabaseClient().rpc('get_review_state', { p_booking: bookingId })
      .then(({ data, error: e }) => {
        if (e || !data) return;
        const r = data as Record<string, unknown>;
        const s: ReviewState = {
          ended: Boolean(r.ended),
          eligible: Boolean(r.eligible),
          reviewSubmitted: Boolean(r.review_submitted),
          editable: Boolean(r.editable),
          editableUntil: (r.editable_until as string | null) ?? null,
          rating: (r.rating as number | null) ?? null,
          privateFeedback: (r.private_feedback as string | null) ?? null,
          messageSent: Boolean(r.message_sent),
          issueExists: Boolean(r.issue_exists),
          attendanceConfirmed: Boolean(r.attendance_confirmed),
          earningState: String(r.earning_state ?? 'pending_completion'),
        };
        setState(s);
        setStars(s.rating);
        setFeedback(s.privateFeedback ?? '');
      });
  }, [bookingId]);

  useEffect(() => {
    load();
  }, [load]);

  // Server-authoritative visibility: real, funded, ended bookings only.
  if (!isSupabaseMode() || state === null || !state.ended || !state.eligible) return null;

  if (state.issueExists) {
    return (
      <section className="card col" style={{ gap: 6 }} aria-label="Conversation review">
        <span className="bold small">This conversation is under review.</span>
        <span className="muted small">We’ll let you know once the issue is resolved.</span>
      </section>
    );
  }

  if (state.reviewSubmitted && !editing) {
    return (
      <section className="card col" style={{ gap: 8 }} aria-label="Conversation review">
        <div className="row" style={{ gap: 8 }}>
          <CheckCircle2 size={18} aria-hidden="true" style={{ color: 'var(--color-success-text)' }} />
          <span className="bold small">
            {state.rating
              ? `You rated this conversation ${state.rating} star${state.rating === 1 ? '' : 's'}.`
              : 'You confirmed everything was fine.'}
          </span>
        </div>
        {!state.attendanceConfirmed && state.earningState === 'pending_completion' && (
          <span className="muted small">Awaiting {companionName}’s confirmation.</span>
        )}
        {state.messageSent && <span className="muted small">Message sent to {companionName}</span>}
        {state.editable ? (
          <div className="col" style={{ gap: 4 }}>
            <button className="btn btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => setEditing(true)}>
              Edit review
            </button>
            {state.editableUntil && (
              <span className="faint small">
                You can edit your rating and private feedback until{' '}
                {new Date(state.editableUntil).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'long' })}.
              </span>
            )}
          </div>
        ) : (
          <span className="faint small">Editing has closed for this review.</span>
        )}
      </section>
    );
  }

  const submit = async (fine: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const { error: e } = await getSupabaseClient().rpc('submit_conversation_review', {
      p_booking: bookingId,
      p_rating: fine ? null : stars,
      p_feedback: feedback.trim() === '' ? null : feedback.trim(),
      // Initial submission only: carries the optional message text; the
      // server sends it ONCE and never resends on edits.
      p_message_idempotency: editing || message.trim() === '' ? null : message.trim(),
    });
    if (e) setError(String(e.message ?? 'We couldn’t save your review. Please try again.'));
    else onConfirmed?.(); // tell the page to refetch the booking → banner + list stay in sync
    setEditing(false);
    setMessage('');
    load(); // authoritative refresh
    setBusy(false);
  };

  return (
    <section className="card col" style={{ gap: 12 }} aria-label="Conversation review">
      <h3 style={{ margin: 0 }}>How was {memberName}’s conversation with {companionName}?</h3>

      <div className="row" style={{ gap: 4 }} role="radiogroup" aria-label="Star rating (optional)">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            className="icon-btn"
            role="radio"
            aria-checked={stars === n}
            aria-label={STAR_LABELS[n - 1]}
            title={STAR_LABELS[n - 1]}
            onClick={() => setStars(stars === n ? null : n)}
          >
            <Star
              size={24}
              aria-hidden="true"
              fill={stars !== null && n <= stars ? 'var(--color-brand)' : 'none'}
              style={{ color: stars !== null && n <= stars ? 'var(--color-brand-strong)' : 'var(--color-text-muted)' }}
            />
          </button>
        ))}
        {stars !== null && <span className="muted small">{STAR_LABELS[stars - 1]}</span>}
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor={`rev-fb-${bookingId}`}>Private feedback for us</label>
        <textarea
          id={`rev-fb-${bookingId}`}
          rows={3}
          maxLength={2000}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
        <span className="faint small">
          This feedback is private and will only be seen by our support team. {feedback.length}/2000
        </span>
      </div>

      {!editing && (
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor={`rev-msg-${bookingId}`}>Message to {companionName}</label>
          <textarea
            id={`rev-msg-${bookingId}`}
            rows={3}
            maxLength={1000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <span className="faint small">
            This message will be sent directly to {companionName} from you as{' '}
            {memberName}’s Coordinator. {message.length}/1000
          </span>
        </div>
      )}
      {editing && state.messageSent && (
        <span className="muted small">Message sent to {companionName} — messages can’t be edited here.</span>
      )}

      {error && <p className="small" role="alert" style={{ margin: 0, color: 'var(--color-danger-text)' }}>{error}</p>}

      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-small" disabled={busy} onClick={() => void submit(false)}>
          {busy ? <Loader2 size={16} aria-hidden="true" /> : null} Submit review
        </button>
        {!editing && (
          <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => void submit(true)}>
            Everything was fine
          </button>
        )}
        {editing && (
          <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => { setEditing(false); load(); }}>
            Cancel
          </button>
        )}
      </div>
      <p className="faint small" style={{ margin: 0 }}>
        Stars are optional. “Everything was fine” simply approves the
        conversation without a rating.
      </p>
    </section>
  );
}
