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
    <section className="card">
      <h2 className="section-label">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="row between small" style={{ padding: '4px 0', gap: 'var(--space-4)' }}>
      <span className="muted">{label}</span>
      <span className="bold" style={{ textAlign: 'right' }}>{value ?? '—'}</span>
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
      <>
        <Link to="/internal/finance/reconciliation" className="call-lobby-back">
          <ArrowLeft size={16} aria-hidden="true" /> Back to reconciliation
        </Link>
        <EmptyState title="Unavailable" body={loadError} />
      </>
    );
  }

  if (!detail) {
    return (
      <>
        <div className="stack-list" style={{ gap: 'var(--space-3)' }} aria-hidden>
          {[0, 1, 2].map((i) => <div key={i} className="skeleton-block" style={{ height: 96 }} />)}
        </div>
        <div className="row mt-4 muted small" style={{ justifyContent: 'center' }}>
          <Loader2 size={14} className="call-waiting-pulse" /> Loading finding…
        </div>
      </>
    );
  }

  const f = detail.finding ?? {};
  const audit: any[] = detail.audit ?? [];
  const terminal = f.status === 'cleared' || f.status === 'resolved' || f.status === 'ignored';

  return (
    <>
      <Link to="/internal/finance/reconciliation" className="call-lobby-back">
        <ArrowLeft size={16} aria-hidden="true" /> Back to reconciliation
      </Link>
      <PageHeader title={f.finding_type} subtitle={`${f.severity} · ${f.status}`} />

      <p className="banner banner-warning small mb-4">
        This is a read-only detection. Rechecking re-runs reconciliation and <strong>never moves money</strong>, issues refunds, or changes any financial amount.
      </p>

      {opError && <div className="banner banner-danger mb-4 row small"><AlertTriangle size={15} aria-hidden="true" /> {opError}</div>}
      {opOk && <div className="banner banner-success mb-4 small">{opOk}</div>}

      <div className="stack-list" style={{ gap: 'var(--space-3)' }}>
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
          <div className="grid-2">
            <div>
              <div className="section-label">Expected</div>
              <pre className="card-muted" style={{ maxHeight: '14rem', overflow: 'auto', padding: 'var(--space-3)', fontSize: '0.8em', borderRadius: 'var(--radius-m)', margin: 0 }}>{JSON.stringify(f.expected, null, 2)}</pre>
            </div>
            <div>
              <div className="section-label">Observed</div>
              <pre className="card-muted" style={{ maxHeight: '14rem', overflow: 'auto', padding: 'var(--space-3)', fontSize: '0.8em', borderRadius: 'var(--radius-m)', margin: 0 }}>{JSON.stringify(f.observed, null, 2)}</pre>
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
          <div className="row-wrap mt-4">
            <button disabled={busy !== null || terminal} onClick={() => void run('assign', async () => { await assignFinding(findingId); }, 'Assigned to you.')}
              className="btn btn-secondary btn-small">Assign to me</button>
            <button disabled={busy !== null || terminal} onClick={() => void run('ack', async () => { await updateFindingStatus(findingId, 'acknowledged'); }, 'Acknowledged.')}
              className="btn btn-secondary btn-small">Acknowledge</button>
            <button disabled={busy !== null || terminal} onClick={() => void run('inv', async () => { await updateFindingStatus(findingId, 'investigating'); }, 'Marked investigating.')}
              className="btn btn-secondary btn-small">Investigating</button>
            <button disabled={busy !== null} onClick={() => void run('recheck', async () => { await recheckFinding(findingId); }, 'Rechecked (no money moved).')}
              className="btn btn-secondary btn-small">
              {busy === 'recheck' ? 'Rechecking…' : 'Recheck now'}
            </button>
            <button disabled={busy !== null || terminal} onClick={() => { setConfirm('resolved'); setReason(''); }}
              className="btn btn-primary btn-small" style={{ marginLeft: 'auto' }}>Resolve</button>
            <button disabled={busy !== null || terminal} onClick={() => { setConfirm('ignored'); setReason(''); }}
              className="btn btn-secondary btn-small">Ignore</button>
          </div>
        </Section>

        <Section title="History">
          {audit.length === 0 ? (
            <p className="muted small">No actions yet.</p>
          ) : (
            <ul className="muted small" style={{ margin: 0, paddingLeft: '1.1rem' }}>
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
              <p className="muted small mb-2">A reason is required. The finding is retained for audit and does not move any money.</p>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Internal reason" rows={3} />
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
    </>
  );
}
