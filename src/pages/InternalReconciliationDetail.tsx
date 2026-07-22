/**
 * Internal financial-reconciliation finding detail (Phase 2G6E-C, support only).
 *
 * Shows a finding's safe expected/observed summary, related financial references,
 * provider identifiers, reconciliation/audit history, and support actions
 * (assign, acknowledge, investigate, resolve, ignore, recheck). Support NEVER
 * edits financial amounts or provider state; recheck only re-runs the read-only
 * detection and moves NO money. All data + mutations go through support-gated RPCs.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Loader2 } from 'lucide-react';
import { ConfirmDialog, EmptyState, PageHeader } from '../components/ui';
import {
  assignFinding, getReconciliationDetail, recheckFinding, ReconciliationError,
  updateFindingStatus, type FindingStatus,
} from '../repositories/financeReconciliationRepository';

/* eslint-disable @typescript-eslint/no-explicit-any */

function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-stone-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-stone-500">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="text-stone-500">{label}</span>
      <span className="text-right font-medium text-stone-800">{value ?? '—'}</span>
    </div>
  );
}

export default function InternalReconciliationDetail() {
  const { findingId = '' } = useParams();
  const [detail, setDetail] = useState<any | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [opOk, setOpOk] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | 'resolved' | 'ignored'>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setLoadError(null);
    setDetail(null);
    try {
      setDetail(await getReconciliationDetail(findingId));
    } catch (e) {
      setLoadError(e instanceof ReconciliationError ? e.message : 'Could not load this finding.');
    }
  }, [findingId]);

  useEffect(() => { void load(); }, [load]);

  const run = useCallback(async (op: string, fn: () => Promise<void>, okMsg?: string) => {
    setBusy(op); setOpError(null); setOpOk(null);
    try {
      await fn();
      if (okMsg) setOpOk(okMsg);
      await load();
    } catch (e) {
      setOpError(e instanceof ReconciliationError ? e.message : 'That action failed. Please try again.');
    } finally {
      setBusy(null);
    }
  }, [load]);

  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <Link to="/internal/finance/reconciliation" className="mb-4 inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-700">
          <ArrowLeft size={14} /> Back to reconciliation
        </Link>
        <EmptyState title="Unavailable" body={loadError} />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <div className="space-y-3" aria-hidden>
          {[0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-stone-100" />)}
        </div>
        <div className="mt-4 flex items-center justify-center gap-2 text-sm text-stone-400">
          <Loader2 size={14} className="animate-spin" /> Loading finding…
        </div>
      </div>
    );
  }

  const f = detail.finding ?? {};
  const audit: any[] = detail.audit ?? [];
  const terminal = f.status === 'cleared' || f.status === 'resolved' || f.status === 'ignored';

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <Link to="/internal/finance/reconciliation" className="mb-4 inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-700">
        <ArrowLeft size={14} /> Back to reconciliation
      </Link>
      <PageHeader title={f.finding_type} subtitle={`${f.severity} · ${f.status}`} />

      <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
        This is a read-only detection. Rechecking re-runs reconciliation and <strong>never moves money</strong>, issues refunds, or changes any financial amount.
      </p>

      {opError && <div className="mb-3 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"><AlertTriangle size={15} /> {opError}</div>}
      {opOk && <div className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{opOk}</div>}

      <div className="space-y-3">
        <Section title="Finding">
          <Field label="Type" value={f.finding_type} />
          <Field label="Severity" value={f.severity} />
          <Field label="Status" value={f.status} />
          <Field label="Entity" value={`${f.primary_entity_type} · ${f.primary_entity_id}`} />
          <Field label="First seen" value={when(f.first_seen_at)} />
          <Field label="Last seen" value={when(f.last_seen_at)} />
          <Field label="Occurrences" value={f.occurrence_count} />
          {f.cleared_at && <Field label="Cleared" value={when(f.cleared_at)} />}
        </Section>

        <Section title="Expected vs observed (safe summary)">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="mb-1 text-xs font-medium text-stone-500">Expected</div>
              <pre className="max-h-56 overflow-auto rounded-lg bg-stone-50 p-3 text-xs text-stone-700">{JSON.stringify(f.expected, null, 2)}</pre>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-stone-500">Observed</div>
              <pre className="max-h-56 overflow-auto rounded-lg bg-stone-50 p-3 text-xs text-stone-700">{JSON.stringify(f.observed, null, 2)}</pre>
            </div>
          </div>
        </Section>

        <Section title="Related references">
          <Field label="Provider ref" value={f.provider_ref} />
          <Field label="Order" value={f.order_id} />
          <Field label="Earning" value={f.earning_id} />
          <Field label="Transfer" value={f.transfer_id} />
          <Field label="Refund" value={f.refund_id} />
          <Field label="Dispute" value={f.dispute_id} />
        </Section>

        <Section title="Handling">
          <Field label="Owner" value={f.assigned_display_name ?? 'Unassigned'} />
          <Field label="Acknowledged" value={when(f.acknowledged_at)} />
          {f.resolution_reason && <Field label="Resolution reason" value={f.resolution_reason} />}
          {f.ignored_reason && <Field label="Ignore reason" value={f.ignored_reason} />}
          <div className="mt-3 flex flex-wrap gap-2">
            <button disabled={busy !== null || terminal} onClick={() => void run('assign', async () => { await assignFinding(findingId); }, 'Assigned to you.')}
              className="rounded-lg bg-stone-100 px-3 py-1.5 text-sm font-medium text-stone-700 disabled:opacity-50">Assign to me</button>
            <button disabled={busy !== null || terminal} onClick={() => void run('ack', async () => { await updateFindingStatus(findingId, 'acknowledged'); }, 'Acknowledged.')}
              className="rounded-lg bg-stone-100 px-3 py-1.5 text-sm font-medium text-stone-700 disabled:opacity-50">Acknowledge</button>
            <button disabled={busy !== null || terminal} onClick={() => void run('inv', async () => { await updateFindingStatus(findingId, 'investigating'); }, 'Marked investigating.')}
              className="rounded-lg bg-stone-100 px-3 py-1.5 text-sm font-medium text-stone-700 disabled:opacity-50">Investigating</button>
            <button disabled={busy !== null} onClick={() => void run('recheck', async () => { await recheckFinding(findingId); }, 'Rechecked (no money moved).')}
              className="rounded-lg bg-stone-100 px-3 py-1.5 text-sm font-medium text-stone-700 disabled:opacity-50">
              {busy === 'recheck' ? 'Rechecking…' : 'Recheck now'}
            </button>
            <button disabled={busy !== null || terminal} onClick={() => { setConfirm('resolved'); setReason(''); }}
              className="ml-auto rounded-lg bg-stone-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Resolve</button>
            <button disabled={busy !== null || terminal} onClick={() => { setConfirm('ignored'); setReason(''); }}
              className="rounded-lg bg-stone-200 px-3 py-1.5 text-sm font-medium text-stone-700 disabled:opacity-50">Ignore</button>
          </div>
        </Section>

        <Section title="History">
          {audit.length === 0 ? (
            <p className="text-sm text-stone-500">No actions yet.</p>
          ) : (
            <ul className="space-y-1 text-xs text-stone-500">
              {audit.map((a) => <li key={a.id}>{when(a.created_at)} · {a.action_type}</li>)}
            </ul>
          )}
        </Section>
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm === 'resolved' ? 'Resolve finding' : 'Ignore finding'}
          body={
            <div>
              <p className="mb-2 text-sm text-stone-600">A reason is required. The finding is retained for audit and does not move any money.</p>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Internal reason" rows={3}
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm" />
            </div>
          }
          confirmLabel={confirm === 'resolved' ? 'Resolve' : 'Ignore'}
          onConfirm={() => {
            const status = confirm as FindingStatus;
            const r = reason.trim();
            setConfirm(null);
            if (r.length === 0) { setOpError('A reason is required.'); return; }
            void run(status, async () => { await updateFindingStatus(findingId, status, r); }, status === 'resolved' ? 'Resolved.' : 'Ignored.');
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
