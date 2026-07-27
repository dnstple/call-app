/**
 * Internal financial-reconciliation queue (Phase 2G6E-C, support/admin only).
 *
 * A calm operational list of financial reconciliation findings (accounting /
 * operational mismatches). Data comes exclusively from the support-gated
 * support_reconciliation_queue RPC; the route is DB-role protected. No financial
 * logic and no money movement live here — findings are read-only detections.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { EmptyState, PageHeader } from '../components/ui';
import {
  getReconciliationQueue,
  ReconciliationError,
  type FindingRow,
  type FindingSeverity,
} from '../repositories/financeReconciliationRepository';
import { currentAccountId } from '../repositories/disputeSupportRepository';

type TabKey = 'open' | 'critical' | 'warning' | 'acknowledged' | 'investigating' | 'mine' | 'cleared' | 'resolved';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'critical', label: 'Critical' },
  { key: 'warning', label: 'Warning' },
  { key: 'acknowledged', label: 'Acknowledged' },
  { key: 'investigating', label: 'Investigating' },
  { key: 'mine', label: 'Assigned to me' },
  { key: 'cleared', label: 'Cleared' },
  { key: 'resolved', label: 'Resolved' },
];

function severityStyle(s: FindingSeverity): string {
  switch (s) {
    case 'critical': return 'badge-danger';
    case 'warning': return 'badge-pending';
    default: return 'badge-neutral';
  }
}

function age(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

export default function InternalReconciliation() {
  const [tab, setTab] = useState<TabKey>('open');
  const [rows, setRows] = useState<FindingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [meId, setMeId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setRows(null);
    try {
      const [q, me] = await Promise.all([getReconciliationQueue(), currentAccountId()]);
      setMeId(me);
      setRows(q);
    } catch (e) {
      setError(e instanceof ReconciliationError ? e.message : 'Could not load the reconciliation queue.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    switch (tab) {
      case 'open': return rows.filter((r) => r.status === 'open');
      case 'critical': return rows.filter((r) => r.severity === 'critical' && r.status !== 'cleared' && r.status !== 'resolved' && r.status !== 'ignored');
      case 'warning': return rows.filter((r) => r.severity === 'warning' && r.status !== 'cleared' && r.status !== 'resolved' && r.status !== 'ignored');
      case 'acknowledged': return rows.filter((r) => r.status === 'acknowledged');
      case 'investigating': return rows.filter((r) => r.status === 'investigating');
      case 'mine': return rows.filter((r) => meId !== null && r.assignedAccountId === meId);
      case 'cleared': return rows.filter((r) => r.status === 'cleared');
      case 'resolved': return rows.filter((r) => r.status === 'resolved' || r.status === 'ignored');
    }
  }, [rows, tab, meId]);

  return (
    <>
      <PageHeader title="Financial reconciliation" subtitle="Internal exception queue — detections only; no money is moved here." />

      <div className="tabs mb-4" role="tablist" aria-label="Finding filters" style={{ overflowX: 'auto' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className="tab"
            style={{ whiteSpace: 'nowrap' }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="banner banner-danger mb-4 row small">
          <AlertTriangle size={16} aria-hidden="true" /> <span className="grow">{error}</span>
          <button onClick={() => void load()} className="btn btn-ghost btn-small">Retry</button>
        </div>
      )}

      {rows === null && !error && (
        <div className="stack-list" style={{ gap: 'var(--space-2)' }} aria-hidden>
          {[0, 1, 2].map((i) => <div key={i} className="skeleton-block" />)}
        </div>
      )}

      {rows !== null && filtered.length === 0 && (
        <EmptyState title="Nothing here" body="No reconciliation findings match this filter." />
      )}

      <ul className="stack-list">
        {filtered.map((r) => (
          <li key={r.id}>
            <Link to={`/internal/finance/reconciliation/${r.id}`} className="card card-tight card-click" style={{ display: 'block' }}>
              <div className="row-wrap">
                <span className={`badge ${severityStyle(r.severity)}`}>{r.severity}</span>
                <span className="bold">{r.findingType}</span>
                <span className="badge badge-neutral">{r.status}</span>
                {r.occurrenceCount > 1 && <span className="badge badge-neutral">×{r.occurrenceCount}</span>}
                <span className="muted small" style={{ marginLeft: 'auto' }}>seen {age(r.lastSeenAt)} ago</span>
              </div>
              <div className="row-wrap muted small mt-2">
                <span>{r.primaryEntityType}: {r.primaryEntityId.slice(0, 8)}…</span>
                {r.providerRef && <span>Provider: {r.providerRef}</span>}
                <span>{r.assignedDisplayName ? `Owner: ${r.assignedDisplayName}` : 'Unassigned'}</span>
                <span>Age {age(r.firstSeenAt)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      {rows === null && !error && (
        <div className="row mt-5 muted small" style={{ justifyContent: 'center' }}>
          <Loader2 size={14} className="call-waiting-pulse" /> Loading findings…
        </div>
      )}
    </>
  );
}
