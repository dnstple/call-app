/**
 * Internal dispute queue (Phase 2G6E-A, support/admin only).
 *
 * A calm operational list of Stripe disputes with provider/internal state,
 * amount, reason, evidence-deadline urgency, mapping state, handling status,
 * assigned agent and an adjustment indicator. Data comes exclusively from the
 * support-gated support_dispute_queue RPC; the route is DB-role protected.
 * No financial logic and no evidence bodies live here.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { EmptyState, PageHeader } from '../components/ui';
import {
  getDisputeQueue,
  currentAccountId,
  DisputeSupportError,
  type DisputeQueueRow,
  type QueueUrgency,
} from '../repositories/disputeSupportRepository';
import { formatMinor } from '../repositories/availabilityRepository';

type TabKey = 'active' | 'overdue' | 'critical' | 'urgent' | 'unassigned' | 'mine' | 'waiting' | 'resolved';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'critical', label: 'Critical' },
  { key: 'urgent', label: 'Urgent' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'mine', label: 'Assigned to me' },
  { key: 'waiting', label: 'Waiting on Stripe' },
  { key: 'resolved', label: 'Resolved' },
];

const HANDLING_LABEL: Record<string, string> = {
  unassigned: 'Unassigned', in_review: 'In review', evidence_prepared: 'Evidence prepared',
  evidence_submitted: 'Evidence submitted', waiting_provider: 'Waiting on Stripe', resolved: 'Resolved',
};

// Server-derived urgency label + style (browser never classifies urgency).
function urgencyStyle(u: QueueUrgency): { label: string; cls: string } {
  switch (u) {
    case 'overdue': return { label: 'Overdue', cls: 'bg-red-100 text-red-700' };
    case 'critical': return { label: 'Critical (<24h)', cls: 'bg-red-100 text-red-700' };
    case 'urgent': return { label: 'Urgent (<72h)', cls: 'bg-amber-100 text-amber-700' };
    case 'due_soon': return { label: 'Due soon', cls: 'bg-yellow-100 text-yellow-700' };
    case 'normal': return { label: 'On track', cls: 'bg-stone-100 text-stone-600' };
    case 'closed': return { label: 'Closed', cls: 'bg-stone-100 text-stone-500' };
    default: return { label: 'No deadline', cls: 'bg-stone-100 text-stone-500' };
  }
}

// Time remaining derived from the SERVER-provided seconds (display only).
function timeRemaining(seconds: number | null): string {
  if (seconds === null) return 'No deadline';
  const abs = Math.abs(seconds);
  const d = Math.floor(abs / 86400);
  const h = Math.floor((abs % 86400) / 3600);
  const label = d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((abs % 3600) / 60)}m`;
  return seconds < 0 ? `${label} overdue` : `${label} left`;
}

export default function InternalDisputes() {
  const [tab, setTab] = useState<TabKey>('active');
  const [rows, setRows] = useState<DisputeQueueRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [meId, setMeId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setRows(null);
    try {
      const [q, me] = await Promise.all([getDisputeQueue(), currentAccountId()]);
      setMeId(me);
      setRows(q);
    } catch (e) {
      setError(e instanceof DisputeSupportError ? e.message : 'Could not load the dispute queue.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    switch (tab) {
      case 'active': return rows.filter((r) => r.urgency !== 'closed');
      case 'overdue': return rows.filter((r) => r.urgency === 'overdue');
      case 'critical': return rows.filter((r) => r.urgency === 'critical');
      case 'urgent': return rows.filter((r) => r.urgency === 'urgent');
      case 'unassigned': return rows.filter((r) => r.assignedAccountId === null && r.urgency !== 'closed');
      case 'mine': return rows.filter((r) => meId !== null && r.assignedAccountId === meId);
      case 'waiting': return rows.filter((r) => r.handlingStatus === 'waiting_provider');
      case 'resolved': return rows.filter((r) => r.handlingStatus === 'resolved' || r.urgency === 'closed');
    }
  }, [rows, tab, meId]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <PageHeader title="Disputes" subtitle="Internal support queue — chargebacks and evidence handling." />

      <div className="mb-4 flex gap-2 overflow-x-auto" role="tablist" aria-label="Dispute filters">
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
        <EmptyState title="Nothing here" body="No disputes match this filter." />
      )}

      <ul className="space-y-2">
        {filtered.map((r) => {
          const u = urgencyStyle(r.urgency);
          return (
            <li key={r.id}>
              <Link
                to={`/internal/disputes/${r.id}`}
                className="block rounded-xl border border-stone-200 bg-white p-4 transition hover:border-stone-300 hover:shadow-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-stone-800">{formatMinor(r.disputedAmountMinor, r.currency)}</span>
                  <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600">{r.internalState}</span>
                  {r.providerStatus && (
                    <span className="rounded-full bg-stone-50 px-2 py-0.5 text-xs text-stone-500">Stripe: {r.providerStatus}</span>
                  )}
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${u.cls}`}>{u.label}</span>
                  {r.escalationActive && (
                    <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-medium text-white">Escalated</span>
                  )}
                  {r.isUnresolvedMapping && (
                    <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700">Unresolved</span>
                  )}
                  {r.hasManualEvidence && (
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Evidence logged</span>
                  )}
                  {r.hasOpenAdjustment && (
                    <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">Adjustment</span>
                  )}
                  <span className="ml-auto text-xs text-stone-400">{timeRemaining(r.secondsRemaining)}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-500">
                  {r.reason && <span>Reason: {r.reason}</span>}
                  <span>Handling: {HANDLING_LABEL[r.handlingStatus] ?? r.handlingStatus}</span>
                  <span>{r.assignedDisplayName ? `Owner: ${r.assignedDisplayName}` : 'No owner'}</span>
                  {r.latestAlertThreshold && <span>Last alert: {r.latestAlertThreshold}</span>}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>

      {rows === null && !error && (
        <div className="mt-6 flex items-center justify-center gap-2 text-sm text-stone-400">
          <Loader2 size={14} className="animate-spin" /> Loading disputes…
        </div>
      )}
    </div>
  );
}
