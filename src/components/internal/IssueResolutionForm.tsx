/**
 * Internal issue-resolution form (Phase 2G4E, support/admin only).
 *
 * Presents the FOUR authoritative outcomes, a required internal note, and an
 * explicit review step (never browser confirm()). It holds NO financial
 * logic: it only collects inputs and delegates to resolve_conversation_issue,
 * which derives every amount, actor and credit rule server-side and is atomic
 * + idempotent. Money is shown in pounds; the RPC receives integer minor
 * units. One stable idempotency token per issue guarantees a single winner
 * under concurrency and duplicate clicks.
 */
import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { formatMinor } from '../../repositories/availabilityRepository';
import {
  InternalIssueError,
  resolveConversationIssue,
  type IssueDetail,
  type ResolutionOutcome,
} from '../../repositories/internalIssueRepository';

const NOTE_MAX = 2000;

const OUTCOMES: { value: ResolutionOutcome; label: string; hint: string }[] = [
  { value: 'companion_payable_full', label: 'Pay Companion in full', hint: 'Full entitlement becomes ready for payout.' },
  { value: 'customer_credit_full', label: 'Credit customer in full', hint: 'Full customer-paid amount as account credit.' },
  { value: 'partial_resolution', label: 'Partial resolution', hint: 'Split between Companion payout and customer credit.' },
  { value: 'issue_dismissed_release', label: 'Dismiss issue and release earning', hint: 'Complaint dismissed; full earning becomes payable.' },
];

/** Pounds string → integer minor units, or null when not a clean amount. */
function poundsToMinor(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 100);
}

export function IssueResolutionForm({ detail, onResolved }: {
  detail: IssueDetail;
  onResolved: () => void;
}) {
  const currency = detail.currency;
  const maxTotalMinor = detail.customerTotalMinor ?? 0;
  const maxCompanionMinor = detail.companionEntitlementMinor ?? 0;

  const [outcome, setOutcome] = useState<ResolutionOutcome | null>(null);
  const [note, setNote] = useState('');
  const [companionPounds, setCompanionPounds] = useState('');
  const [creditPounds, setCreditPounds] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const companionMinor = poundsToMinor(companionPounds);
  const creditMinor = poundsToMinor(creditPounds);

  // Real-time partial validation mirrors the server rules exactly.
  const partialError = useMemo<string | null>(() => {
    if (outcome !== 'partial_resolution') return null;
    if (companionPounds.trim() === '' && creditPounds.trim() === '') return 'Enter at least one amount.';
    if ((companionPounds.trim() !== '' && companionMinor === null)
        || (creditPounds.trim() !== '' && creditMinor === null)) {
      return 'Amounts must be pounds with at most two decimals.';
    }
    const c = companionMinor ?? 0;
    const k = creditMinor ?? 0;
    if (c < 0 || k < 0) return 'Amounts cannot be negative.';
    if (c > maxCompanionMinor) return `Companion amount cannot exceed ${formatMinor(maxCompanionMinor, currency)}.`;
    if (k > maxTotalMinor) return `Customer credit cannot exceed ${formatMinor(maxTotalMinor, currency)}.`;
    if (c + k > maxTotalMinor) return `Combined amount cannot exceed ${formatMinor(maxTotalMinor, currency)}.`;
    if (c + k === 0) return 'Enter at least one non-zero amount.';
    return null;
  }, [outcome, companionPounds, creditPounds, companionMinor, creditMinor, maxCompanionMinor, maxTotalMinor, currency]);

  const unallocatedMinor = maxTotalMinor - (companionMinor ?? 0) - (creditMinor ?? 0);

  const noteError = note.trim() === '' ? 'An internal resolution note is required.' : null;
  const canReview = !!outcome && !noteError && !partialError;

  const submit = async () => {
    if (!outcome || submitting || !canReview) return; // duplicate-click protection
    setSubmitting(true);
    setError(null);
    try {
      await resolveConversationIssue({
        issueId: detail.issueId,
        outcome,
        note: note.trim(),
        companionMinor: outcome === 'partial_resolution' ? companionMinor ?? 0 : undefined,
        creditMinor: outcome === 'partial_resolution' ? creditMinor ?? 0 : undefined,
        // Stable per-issue token: one immutable resolution; concurrent or
        // duplicate attempts collapse to a single winner (repeat = no-op).
        idempotencyKey: `resolve-${detail.issueId}`,
      });
      onResolved(); // authoritative refetch shows the resolved, read-only state
    } catch (e) {
      setError(e instanceof InternalIssueError ? e.message : 'That didn’t work. Please try again.');
      setSubmitting(false);
    }
  };

  const selected = OUTCOMES.find((o) => o.value === outcome);

  /* ---------------- review step (explicit confirmation) ---------------- */
  if (reviewing && outcome) {
    return (
      <section className="card col" style={{ gap: 12 }} aria-label="Confirm resolution">
        <h3 style={{ margin: 0 }}>Confirm: {selected?.label}</h3>
        {outcome === 'companion_payable_full' && (
          <ul className="col" style={{ gap: 4, margin: 0, paddingLeft: 18 }}>
            <li>Companion entitlement: <strong>{formatMinor(maxCompanionMinor, currency)}</strong></li>
            <li>Customer credit: <strong>{formatMinor(0, currency)}</strong></li>
            <li>Resulting earning state: <strong>Ready for payout</strong> (not transferred)</li>
          </ul>
        )}
        {outcome === 'customer_credit_full' && (
          <ul className="col" style={{ gap: 4, margin: 0, paddingLeft: 18 }}>
            <li>Account credit: <strong>{formatMinor(maxTotalMinor, currency)}</strong></li>
            <li>Companion amount: <strong>{formatMinor(0, currency)}</strong></li>
            <li>Credit expiry: <strong>12 months</strong> · card refund: <strong>none</strong></li>
          </ul>
        )}
        {outcome === 'partial_resolution' && (
          <ul className="col" style={{ gap: 4, margin: 0, paddingLeft: 18 }}>
            <li>Companion payable: <strong>{formatMinor(companionMinor ?? 0, currency)}</strong></li>
            <li>Customer credit: <strong>{formatMinor(creditMinor ?? 0, currency)}</strong></li>
            <li>Unallocated (retained, not disbursed): <strong>{formatMinor(Math.max(0, unallocatedMinor), currency)}</strong></li>
          </ul>
        )}
        {outcome === 'issue_dismissed_release' && (
          <ul className="col" style={{ gap: 4, margin: 0, paddingLeft: 18 }}>
            <li>Companion full entitlement: <strong>{formatMinor(maxCompanionMinor, currency)}</strong></li>
            <li>Customer credit: <strong>{formatMinor(0, currency)}</strong></li>
            <li>Issue marked <strong>resolved</strong> (complaint dismissed)</li>
          </ul>
        )}
        <p className="muted small" style={{ margin: 0 }}>
          {outcome === 'companion_payable_full'
            && 'This will mark the Companion’s full earning as ready for payout. It will not create a Stripe transfer.'}
          {outcome === 'customer_credit_full'
            && 'This will issue account credit for the full customer-paid amount. It will not refund the payment card.'}
          {outcome === 'partial_resolution'
            && 'This applies the split above. No Stripe transfer or card refund is created.'}
          {outcome === 'issue_dismissed_release'
            && 'This dismisses the complaint and releases the full earning for a future payout. No Stripe transfer is created.'}
        </p>
        {error && <p className="small" role="alert" style={{ margin: 0, color: 'var(--color-danger-text)' }}>{error}</p>}
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn btn-primary btn-small" disabled={submitting} onClick={() => void submit()}>
            {submitting ? <Loader2 size={16} aria-hidden="true" /> : null} Confirm resolution
          </button>
          <button className="btn btn-ghost btn-small" disabled={submitting} onClick={() => { setReviewing(false); setError(null); }}>
            Back
          </button>
        </div>
      </section>
    );
  }

  /* ---------------- selection step ---------------- */
  return (
    <section className="card col" style={{ gap: 12 }} aria-label="Resolve issue">
      <h3 style={{ margin: 0 }}>Resolve this case</h3>
      <div className="col" style={{ gap: 8 }} role="radiogroup" aria-label="Resolution outcome">
        {OUTCOMES.map((o) => (
          <label key={o.value} className="card card-tight row" style={{ gap: 10, cursor: 'pointer' }}>
            <input
              type="radio"
              name={`resolution-${detail.issueId}`}
              checked={outcome === o.value}
              onChange={() => setOutcome(o.value)}
            />
            <span className="col" style={{ gap: 2 }}>
              <span className="bold small">{o.label}</span>
              <span className="muted small">{o.hint}</span>
            </span>
          </label>
        ))}
      </div>

      {outcome === 'partial_resolution' && (
        <div className="col" style={{ gap: 10 }}>
          <p className="faint small" style={{ margin: 0 }}>
            Maximum total: {formatMinor(maxTotalMinor, currency)} · Companion cap:{' '}
            {formatMinor(maxCompanionMinor, currency)} · Remaining unallocated:{' '}
            {formatMinor(Math.max(0, unallocatedMinor), currency)}
          </p>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor={`comp-${detail.issueId}`}>Companion payable (£)</label>
            <input
              id={`comp-${detail.issueId}`}
              type="text"
              inputMode="decimal"
              value={companionPounds}
              onChange={(e) => setCompanionPounds(e.target.value)}
              aria-describedby={`partial-help-${detail.issueId}`}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor={`cred-${detail.issueId}`}>Customer account credit (£)</label>
            <input
              id={`cred-${detail.issueId}`}
              type="text"
              inputMode="decimal"
              value={creditPounds}
              onChange={(e) => setCreditPounds(e.target.value)}
              aria-describedby={`partial-help-${detail.issueId}`}
            />
          </div>
          <p id={`partial-help-${detail.issueId}`} className="faint small" style={{ margin: 0 }}>
            Any unallocated amount is retained and not disbursed in this phase.
          </p>
          {partialError && (
            <p className="small" role="alert" style={{ margin: 0, color: 'var(--color-danger-text)' }}>{partialError}</p>
          )}
        </div>
      )}

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor={`note-${detail.issueId}`}>Internal resolution note (support only)</label>
        <textarea
          id={`note-${detail.issueId}`}
          rows={3}
          maxLength={NOTE_MAX}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-invalid={noteError ? true : undefined}
        />
        <span className="faint small">{note.length}/{NOTE_MAX} · Never shown to users.</span>
      </div>

      <div className="row">
        <button
          className="btn btn-primary btn-small"
          disabled={!canReview}
          onClick={() => { setReviewing(true); setError(null); }}
        >
          Review resolution
        </button>
      </div>
    </section>
  );
}
