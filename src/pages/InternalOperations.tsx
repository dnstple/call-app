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
  { key: 'transfer_finalise', label: 'Transfer finalise (not yet enabled)', executable: false },
  { key: 'refund_claim', label: 'Refund claim (not yet enabled)', executable: false },
  { key: 'refund_finalise', label: 'Refund finalise (not yet enabled)', executable: false },
  { key: 'plan_renewal', label: 'Plan renewal', executable: true },
  { key: 'dispute_reconciliation', label: 'Dispute reconciliation (not yet enabled)', executable: false },
  { key: 'financial_reconciliation', label: 'Financial reconciliation (not yet enabled)', executable: false },
  { key: 'evidence_review_release', label: 'Evidence-review release (not yet enabled)', executable: false },
];

// Per-record outcome badge styling (Stage 3C2-A earning-release ledger).
const OUTCOME_STYLE: Record<string, string> = {
  released: 'bg-emerald-100 text-emerald-700', already_payable: 'bg-sky-100 text-sky-700',
  not_found: 'bg-stone-200 text-stone-600', not_yet_eligible: 'bg-amber-100 text-amber-700',
  issue_held: 'bg-amber-100 text-amber-700', evidence_held: 'bg-amber-100 text-amber-700',
  reversed: 'bg-red-100 text-red-700', transfer_already_started: 'bg-sky-100 text-sky-700',
  invalid_state: 'bg-red-100 text-red-700', failed: 'bg-red-100 text-red-700',
  // Stage 3C2-B plan-renewal ledger: distinguish credit-covered completion,
  // prepared-with-provider-work-pending, already-renewed and ineligible states.
  renewed_credit_covered: 'bg-emerald-100 text-emerald-700',
  closed_zero_occurrences: 'bg-emerald-100 text-emerald-700',
  renewal_prepared: 'bg-indigo-100 text-indigo-700',
  already_renewed: 'bg-sky-100 text-sky-700',
  action_required_existing: 'bg-indigo-100 text-indigo-700',
  payment_failed_existing: 'bg-red-100 text-red-700',
  plan_not_active: 'bg-amber-100 text-amber-700', plan_paused: 'bg-amber-100 text-amber-700',
  plan_ended: 'bg-amber-100 text-amber-700', billing_not_enabled: 'bg-amber-100 text-amber-700',
  not_recurring: 'bg-amber-100 text-amber-700',
  // Stage 3C2-C1 transfer review (read-only — records classification only; no
  // attempt is created and no provider work is queued). STRONG warnings where
  // provider truth is unknown or terminal: lookup-required / permanent failure /
  // transferred / reversed. No retry action exists and nothing calls the provider.
  eligible_provider_action_required: 'bg-indigo-100 text-indigo-700',
  provider_lookup_required: 'bg-red-100 text-red-700 font-semibold',
  already_processing: 'bg-indigo-100 text-indigo-700',
  already_transferred: 'bg-sky-100 text-sky-700',
  not_payable: 'bg-amber-100 text-amber-700', held_for_issue: 'bg-amber-100 text-amber-700',
  connect_not_ready: 'bg-amber-100 text-amber-700', zero_amount: 'bg-stone-200 text-stone-600',
  retryable_failure: 'bg-amber-100 text-amber-700',
  permanent_failure: 'bg-red-100 text-red-700 font-semibold',
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

function countStyle(sev: 'info' | 'warning' | 'critical', value: number): string {
  if (value === 0) return 'border-stone-200 bg-white';
  if (sev === 'critical') return 'border-red-200 bg-red-50';
  if (sev === 'warning') return 'border-amber-200 bg-amber-50';
  return 'border-stone-200 bg-white';
}
function controlStyle(s: ControlState): string {
  switch (s) {
    case 'enabled': return 'bg-emerald-100 text-emerald-700';
    case 'scoped_execution': return 'bg-sky-100 text-sky-700';
    case 'dry_run_only': return 'bg-amber-100 text-amber-700';
    default: return 'bg-stone-200 text-stone-600';
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
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <PageHeader title="Financial operations" subtitle="Readiness, kill-switch controls and side-effect-free previews. No money is moved from this page." />

      {data && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm">
          <ShieldAlert size={16} className="text-stone-500" />
          <span className="font-medium text-stone-700">Environment: {data.environment}</span>
          <span className="text-stone-400">·</span>
          {Object.entries(data.thresholds).map(([k, v]) => (
            <span key={k} className="rounded-full bg-white px-2 py-0.5 text-xs text-stone-500">{k.replace(/_/g, ' ')}: {v}</span>
          ))}
        </div>
      )}

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle size={16} /> {error}
          <button onClick={() => void load()} className="ml-auto font-medium underline">Retry</button>
        </div>
      )}

      {data === null && !error && (
        <div className="space-y-2" aria-hidden>{[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-stone-100" />)}</div>
      )}

      {data && (
        <>
          {/* Readiness counts */}
          <h2 className="mb-2 text-sm font-semibold text-stone-700">Readiness</h2>
          <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {Object.entries(data.counts).map(([k, v]) => (
              <div key={k} className={`rounded-xl border px-3 py-2 ${countStyle(SEVERITY[k] ?? 'info', v)}`}>
                <div className="text-lg font-semibold text-stone-800">{v}</div>
                <div className="text-xs text-stone-500">{COUNT_LABELS[k] ?? k}</div>
              </div>
            ))}
          </div>

          {/* Kill-switch controls (read-only view; transitions go through the audited RPC) */}
          <h2 className="mb-2 text-sm font-semibold text-stone-700">Kill-switch controls</h2>
          <div className="mb-6 overflow-hidden rounded-xl border border-stone-200">
            {data.controls.map((c) => (
              <div key={c.controlName} className="flex items-center gap-2 border-b border-stone-100 px-4 py-2 last:border-0">
                <span className="font-medium text-stone-700">{c.controlName.replace(/_/g, ' ')}</span>
                <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium ${controlStyle(c.state)}`}>{c.state}</span>
              </div>
            ))}
          </div>

          {/* Side-effect-free preview tool */}
          <h2 className="mb-2 text-sm font-semibold text-stone-700">Preview a scoped operation</h2>
          <div className="mb-6 rounded-xl border border-stone-200 p-4">
            <div className="flex flex-col gap-3">
              <label className="text-sm text-stone-600">Operation
                <select value={op} onChange={(e) => { setOp(e.target.value as OperationType); setPreview(null); }}
                  className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2 text-sm">
                  {OPERATIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
              </label>
              <label className="text-sm text-stone-600">Record ids (comma or space separated — bounded to the max batch size)
                <textarea value={idsText} onChange={(e) => setIdsText(e.target.value)} rows={2}
                  placeholder="e.g. 11111111-1111-1111-1111-111111111111, 2222…"
                  className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2 font-mono text-xs" />
              </label>
              <label className="text-sm text-stone-600">Reason
                <input value={reason} onChange={(e) => setReason(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2 text-sm" />
              </label>
              <div className="flex items-center gap-3">
                <button onClick={() => void runPreview()} disabled={previewing}
                  className="inline-flex items-center gap-2 rounded-lg bg-stone-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                  {previewing ? <Loader2 size={15} className="animate-spin" /> : <Eye size={15} />} Preview (dry-run)
                </button>
                <button disabled title={executionPermitted ? 'Execution is enabled by control state' : 'Execution is disabled by the server control'}
                  className="inline-flex items-center gap-2 rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium text-stone-400"
                  aria-disabled="true">
                  Execute {executionPermitted ? '(control permits — Stage 3C2)' : '(blocked by control)'}
                </button>
              </div>
              {previewError && <div className="text-sm text-red-600">{previewError}</div>}
            </div>

            {preview && (
              <div className="mt-4">
                <div className="mb-2 text-sm text-stone-600">Examined {preview.examined} · eligible {preview.eligible}</div>
                <ul className="space-y-1">
                  {preview.rows.map((r) => (
                    <li key={r.id} className={`rounded-lg border px-3 py-2 text-xs ${r.eligible ? 'border-emerald-200 bg-emerald-50' : 'border-stone-200 bg-stone-50'}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-stone-600">{r.id.slice(0, 8)}…</span>
                        <span className="rounded-full bg-white px-2 py-0.5 text-stone-600">{r.currentState ?? '—'}</span>
                        <span className={`rounded-full px-2 py-0.5 ${r.eligible ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-200 text-stone-600'}`}>
                          {r.eligible ? 'eligible' : 'ineligible'}
                        </span>
                        <span className="ml-auto text-stone-400">→ {r.expectedNextState ?? '—'}</span>
                      </div>
                      {r.blockingReasons.length > 0 && (
                        <div className="mt-1 text-stone-500">Blocked: {r.blockingReasons.join(', ')}</div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Recent runs */}
          <h2 className="mb-2 text-sm font-semibold text-stone-700">Recent operation runs</h2>
          {data.recentRuns.length === 0 ? (
            <EmptyState title="No runs yet" body="Requested operation runs will appear here." />
          ) : (
            <ul className="space-y-1">
              {data.recentRuns.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => void loadDetail(r.id)}
                    className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-stone-200 px-3 py-2 text-left text-sm hover:border-stone-300">
                    <span className="font-medium text-stone-700">{r.operationType.replace(/_/g, ' ')}</span>
                    <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600">{r.executionMode}</span>
                    <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600">{r.state}</span>
                    {r.dryRun && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">dry-run</span>}
                    <span className="ml-auto text-xs text-stone-400">examined {r.rowsExamined} · eligible {r.rowsEligible}</span>
                  </button>
                  {detailId === r.id && (
                    <div className="mt-1 rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs">
                      {detail === null ? (
                        <span className="text-stone-400">Loading record results…</span>
                      ) : detail.items.length === 0 ? (
                        <span className="text-stone-500">No per-record results (preview or not yet executed).</span>
                      ) : (
                        <ul className="space-y-1">
                          {detail.items.map((it) => (
                            <li key={it.recordId} className="flex flex-wrap items-center gap-2">
                              <span className="text-stone-400">#{it.ordinal}</span>
                              <span className="font-mono text-stone-600">{it.recordId.slice(0, 8)}…</span>
                              <span className={`rounded-full px-2 py-0.5 ${OUTCOME_STYLE[it.outcome] ?? 'bg-stone-200 text-stone-600'}`}>{it.outcome}</span>
                              {it.reasonCode && <span className="text-stone-500">{it.reasonCode}</span>}
                              <span className="ml-auto text-stone-400">{it.beforeState ?? '—'} → {it.afterState ?? '—'}</span>
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
    </div>
  );
}
