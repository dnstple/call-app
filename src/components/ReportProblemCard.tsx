/**
 * "Report a problem" — coordinator/member-side action on a completed FUNDED
 * conversation.
 *
 * Server-authoritative: it renders only when get_review_state says the caller is
 * the eligible (funded) member side, the conversation has ended, and NO issue is
 * already open — so a duplicate open issue cannot be started from the UI (the
 * report_conversation_issue RPC also enforces one active issue per booking). It
 * NEVER writes conversation_issues directly; it calls the secure RPC, which
 * derives role, validates the category/description and dedupes. Only the short
 * category + description are sent; no internal support fields are read or shown.
 * On success the parent reloads the outcome/issue state.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { getSupabaseClient } from '../supabase/client';
import { isSupabaseMode } from '../config/dataMode';

// The coordinator-side categories the RPC accepts (0034). Companion-only
// categories are intentionally excluded.
const CATEGORIES: { value: string; label: string }[] = [
  { value: 'companion_no_show', label: 'The companion didn’t attend' },
  { value: 'member_no_show', label: 'The member couldn’t attend' },
  { value: 'audio_video_problem', label: 'Audio or video problems' },
  { value: 'platform_technical_problem', label: 'A technical problem with the app' },
  { value: 'ended_early', label: 'The conversation ended early' },
  { value: 'incorrect_duration', label: 'The length wasn’t right' },
  { value: 'inappropriate_or_concerning_behaviour', label: 'Concerning or unsafe behaviour' },
  { value: 'other', label: 'Something else' },
];

function mapReportError(message: string): string {
  const m = (message ?? '').toLowerCase();
  if (m.includes('too_early')) return 'You can report a problem once the conversation has ended.';
  if (m.includes('description_required')) return 'Please describe what happened.';
  if (m.includes('invalid_category')) return 'Please choose a valid option.';
  if (m.includes('not_found')) return 'This conversation isn’t available to report.';
  return 'We couldn’t send your report. Please try again.';
}

export function ReportProblemCard({ bookingId, onReported }: {
  bookingId: string;
  /** Called after a successful report so the page can reload outcome/issue state. */
  onReported?: () => void;
}) {
  const [gate, setGate] = useState<{ ended: boolean; eligible: boolean; issueExists: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!isSupabaseMode()) return;
    getSupabaseClient().rpc('get_review_state', { p_booking: bookingId }).then(({ data, error: e }) => {
      if (e || !data) return;
      const r = data as Record<string, unknown>;
      setGate({ ended: Boolean(r.ended), eligible: Boolean(r.eligible), issueExists: Boolean(r.issue_exists) });
    });
  }, [bookingId]);

  useEffect(() => { load(); }, [load]);

  // Only the eligible funded member side, after the conversation ends, and only
  // while no issue is already open (duplicate-open prevention).
  if (!isSupabaseMode() || gate === null || !gate.ended || !gate.eligible || gate.issueExists) return null;

  const submit = async () => {
    if (busy) return;
    if (!category) { setError('Please choose what went wrong.'); return; }
    if (description.trim() === '') { setError('Please describe the problem.'); return; }
    setBusy(true);
    setError(null);
    const { error: e } = await getSupabaseClient().rpc('report_conversation_issue', {
      p_booking: bookingId,
      p_category: category,
      p_description: description.trim(),
    });
    if (e) {
      setError(mapReportError(String(e.message ?? '')));
      setBusy(false);
      return;
    }
    // Authoritative reload: our own gate (→ issue now open, card hides) and the
    // parent's outcome/issue state.
    setOpen(false);
    setBusy(false);
    load();
    onReported?.();
  };

  if (!open) {
    return (
      <section className="card col" style={{ gap: 6 }} aria-label="Report a problem">
        <p className="muted small" style={{ margin: 0 }}>Something go wrong with this conversation?</p>
        <button
          className="btn btn-secondary btn-small"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => { setOpen(true); setError(null); }}
        >
          <AlertTriangle size={14} aria-hidden="true" /> Report a problem
        </button>
      </section>
    );
  }

  return (
    <section className="card col" style={{ gap: 10 }} aria-label="Report a problem">
      <h3 style={{ margin: 0, fontSize: '1.05em' }}>Report a problem</h3>
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor={`report-cat-${bookingId}`}>What went wrong?</label>
        <select
          id={`report-cat-${bookingId}`}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">Choose an option…</option>
          {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor={`report-desc-${bookingId}`}>Tell us what happened</label>
        <textarea
          id={`report-desc-${bookingId}`}
          rows={3}
          maxLength={4000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <span className="faint small">{description.length}/4000</span>
      </div>
      {error && <p className="small" role="alert" style={{ margin: 0, color: 'var(--color-danger-text)' }}>{error}</p>}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-small" disabled={busy} onClick={() => void submit()}>
          {busy ? <Loader2 size={14} aria-hidden="true" /> : null} Submit report
        </button>
        <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>
          Cancel
        </button>
      </div>
      <p className="faint small" style={{ margin: 0 }}>
        Our team will review it. We’ll let you know when it’s resolved.
      </p>
    </section>
  );
}
