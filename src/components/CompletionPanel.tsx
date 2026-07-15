/**
 * Stage 2E1B — completion confirmation UI (Supabase mode only).
 *
 * "Did this conversation take place?" for ended, confirmed conversations.
 * All reads/writes go through the booking repository (never Supabase
 * directly); the SERVER decides which side the account represents.
 *
 * Deliberately says nothing about payments, credits or ratings — recording
 * an outcome has no such side effects.
 */
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Flag, Loader2 } from 'lucide-react';
import type { MyBookingRow } from '../supabase/database.types';
import {
  canConfirmCompletion,
  CompletionError,
  getCompletionState,
  submitCompletionOutcome,
  type CompletionOutcome,
  type CompletionState,
} from '../repositories/bookingRepository';

const OUTCOME_LABELS: Record<CompletionOutcome, string> = {
  completed: 'Yes, it took place',
  did_not_happen: 'No, it did not happen',
  report_concern: 'Report a concern',
};

export function CompletionPanel({
  booking,
  onStatusChange,
}: {
  booking: MyBookingRow;
  onStatusChange?: () => void;
}) {
  const confirmable = canConfirmCompletion(booking);
  const [state, setState] = useState<CompletionState | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CompletionOutcome | null>(null);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setState(await getCompletionState(booking.id));
    } catch (e) {
      setLoadError(e instanceof CompletionError ? e.message : 'We couldn’t check the confirmation status.');
    } finally {
      setLoading(false);
    }
  }, [booking.id]);

  useEffect(() => {
    if (confirmable) void load();
  }, [confirmable, load]);

  /* ----- terminal outcomes need no fetch and show no controls ----- */
  if (booking.status === 'completed') {
    return (
      <section className="section-tight" aria-label="Conversation outcome">
        <div className="card card-muted row" style={{ gap: 10 }}>
          <CheckCircle2 size={20} aria-hidden="true" />
          <span>
            <strong>Completed</strong> — both sides confirmed this conversation took place.
          </span>
        </div>
      </section>
    );
  }
  if (booking.status === 'needs_review') {
    return (
      <section className="section-tight" aria-label="Conversation outcome">
        <div className="card card-muted row" style={{ gap: 10 }}>
          <Flag size={20} aria-hidden="true" />
          <span>
            <strong>Needs review</strong> — this conversation has been flagged and the team will look
            into it. No further action is needed from you.
          </span>
        </div>
      </section>
    );
  }

  // Before the scheduled end (or for non-confirmed statuses): nothing at all.
  if (!confirmable) return null;

  if (loading && !state) {
    return (
      <section className="section-tight" aria-label="Conversation outcome">
        <div className="row" style={{ gap: 10 }}>
          <Loader2 size={18} aria-hidden="true" />
          <span className="muted">Checking confirmation status…</span>
        </div>
      </section>
    );
  }

  if (loadError) {
    return (
      <section className="section-tight" aria-label="Conversation outcome">
        <p className="muted" role="alert">{loadError}</p>
        <button className="btn btn-secondary btn-small" onClick={() => void load()}>Try again</button>
      </section>
    );
  }

  if (!state) return null;
  // Not a participant (server said so): never show the form.
  if (!state.yourSide) return null;

  const mine = state.yourSide === 'member' ? state.member : state.companion;
  const showForm = editing || !mine;

  const submit = async () => {
    if (!outcome || submitting) return; // duplicate-click protection
    setSubmitting(true);
    setSubmitError(null);
    setSaved(false);
    try {
      const next = await submitCompletionOutcome(booking.id, outcome, note.trim() || undefined);
      setState(next);
      setEditing(false);
      setSaved(true);
      setOutcome(null);
      setNote('');
      if (next.status !== 'confirmed') onStatusChange?.();
    } catch (e) {
      setSubmitError(e instanceof CompletionError ? e.message : 'That didn’t work. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="section-tight" aria-label="Conversation outcome">
      <h2>Did this conversation take place?</h2>

      {saved && !editing && (
        <p role="status" className="muted" style={{ margin: '0 0 10px' }}>Saved — thank you.</p>
      )}
      {submitError && (
        <p role="alert" className="badge badge-danger" style={{ display: 'block', marginBottom: 10 }}>
          {submitError}
        </p>
      )}

      {!showForm && mine && (
        <div className="card card-tight col" style={{ gap: 8, maxWidth: 520 }}>
          <span>
            Your answer: <strong>{OUTCOME_LABELS[mine.outcome]}</strong>
            {mine.note ? <span className="muted"> — “{mine.note}”</span> : null}
          </span>
          <span className="muted">Waiting for the other person to confirm.</span>
          <button
            className="btn btn-ghost btn-small"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => {
              setEditing(true);
              setOutcome(mine.outcome);
              setNote(mine.note ?? '');
              setSaved(false);
            }}
          >
            Change my answer
          </button>
        </div>
      )}

      {showForm && (
        <div className="col" style={{ gap: 12, maxWidth: 520 }}>
          <div className="col" style={{ gap: 8 }} role="radiogroup" aria-label="Did this conversation take place?">
            {(Object.keys(OUTCOME_LABELS) as CompletionOutcome[]).map((o) => (
              <label key={o} className="card card-tight row" style={{ cursor: 'pointer', gap: 10 }}>
                <input
                  type="radio"
                  name="completion-outcome"
                  checked={outcome === o}
                  onChange={() => setOutcome(o)}
                />
                <span>{OUTCOME_LABELS[o]}</span>
              </label>
            ))}
          </div>
          <label className="col" style={{ gap: 6 }}>
            <span className="bold">Add a note (optional)</span>
            <textarea
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Anything you’d like to add"
            />
          </label>
          <div className="row" style={{ gap: 10 }}>
            <button className="btn btn-primary" disabled={!outcome || submitting} onClick={() => void submit()}>
              {submitting ? 'Saving…' : 'Save my answer'}
            </button>
            {editing && (
              <button className="btn btn-ghost" disabled={submitting} onClick={() => setEditing(false)}>
                Back
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
