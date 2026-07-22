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
    case 'critical': return 'bg-red-100 text-red-700';
    case 'warning': return 'bg-amber-100 text-amber-700';
    default: return 'bg-stone-100 text-stone-600';
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
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <PageHeader title="Financial reconciliation" subtitle="Internal exception queue — detections only; no money is moved here." />

      <div className="mb-4 flex gap-2 overflow-x-auto" role="tablist" aria-label="Finding filters">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition ${
              tab === t.key ? 'bg-stone-800 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle size={16} /> {error}
          <button onClick={() => void load()} className="ml-auto font-medium underline">Retry</button>
        </div>
      )}

      {rows === null && !error && (
        <div className="space-y-2" aria-hidden>
          {[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-stone-100" />)}
        </div>
      )}

      {rows !== null && filtered.length === 0 && (
        <EmptyState title="Nothing here" body="No reconciliation findings match this filter." />
      )}

      <ul className="space-y-2">
        {filtered.map((r) => (
          <li key={r.id}>
            <Link
              to={`/internal/finance/reconciliation/${r.id}`}
              className="block rounded-xl border border-stone-200 bg-white p-4 transition hover:border-stone-300 hover:shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${severityStyle(r.severity)}`}>{r.severity}</span>
                <span className="font-semibold text-stone-800">{r.findingType}</span>
                <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600">{r.status}</span>
                {r.occurrenceCount > 1 && (
                  <span className="rounded-full bg-stone-50 px-2 py-0.5 text-xs text-stone-500">×{r.occurrenceCount}</span>
                )}
                <span className="ml-auto text-xs text-stone-400">seen {age(r.lastSeenAt)} ago</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-500">
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
        <div className="mt-6 flex items-center justify-center gap-2 text-sm text-stone-400">
          <Loader2 size={14} className="animate-spin" /> Loading findings…
        </div>
      )}
    </div>
  );
}
