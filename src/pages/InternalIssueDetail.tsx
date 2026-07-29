/**
 * Internal issue detail + resolution (Phase 2G4E, support/admin only).
 *
 * Focused case review: what was reported, trusted attendance evidence,
 * completion/review status, a safe financial summary, and the four
 * authoritative resolution actions. All data comes from the support-gated
 * get_internal_issue_detail RPC; resolution goes through the authoritative
 * resolve_conversation_issue RPC. Once resolved, the case is read-only.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2 } from 'lucide-react';
import { EmptyState } from '../components/ui';
import { formatMinor } from '../repositories/availabilityRepository';
import {
  getInternalIssueDetail,
  InternalIssueError,
  type IssueDetail,
} from '../repositories/internalIssueRepository';
import { IssueResolutionForm } from '../components/internal/IssueResolutionForm';
import { CATEGORY_LABEL, CONDUCT_CATEGORY, REPORTER_LABEL, issueStateLabel } from '../components/internal/issueLabels';

function mins(seconds: number): string {
  return `${Math.floor(seconds / 60)} min`;
}
function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
}

/** Safe, honest earning-state label — never "Paid" unless transferred. */
function earningLabel(state: string | null, transfer: string | null): string {
  if (transfer === 'transferred') return 'Paid';
  if (state === 'payable') return 'Ready for payout';
  if (state === 'held_for_issue') return 'Held for review';
  if (state === 'reversed') return 'Reversed';
  return 'Pending';
}

export default function InternalIssueDetail() {
  const { issueId } = useParams();
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!issueId) return;
    setLoading(true);
    setError(null);
    getInternalIssueDetail(issueId)
      .then(setDetail)
      .catch((e) => setError(e instanceof InternalIssueError ? e.message : 'We couldn’t load this case.'))
      .finally(() => setLoading(false));
  }, [issueId]);

  useEffect(() => load(), [load]);

  if (loading) {
    return (
      <div className="row" style={{ gap: 10, padding: 32, justifyContent: 'center' }}>
        <Loader2 size={22} aria-hidden="true" />
        <span className="muted">Loading case…</span>
      </div>
    );
  }
  if (error || !detail) {
    return (
      <EmptyState
        title="Case unavailable"
        body={error ?? 'This case doesn’t exist or you don’t have access.'}
        action={<Link to="/internal/issues" className="btn btn-secondary">Back to queue</Link>}
      />
    );
  }

  const conduct = detail.category === CONDUCT_CATEGORY || detail.priority === 'high';
  const resolved = detail.state === 'resolved';
  const a = detail.attendance;

  return (
    <div className="col" style={{ gap: 16, maxWidth: 760 }}>
      <Link to="/internal/issues" className="btn btn-ghost btn-small" style={{ alignSelf: 'flex-start' }}>
        <ArrowLeft size={16} aria-hidden="true" /> All issues
      </Link>

      {/* Case header */}
      <header className="col" style={{ gap: 6 }}>
        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          {conduct && (
            <span className="pill pill-attention row" style={{ gap: 4 }}>
              <AlertTriangle size={14} aria-hidden="true" /> High priority
            </span>
          )}
          <h1 style={{ margin: 0, fontSize: '1.3em' }}>{CATEGORY_LABEL[detail.category] ?? detail.category}</h1>
          <span className={`pill ${resolved ? 'pill-ready' : 'pill-info'}`}>{issueStateLabel(detail.state)}</span>
        </div>
        <span className="muted">
          {(detail.memberName ?? 'Member')} &amp; {(detail.companionName ?? 'Companion')} · {when(detail.conversationAt)} · {detail.durationMinutes} min
        </span>
        <span className="faint small">
          Reported by {REPORTER_LABEL[detail.reporterRole] ?? detail.reporterRole} · opened {when(detail.createdAt)}
        </span>
      </header>

      {conduct && (
        <div className="banner banner-danger" role="note">
          This report may require follow-up beyond the financial resolution. Call attendance does not prove or disprove conduct.
        </div>
      )}

      {/* What was reported */}
      <section className="card col" style={{ gap: 6 }}>
        <h2 style={{ margin: 0, fontSize: '1.05em' }}>What was reported</h2>
        <span className="faint small">Submitted by the {REPORTER_LABEL[detail.reporterRole] ?? detail.reporterRole} · not shown to the other party</span>
        <p className="longform" style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{detail.description}</p>
      </section>

      {/* Conversation evidence */}
      <section className="card col" style={{ gap: 6 }}>
        <h2 style={{ margin: 0, fontSize: '1.05em' }}>Conversation evidence</h2>
        <div className="col" style={{ gap: 2 }}>
          <span>Companion connected: <strong>{mins(a.companionSeconds)}</strong></span>
          <span>Member connected: <strong>{mins(a.memberSeconds)}</strong></span>
          <span>Both present long enough: <strong>{a.bothTwoMinutes ? 'Yes' : 'No'}</strong></span>
          <span>Likely Member no-show threshold met: <strong>{a.companionNoShowThreshold ? 'Yes' : 'No'}</strong></span>
        </div>
        <p className="faint small" style={{ margin: '4px 0 0' }}>
          Call attendance is supporting evidence only and does not override a conduct or safety report.
        </p>
      </section>

      {/* Completion and review status */}
      <section className="card col" style={{ gap: 4 }}>
        <h2 style={{ margin: 0, fontSize: '1.05em' }}>Completion &amp; review</h2>
        <span className="small">Companion attendance: <strong>{detail.attendanceOutcome ? `${detail.attendanceOutcome.replace(/_/g, ' ')}${detail.attendanceSource === 'system' ? ' (system-derived)' : ''}` : 'Not submitted'}</strong></span>
        <span className="small">Coordinator approved: <strong>{detail.reviewSubmitted ? (detail.reviewApproved ? 'Yes' : 'No') : 'No review yet'}</strong></span>
        <span className="small">Rating submitted: <strong>{detail.reviewRating ? `${detail.reviewRating}★` : 'None'}</strong></span>
        <span className="small">Open issue blocked release: <strong>{resolved ? 'Was blocking' : 'Yes'}</strong></span>
      </section>

      {/* Financial summary */}
      <section className="card col" style={{ gap: 4 }}>
        <h2 style={{ margin: 0, fontSize: '1.05em' }}>Financial summary</h2>
        <div className="row between"><span className="muted">Customer conversation value</span><span>{formatMinor(detail.customerValueMinor ?? 0, detail.currency)}</span></div>
        <div className="row between"><span className="muted">Customer service fee</span><span>{formatMinor(detail.serviceFeeMinor ?? 0, detail.currency)}</span></div>
        <div className="row between" style={{ borderTop: '1px solid var(--color-border)', paddingTop: 4 }}>
          <span className="bold">Total customer amount</span><span className="bold">{formatMinor(detail.customerTotalMinor ?? 0, detail.currency)}</span>
        </div>
        <div className="row between"><span className="muted">Companion entitlement</span><span>{formatMinor(detail.companionEntitlementMinor ?? 0, detail.currency)}</span></div>
        <div className="row between"><span className="muted">Commission ({Number(detail.commissionRatePct ?? 0)}%)</span><span>{formatMinor(detail.commissionMinor ?? 0, detail.currency)}</span></div>
        <div className="row between" style={{ marginTop: 4 }}>
          <span className="muted">Earning state</span>
          <span className="row" style={{ gap: 8 }}>
            <span className={`pill ${detail.earningState === 'payable' ? 'pill-ready' : 'pill-info'}`}>{earningLabel(detail.earningState, detail.transferState)}</span>
            <span className="faint small">Not transferred</span>
          </span>
        </div>
        {detail.creditStatus.issued && (
          <div className="row between"><span className="muted">Account credit issued</span><span>{formatMinor(detail.creditStatus.amountMinor ?? 0, detail.currency)}</span></div>
        )}
      </section>

      {/* Resolution: form when open, read-only record when resolved */}
      {resolved && detail.resolution ? (
        <section className="card col" style={{ gap: 6 }} aria-label="Resolution">
          <div className="row" style={{ gap: 8 }}>
            <CheckCircle2 size={18} aria-hidden="true" style={{ color: 'var(--color-success-text)' }} />
            <h2 style={{ margin: 0, fontSize: '1.05em' }}>Resolved</h2>
          </div>
          <span className="small">Outcome: <strong>{detail.resolution.outcome.replace(/_/g, ' ')}</strong></span>
          <span className="small">Companion amount: <strong>{formatMinor(detail.resolution.companionAmountMinor, detail.currency)}</strong></span>
          <span className="small">Customer credit: <strong>{formatMinor(detail.resolution.creditAmountMinor, detail.currency)}</strong></span>
          <span className="small">Resolved: <strong>{detail.resolvedAt ? when(detail.resolvedAt) : '—'}</strong></span>
          <span className="small">Resolver: <strong>{detail.resolution.resolverAccountId}</strong></span>
          <div className="col" style={{ gap: 2, marginTop: 4 }}>
            <span className="faint small">Internal note (support only)</span>
            <p className="longform" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{detail.resolution.note}</p>
          </div>
          <span className="faint small" style={{ marginTop: 4 }}>Audit id: {detail.resolution.id}</span>
        </section>
      ) : (
        <IssueResolutionForm detail={detail} onResolved={load} />
      )}
    </div>
  );
}
