/**
 * Internal issue queue (Phase 2G4E, support/admin only).
 *
 * A calm operational list of conversation issues with state/priority/category/
 * reporter filters. Data comes exclusively from the support-gated
 * get_internal_issue_queue RPC (never a direct table join); the route is
 * protected by the DB-backed support role. No financial logic lives here.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { EmptyState, PageHeader } from '../components/ui';
import {
  getInternalIssueQueue,
  InternalIssueError,
  type IssueQueueRow,
  type IssueState,
} from '../repositories/internalIssueRepository';
import { CATEGORY_LABEL, REPORTER_LABEL, issueStateLabel } from '../components/internal/issueLabels';
import { formatMinor } from '../repositories/availabilityRepository';

type TabKey = 'open' | 'reviewing' | 'high' | 'resolved';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'reviewing', label: 'Reviewing' },
  { key: 'high', label: 'High priority' },
  { key: 'resolved', label: 'Resolved' },
];

function filtersFor(tab: TabKey): { states?: IssueState[]; priority?: 'high' } {
  switch (tab) {
    case 'open': return { states: ['open'] };
    case 'reviewing': return { states: ['reviewing'] };
    case 'high': return { states: ['open', 'reviewing'], priority: 'high' };
    case 'resolved': return { states: ['resolved'] };
  }
}

function timeSince(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function conversationWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export default function InternalIssues() {
  const [tab, setTab] = useState<TabKey>('open');
  const [category, setCategory] = useState<string>('');
  const [reporter, setReporter] = useState<string>('');
  const [rows, setRows] = useState<IssueQueueRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setRows(null);
    setError(null);
    const f = filtersFor(tab);
    let live = true;
    getInternalIssueQueue({
      ...f,
      category: category || undefined,
      reporterRole: reporter || undefined,
    })
      .then((r) => live && setRows(r))
      .catch((e) => live && setError(e instanceof InternalIssueError ? e.message : 'We couldn’t load the queue.'));
    return () => { live = false; };
  }, [tab, category, reporter]);

  useEffect(() => load(), [load]);

  const emptyMessage = useMemo(() => {
    if (category || reporter) return 'No cases match these filters.';
    if (tab === 'high') return 'No high-priority issues.';
    if (tab === 'resolved') return 'No resolved issues.';
    if (tab === 'reviewing') return 'No issues in review.';
    return 'No open issues.';
  }, [tab, category, reporter]);

  const actionLabel = (state: IssueState) =>
    state === 'resolved' ? 'View resolution' : state === 'reviewing' ? 'Continue review' : 'Review case';

  return (
    <div>
      <PageHeader title="Conversation issues" subtitle="Internal review queue" />

      <div className="row wrap" style={{ gap: 6, marginBottom: 12 }} role="group" aria-label="Issue state">
        {TABS.map((t) => (
          <button
            key={t.key}
            className="chip"
            aria-pressed={tab === t.key}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="row wrap" style={{ gap: 12, marginBottom: 16 }}>
        <label className="col" style={{ gap: 4 }}>
          <span className="faint small">Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category">
            <option value="">All categories</option>
            {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="col" style={{ gap: 4 }}>
          <span className="faint small">Reporter</span>
          <select value={reporter} onChange={(e) => setReporter(e.target.value)} aria-label="Filter by reporter role">
            <option value="">Any reporter</option>
            <option value="coordinator">Coordinator</option>
            <option value="companion">Companion</option>
            <option value="system">System</option>
          </select>
        </label>
      </div>

      {rows === null && !error && (
        <div className="row" style={{ gap: 10, padding: 24, justifyContent: 'center' }}>
          <Loader2 size={20} aria-hidden="true" />
          <span className="muted">Loading issues…</span>
        </div>
      )}

      {error && (
        <div className="col" style={{ gap: 10 }}>
          <p className="muted" role="alert">{error}</p>
          <button className="btn btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} onClick={load}>Try again</button>
        </div>
      )}

      {rows !== null && !error && rows.length === 0 && (
        <EmptyState title={emptyMessage} body="Cases will appear here when they need review." />
      )}

      {rows !== null && rows.length > 0 && (
        <ul className="stack-list" aria-label="Conversation issues" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map((r) => (
            <li key={r.issueId}>
              <Link
                to={`/internal/issues/${r.issueId}`}
                className="card card-tight col issue-row"
                style={{ gap: 6, textDecoration: 'none', color: 'inherit' }}
                aria-label={`${r.priority === 'high' ? 'High priority. ' : ''}${CATEGORY_LABEL[r.category] ?? r.category}, ${r.memberName ?? 'Member'} with ${r.companionName ?? 'Companion'}, ${issueStateLabel(r.state)}`}
              >
                <div className="row between wrap" style={{ gap: 8 }}>
                  <span className="row" style={{ gap: 8, minWidth: 0 }}>
                    {r.priority === 'high' && (
                      <span className="pill pill-attention row" style={{ gap: 4 }}>
                        <AlertTriangle size={13} aria-hidden="true" /> High
                      </span>
                    )}
                    <span className="bold">{CATEGORY_LABEL[r.category] ?? r.category}</span>
                  </span>
                  <span className={`pill ${r.state === 'resolved' ? 'pill-ready' : 'pill-info'}`}>{issueStateLabel(r.state)}</span>
                </div>
                <span className="muted small">
                  {(r.memberName ?? 'Member')} &amp; {(r.companionName ?? 'Companion')} · {conversationWhen(r.conversationAt)}
                </span>
                <div className="row between wrap" style={{ gap: 8 }}>
                  <span className="faint small">
                    Reported by {REPORTER_LABEL[r.reporterRole] ?? r.reporterRole} · {timeSince(r.createdAt)}
                    {r.heldMinor != null && r.earningState ? ` · Earning ${r.earningState} (${formatMinor(r.heldMinor, r.currency)})` : ''}
                  </span>
                  <span className="btn btn-secondary btn-small" aria-hidden="true">{actionLabel(r.state)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
