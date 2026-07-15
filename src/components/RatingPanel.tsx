/**
 * Stage 2E2B — rating UI for COMPLETED conversations (Supabase mode).
 *
 * One-way product model: the MEMBER side rates the Companion. The panel is
 * rendered only for completed bookings where the signed-in account is the
 * member side; the server re-verifies everything. One rating per pair —
 * an existing rating is loaded and updated, never duplicated.
 *
 * Uses ratingRepository only (never Supabase directly). Rating has no
 * payment, credit or notification side effects, and says so with silence.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { MyBookingRow, RatingRow } from '../supabase/database.types';
import {
  getRatingForPair,
  RatingError,
  submitRating,
} from '../repositories/ratingRepository';
import { useAuthSnapshot } from '../state/authBridge';
import { StarInput } from './ui';

export function RatingPanel({ booking }: { booking: MyBookingRow }) {
  const auth = useAuthSnapshot();

  // Member side only: the account that booked, or one with can_book access
  // to the Member — and NEVER an account on the companion side.
  const isCompanionSide = useMemo(
    () => auth.profiles.some((p) => p.profile.id === booking.companion_profile_id),
    [auth.profiles, booking.companion_profile_id],
  );
  const isMemberSide = useMemo(
    () =>
      booking.booked_by_account_id === auth.userId ||
      auth.profiles.some(
        (p) => p.profile.id === booking.member_profile_id && p.access.can_book,
      ),
    [auth.userId, auth.profiles, booking.member_profile_id],
  );
  const eligible = booking.status === 'completed' && isMemberSide && !isCompanionSide;

  const [existing, setExisting] = useState<RatingRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [score, setScore] = useState(0);
  const [publicComment, setPublicComment] = useState('');
  const [privateFeedback, setPrivateFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rating = await getRatingForPair(booking.member_profile_id, booking.companion_profile_id);
      setExisting(rating);
      if (rating) {
        setScore(rating.score);
        setPublicComment(rating.public_comment ?? '');
        setPrivateFeedback(rating.private_feedback ?? '');
      }
    } catch {
      // A failed prefill only means "treat as new" — submitting still works.
    } finally {
      setLoading(false);
    }
  }, [booking.member_profile_id, booking.companion_profile_id]);

  useEffect(() => {
    if (eligible) void load();
  }, [eligible, load]);

  if (!eligible) return null;

  if (loading) {
    return (
      <section className="section-tight" aria-label="Rate this conversation">
        <div className="row" style={{ gap: 10 }}>
          <Loader2 size={18} aria-hidden="true" />
          <span className="muted">Checking your rating…</span>
        </div>
      </section>
    );
  }

  const submit = async () => {
    if (submitting || score < 1) return; // duplicate-click protection
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      const row = await submitRating(booking.id, {
        score,
        publicComment: publicComment.trim() || undefined,
        privateFeedback: privateFeedback.trim() || undefined,
      });
      setExisting(row);
      setSaved(true);
    } catch (e) {
      setError(e instanceof RatingError ? e.message : 'That didn’t work. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="section-tight" aria-label="Rate this conversation">
      <h2>{existing ? `Your rating of ${booking.companion_first_name}` : `Rate ${booking.companion_first_name}`}</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        One rating per person — a later conversation updates it, never stacks.
      </p>

      {saved && (
        <p role="status" className="muted" style={{ margin: '0 0 10px' }}>
          Rating saved — thank you.
        </p>
      )}
      {error && (
        <p role="alert" className="badge badge-danger" style={{ display: 'block', marginBottom: 10 }}>
          {error}
        </p>
      )}

      <div className="col" style={{ gap: 12, maxWidth: 520 }}>
        <StarInput value={score} onChange={(v) => { setScore(v); setSaved(false); }} />
        <label className="col" style={{ gap: 6 }}>
          <span className="bold">Public review (optional)</span>
          <textarea
            value={publicComment}
            maxLength={1000}
            onChange={(e) => setPublicComment(e.target.value)}
            placeholder="Shown on their profile"
          />
        </label>
        <label className="col" style={{ gap: 6 }}>
          <span className="bold">Private feedback (optional)</span>
          <textarea
            value={privateFeedback}
            maxLength={2000}
            onChange={(e) => setPrivateFeedback(e.target.value)}
            placeholder="Only seen by the platform team — never shown publicly"
          />
        </label>
        <button
          className="btn btn-primary"
          style={{ alignSelf: 'flex-start' }}
          disabled={score < 1 || submitting}
          onClick={() => void submit()}
        >
          {submitting ? 'Saving…' : existing ? 'Update rating' : 'Submit rating'}
        </button>
      </div>
    </section>
  );
}
