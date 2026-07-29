/**
 * Financial operations readiness + control plane (Stage 3C1, support/operations
 * only). The route is DB-role protected by <SupportOnly>; every datum here comes
 * from a support-gated SECURITY DEFINER RPC. This page moves NO money: it shows
 * safe aggregate readiness counts, the server-owned kill-switch controls, recent
 * operation runs, and a strictly side-effect-free scoped PREVIEW tool. Execution
 * affordances stay disabled unless a server control explicitly permits them, and
 * there is no generic RPC console.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, ShieldAlert, Eye } from 'lucide-react';
import { EmptyState, PageHeader } from '../components/ui';
import {
  getFinancialReadiness, previewOperationRun, requestOperationRun, getOperationRunDetail,
  OperationsError, type Readiness, type OperationType, type PreviewResult, type ControlState, type RunDetail,
} from '../repositories/financialOperationsRepository';

// Stage 3C2-A: earning_release now has a production-grade record-scoped executor;
// every other operation type is preview-only and clearly labelled "not yet enabled".
const OPERATIONS: { key: OperationType; label: string; executable: boolean }[] = [
  { key: 'earning_release', label: 'Earning release', executable: true },
  { key: 'transfer_claim', label: 'Transfer review (read-only, no money moves)', executable: true },
  { key: 'transfer_finalise', label: 'Provider transfer execution (TEST MODE ONLY — moves test money, max 5, irreversible)', executable: true },
  { key: 'refund_claim', label: 'Refund claim (not yet enabled)', executable: false },
  { key: 'refund_finalise', label: 'Refund finalise (not yet enabled)', executable: false },
  { key: 'plan_renewal', label: 'Plan renewal', executable: true },
  { key: 'dispute_reconciliation', label: 'Dispute reconciliation (not yet enabled)', executable: false },
  { key: 'financial_reconciliation', label: 'Financial reconciliation (not yet enabled)', executable: false },
  { key: 'evidence_review_release', label: 'Evidence-review release (not yet enabled)', executable: false },
];

// Per-record outcome badge styling (Stage 3C2-A earning-release ledger).
// Maps each outcome onto a design-system semantic badge variant so colour
// meaning survives (success / info / pending / danger / neutral). Colour is
// never the only signal — the outcome text is always shown alongside.
const OUTCOME_STYLE: Record<string, string> = {
  released: 'badge-success', already_payable: 'badge-info',
  not_found: 'badge-neutral', not_yet_eligible: 'badge-pending',
  issue_held: 'badge-pending', evidence_held: 'badge-pending',
  reversed: 'badge-danger', transfer_already_started: 'badge-info',
  invalid_state: 'badge-danger', failed: 'badge-danger',
  renewed_credit_covered: 'badge-success',
  closed_zero_occurrences: 'badge-success',
  renewal_prepared: 'badge-info',
  already_renewed: 'badge-info',
  action_required_existing: 'badge-info',
  payment_failed_existing: 'badge-danger',
  plan_not_active: 'badge-pending', plan_paused: 'badge-pending',
  plan_ended: 'badge-pending', billing_not_enabled: 'badge-pending',
  not_recurring: 'badge-pending',
  eligible_provider_action_required: 'badge-info',
  provider_lookup_required: 'badge-danger',
  already_processing: 'badge-info',
  already_transferred: 'badge-info',
  not_payable: 'badge-pending', held_for_issue: 'badge-pending',
  connect_not_ready: 'badge-pending', zero_amount: 'badge-neutral',
  retryable_failure: 'badge-pending',
  permanent_failure: 'badge-danger',
  provider_transfer_found_and_finalized: 'badge-success',
  provider_transfer_created_and_finalized: 'badge-success',
  provider_lookup_failed: 'badge-danger',
  provider_lookup_ambiguous: 'badge-danger',
  provider_transfer_mismatch: 'badge-danger',
  provider_outcome_uncertain: 'badge-danger',
  reconciliation_required: 'badge-danger',
  failed_permanent: 'badge-danger',
};

// Severity mapping for readiness counts — calm operational language.
const SEVERITY: Record<string, 'info' | 'warning' | 'critical'> = {
  processing_transfers_stale: 'warning', permanent_transfer_failures: 'critical',
  retryable_transfer_failures: 'warning', refunds_stale: 'warning',
  disputes_nearing_deadline: 'critical', unresolved_disputes: 'warning',
  unresolved_reconciliation_findings: 'warning', webhooks_missing_result: 'warning',
  plan_billing_drift: 'warning', active_evidence_reviews: 'info',
};
const COUNT_LABELS: Record<string, string> = {
  pending_earnings: 'Pending earnings', payable_awaiting_transfer: 'Payable awaiting transfer',
  processing_transfers_stale: 'Stale processing transfers', retryable_transfer_failures: 'Retryable transfer failures',
  permanent_transfer_failures: 'Permanent transfer failures', refunds_active: 'Active refunds',
  refunds_stale: 'Stale refunds', unresolved_disputes: 'Unresolved disputes',
  disputes_nearing_deadline: 'Disputes nearing deadline', active_evidence_reviews: 'Active evidence reviews',
  unresolved_reconciliation_findings: 'Unresolved reconciliation findings', webhooks_missing_result: 'Webhooks missing result',
  plan_billing_drift: 'Plan billing drift',
};

function countTone(sev: 'info' | 'warning' | 'critical', value: number): string {
  if (value === 0) return '';
  if (sev === 'critical') return 'stat-critical';
  if (sev === 'warning') return 'stat-warning';
  return '';
}
function controlStyle(s: ControlState): string {
  switch (s) {
    case 'enabled': return 'badge-success';
    case 'scoped_execution': return 'badge-info';
    case 'dry_run_only': return 'badge-pending';
    default: return 'badge-neutral';
  }
}

export default function InternalOperations() {
  const [data, setData] = useState<Readiness | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Preview tool state.
  const [op, setOp] = useState<OperationType>('earning_release');
  const [idsText, setIdsText] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Selected recent-run per-record detail (Stage 3C2-A ledger).
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const loadDetail = useCallback(async (runId: string) => {
    if (detailId === runId) { setDetail(null); setDetailId(null); return; }   // toggle
    setDetailId(runId); setDetail(null);
    try { setDetail(await getOperationRunDetail(runId)); } catch { setDetail(null); }
  }, [detailId]);

  const load = useCallback(async () => {
    setError(null); setData(null);
    try { setData(await getFinancialReadiness()); }
    catch (e) { setError(e instanceof OperationsError ? e.message : 'Could not load financial readiness.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const controlFor = useCallback((k: string): ControlState | undefined => data?.controls.find((c) => c.controlName === k)?.state, [data]);
  const executionPermitted = useMemo(() => {
    const s = controlFor(op);
    return s === 'scoped_execution' || s === 'enabled';
  }, [controlFor, op]);

  const runPreview = useCallback(async () => {
    setPreviewError(null); setPreview(null);
    const ids = idsText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) { setPreviewError('Enter at least one record id (comma or space separated).'); return; }
    if (!reason.trim()) { setPreviewError('A reason is required.'); return; }
    setPreviewing(true);
    try {
      const run = await requestOperationRun({ operationType: op, executionMode: 'preview', scopeType: 'record_ids', scopedIds: ids, reason: reason.trim() });
      setPreview(await previewOperationRun(run.runId));
    } catch (e) {
      setPreviewError(e instanceof OperationsError ? e.message : 'Preview failed.');
    } finally { setPreviewing(false); }
  }, [idsText, reason, op]);

  return (
    <>
      <PageHeader title="Financial operations" subtitle="Readiness, kill-switch controls and side-effect-free previews. No money is moved from this page." />

      {data && (
        <div className="banner mb-4 row-wrap small">
          <ShieldAlert size={16} aria-hidden="true" />
          <span className="bold">Environment: {data.environment}</span>
          {Object.entries(data.thresholds).map(([k, v]) => (
            <span key={k} className="badge badge-neutral">{k.replace(/_/g, ' ')}: {v}</span>
          ))}
        </div>
      )}

      {error && (
        <div className="banner banner-danger mb-4 row small">
          <AlertTriangle size={16} aria-hidden="true" /> <span className="grow">{error}</span>
          <button onClick={() => void load()} className="btn btn-ghost btn-small">Retry</button>
        </div>
      )}

      {data === null && !error && (
        <div className="stack-list" style={{ gap: 'var(--space-2)' }} aria-hidden>{[0, 1, 2].map((i) => <div key={i} className="skeleton-block" />)}</div>
      )}

      {data && (
        <>
          {/* Readiness counts */}
          <h2 className="section-label" style={{ marginTop: 'var(--space-5)' }}>Readiness</h2>
          <div className="stat-grid" style={{ marginBottom: 'var(--space-6)' }}>
            {Object.entries(data.counts).map(([k, v]) => (
              <div key={k} className={`card card-tight stat-tile ${countTone(SEVERITY[k] ?? 'info', v)}`}>
                <div className="stat-value">{v}</div>
                <div className="muted small">{COUNT_LABELS[k] ?? k}</div>
              </div>
            ))}
          </div>

          {/* Kill-switch controls (read-only view; transitions go through the audited RPC) */}
          <h2 className="section-label">Kill-switch controls</h2>
          <div className="settings-group mb-4">
            {data.controls.map((c) => (
              <div key={c.controlName} className="row between" style={{ padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--color-border)' }}>
                <span className="bold">{c.controlName.replace(/_/g, ' ')}</span>
                <span className={`badge ${controlStyle(c.state)}`}>{c.state}</span>
              </div>
            ))}
          </div>

          {/* Side-effect-free preview tool */}
          <h2 className="section-label">Preview a scoped operation</h2>
          <div className="card mb-4">
            <div className="field">
              <label htmlFor="op-select">Operation</label>
              <select id="op-select" value={op} onChange={(e) => { setOp(e.target.value as OperationType); setPreview(null); }}>
                {OPERATIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ids-text">Record ids (comma or space separated — bounded to the max batch size)</label>
              <textarea id="ids-text" value={idsText} onChange={(e) => setIdsText(e.target.value)} rows={2}
                placeholder="e.g. 11111111-1111-1111-1111-111111111111, 2222…" style={{ fontFamily: 'monospace', fontSize: '0.85em' }} />
            </div>
            <div className="field">
              <label htmlFor="reason-input">Reason</label>
              <input id="reason-input" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="row-wrap">
              <button onClick={() => void runPreview()} disabled={previewing} className="btn btn-secondary btn-small">
                {previewing ? <Loader2 size={15} className="call-waiting-pulse" /> : <Eye size={15} />} Preview (dry-run)
              </button>
              <button disabled title={executionPermitted ? 'Execution is enabled by control state' : 'Execution is disabled by the server control'}
                className="btn btn-small" aria-disabled="true">
                Execute {executionPermitted ? '(control permits — Stage 3C2)' : '(blocked by control)'}
              </button>
            </div>
            {previewError && <p className="small mt-2" style={{ color: 'var(--color-danger-text)' }}>{previewError}</p>}

            {preview && (
              <div className="mt-4">
                <div className="muted small mb-2">Examined {preview.examined} · eligible {preview.eligible}</div>
                <ul className="stack-list" style={{ gap: 'var(--space-2)' }}>
                  {preview.rows.map((r) => (
                    <li key={r.id} className="card card-tight small">
                      <div className="row-wrap">
                        <span style={{ fontFamily: 'monospace' }} className="muted">{r.id.slice(0, 8)}…</span>
                        <span className="badge badge-neutral">{r.currentState ?? '—'}</span>
                        <span className={`badge ${r.eligible ? 'badge-success' : 'badge-neutral'}`}>{r.eligible ? 'eligible' : 'ineligible'}</span>
                        <span className="muted" style={{ marginLeft: 'auto' }}>→ {r.expectedNextState ?? '—'}</span>
                      </div>
                      {r.blockingReasons.length > 0 && (
                        <div className="muted mt-2">Blocked: {r.blockingReasons.join(', ')}</div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Recent runs */}
          <h2 className="section-label">Recent operation runs</h2>
          {data.recentRuns.length === 0 ? (
            <EmptyState title="No runs yet" body="Requested operation runs will appear here." />
          ) : (
            <ul className="stack-list" style={{ gap: 'var(--space-2)' }}>
              {data.recentRuns.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => void loadDetail(r.id)} className="agenda-row" style={{ flexWrap: 'wrap' }}>
                    <span className="bold">{r.operationType.replace(/_/g, ' ')}</span>
                    <span className="badge badge-neutral">{r.executionMode}</span>
                    <span className="badge badge-neutral">{r.state}</span>
                    {r.dryRun && <span className="badge badge-pending">dry-run</span>}
                    <span className="muted small" style={{ marginLeft: 'auto' }}>examined {r.rowsExamined} · eligible {r.rowsEligible}</span>
                  </button>
                  {detailId === r.id && (
                    <div className="card card-tight card-muted mt-2 small">
                      {detail === null ? (
                        <span className="muted">Loading record results…</span>
                      ) : detail.items.length === 0 ? (
                        <span className="muted">No per-record results (preview or not yet executed).</span>
                      ) : (
                        <ul className="stack-list" style={{ gap: 'var(--space-2)' }}>
                          {detail.items.map((it) => (
                            <li key={it.recordId} className="row-wrap">
                              <span className="muted">#{it.ordinal}</span>
                              <span style={{ fontFamily: 'monospace' }} className="muted">{it.recordId.slice(0, 8)}…</span>
                              <span className={`badge ${OUTCOME_STYLE[it.outcome] ?? 'badge-neutral'}`}>{it.outcome}</span>
                              {it.reasonCode && <span className="muted">{it.reasonCode}</span>}
                              <span className="muted" style={{ marginLeft: 'auto' }}>{it.beforeState ?? '—'} → {it.afterState ?? '—'}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
