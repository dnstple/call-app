/**
 * 2G4B — Companion post-call attendance card ("Did the conversation take
 * place?"). The RPC is authoritative for every rule; this card only asks
 * the question, requires explanations for non-yes outcomes, prevents
 * double submission and then shows the REAL server state — never an
 * optimistic financial claim.
 */
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { getSupabaseClient } from '../supabase/client';
import { isSupabaseMode } from '../config/dataMode';

type Outcome = 'took_place' | 'member_no_show' | 'technical_problem' | 'other';

interface CompletionState {
  ended: boolean;
  funded: boolean;
  attendanceSubmitted: boolean;
  attendanceOutcome: string | null;
  earningState: string;
}

const OPTIONS: { value: Outcome; label: string; needsText: boolean; note?: string }[] = [
  { value: 'took_place', label: 'Yes, it took place', needsText: false },
  {
    value: 'member_no_show', label: 'Member did not attend', needsText: true,
    note: 'We’ll check the call attendance before confirming your earnings.',
  },
  {
    value: 'technical_problem', label: 'Technical problem', needsText: true,
    note: 'Your earnings will be held while this is reviewed.',
  },
  { value: 'other', label: 'Other issue', needsText: true },
];

/** Safe Companion-facing earning language ONLY. */
export function earningStateLabel(state: string, outcome: string | null): string {
  if (state === 'payable') return 'Earnings ready for payout';
  if (state === 'held_for_issue') return 'Attendance submitted — being reviewed';
  if (outcome === 'took_place') return 'Awaiting customer review';
  return 'Pending completion';
}

export function AttendanceCard({ bookingId, memberName, onConfirmed }: { bookingId: string; memberName: string; onConfirmed?: () => void }) {
  const [state, setState] = useState<CompletionState | null>(null);
  const [choice, setChoice] = useState<Outcome | null>(null);
  const [explanation, setExplanation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!isSupabaseMode()) return;
    getSupabaseClient().rpc('get_companion_completion_state', { p_booking: bookingId })
      .then(({ data, error: e }) => {
        if (e || !data) return;
        const r = data as Record<string, unknown>;
        setState({
          ended: Boolean(r.ended),
          funded: Boolean(r.funded),
          attendanceSubmitted: Boolean(r.attendance_submitted),
          attendanceOutcome: (r.attendance_outcome as string | null) ?? null,
          earningState: String(r.earning_state ?? 'pending_completion'),
        });
      });
  }, [bookingId]);

  useEffect(() => {
    load();
  }, [load]);

  // The server re-checks everything; the card renders only when it says so.
  if (!isSupabaseMode() || state === null || !state.ended || !state.funded) return null;

  if (state.attendanceSubmitted) {
    return (
      <section className="card col" style={{ gap: 8 }} aria-label="Conversation outcome">
        <div className="row" style={{ gap: 8 }}>
          <CheckCircle2 size={18} aria-hidden="true" style={{ color: 'var(--color-success-text)' }} />
          <span className="bold small">
            {state.attendanceOutcome === 'member_no_show' && state.earningState === 'payable'
              ? 'Attendance verified — earnings ready for payout'
              : earningStateLabel(state.earningState, state.attendanceOutcome)}
          </span>
        </div>
      </section>
    );
  }

  const selected = OPTIONS.find((o) => o.value === choice);
  const needsText = Boolean(selected?.needsText);

  const submit = async () => {
    if (busy || !choice) return;
    if (needsText && explanation.trim() === '') {
      setError('Please add a short description of what happened.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: e } = await getSupabaseClient().rpc('submit_companion_attendance', {
      p_booking: bookingId,
      p_outcome: choice,
      p_explanation: needsText ? explanation.trim() : null,
    });
    if (e) {
      setError(String(e.message ?? 'We couldn’t record that. Please try again.'));
    } else {
      onConfirmed?.(); // tell the page to refetch the booking → banner + list stay in sync
    }
    load(); // authoritative state, never optimistic
    setBusy(false);
  };

  return (
    <section className="card col" style={{ gap: 10 }} aria-label="Did the conversation take place">
      <h3 style={{ margin: 0 }}>Did the conversation take place?</h3>
      <div className="col" style={{ gap: 6 }} role="radiogroup" aria-label="Attendance outcome">
        {OPTIONS.map((o) => (
          <label key={o.value} className="card card-tight row" style={{ gap: 10, cursor: 'pointer' }}>
            <input
              type="radio"
              name={`attendance-${bookingId}`}
              checked={choice === o.value}
              onChange={() => setChoice(o.value)}
            />
            <span className="col" style={{ gap: 2 }}>
              <span className="bold small">{o.label}</span>
              {choice === o.value && o.note && <span className="muted small">{o.note}</span>}
            </span>
          </label>
        ))}
      </div>
      {needsText && (
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor={`att-why-${bookingId}`}>What happened?</label>
          <textarea
            id={`att-why-${bookingId}`}
            rows={3}
            maxLength={1000}
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
          />
          <span className="faint small">{explanation.length}/1000</span>
        </div>
      )}
      {error && <p className="small" role="alert" style={{ margin: 0, color: 'var(--color-danger-text)' }}>{error}</p>}
      <button
        className="btn btn-primary btn-small"
        style={{ alignSelf: 'flex-start' }}
        disabled={busy || !choice}
        onClick={() => void submit()}
      >
        {busy ? <Loader2 size={16} aria-hidden="true" /> : null} Submit
      </button>
      <p className="faint small" style={{ margin: 0 }}>
        Your conversation with {memberName}. Earnings become available after the
        completion checks finish.
      </p>
    </section>
  );
}
