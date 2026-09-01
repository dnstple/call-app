/**
 * Payouts to release (support-only). Lists the payout runs prepared automatically
 * by the daily scheduler (migration 0194) and lets a support admin RELEASE each
 * one. Release walks the existing audited saga (preview -> confirm -> execute ->
 * scoped provider transfer); this page holds no money logic. Every server gate
 * (transfer control state, amount ceiling, livemode, the live-execution block)
 * simply surfaces here as a clear message — nothing is bypassed. The route is
 * DB-role protected by <SupportOnly>.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Banknote, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { EmptyState, PageHeader } from '../components/ui';
import {
  listPayoutRuns, releasePayoutRun,
  OperationsError, type PayoutRunSummary, type ReleaseResult,
} from '../repositories/financialOperationsRepository';

const gbp = (minor: number) => `£${(minor / 100).toFixed(2)}`;

function blockMessage(code: string): string {
  switch (code) {
    case 'control_disabled':
      return 'Transfer execution is switched off. Enable the transfer_finalise control in Financial operations first.';
    case 'dry_run_only':
      return 'The transfer control is dry-run only — execution is blocked.';
    case 'amount_ceiling_unconfigured':
      return 'Set a payout amount ceiling (it defaults to 0, which blocks all payouts) before releasing.';
    case 'amount_ceiling_exceeded':
      return 'This batch exceeds the configured amount ceiling. Raise the ceiling or release fewer at once.';
    case 'production_live_execution_not_yet_enabled':
      return 'Live payouts are not switched on yet. This is the deliberate go-live gate.';
    case 'production_live_locked':
      return 'Production-live operations are locked. Unlock them to release real money.';
    case 'run_expired':
      return 'This batch expired before release. It will be re-prepared on the next daily run.';
    default:
      return `The server refused this release (${code}).`;
  }
}

export default function InternalPayouts() {
  const [runs, setRuns] = useState<PayoutRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyRun, setBusyRun] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { kind: 'ok' | 'blocked' | 'error'; text: string }>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      setRuns(await listPayoutRuns());
    } catch (e) {
      setError(e instanceof OperationsError ? e.message : 'Could not load prepared payouts.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const release = useCallback(async (run: PayoutRunSummary) => {
    setBusyRun(run.runId);
    setResults((r) => ({ ...r, [run.runId]: undefined as never }));
    try {
      const res: ReleaseResult = await releasePayoutRun(run.runId, run.confirmationToken);
      if (!res.ok && res.blockedCode) {
        setResults((r) => ({ ...r, [run.runId]: { kind: 'blocked', text: blockMessage(res.blockedCode!) } }));
      } else {
        const bits = [`${res.finalized} paid`];
        if (res.reconciliation) bits.push(`${res.reconciliation} need review`);
        if (res.failed) bits.push(`${res.failed} failed`);
        if (res.skipped) bits.push(`${res.skipped} skipped`);
        setResults((r) => ({ ...r, [run.runId]: { kind: 'ok', text: bits.join(', ') } }));
      }
    } catch (e) {
      setResults((r) => ({ ...r, [run.runId]: { kind: 'error', text: e instanceof OperationsError ? e.message : 'Release failed.' } }));
    } finally {
      setBusyRun(null);
      void load();
    }
  }, [load]);

  return (
    <div>
      <PageHeader
        title="Payouts to release"
        subtitle="Batches prepared automatically each day. Releasing sends real money to companions — review before you approve."
      />

      <div className="flex items-center gap-2 mt-2 mb-3">
        <button className="btn btn-ghost btn-small" onClick={() => void load()}>
          <RefreshCw size={15} aria-hidden="true" /> Refresh
        </button>
      </div>

      {error && (
        <p className="small" style={{ color: 'var(--color-danger-text)' }}>
          <AlertTriangle size={14} aria-hidden="true" /> {error}
        </p>
      )}

      {runs === null && !error && (
        <p className="muted small"><Loader2 size={15} className="call-waiting-pulse" aria-hidden="true" /> Loading…</p>
      )}

      {runs !== null && runs.length === 0 && (
        <EmptyState
          title="Nothing to release"
          body="No payout batches are waiting. New batches are prepared automatically each morning once companions are onboarded and have delivered calls."
        />
      )}

      {runs !== null && runs.length > 0 && (
        <div className="stack-list">
          {runs.map((run) => {
            const result = results[run.runId];
            const busy = busyRun === run.runId;
            return (
              <div key={run.runId} className="card" style={{ padding: '14px 16px', marginBottom: 10 }}>
                <div className="flex items-center justify-between" style={{ gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Banknote size={16} aria-hidden="true" /> {gbp(run.totalMinor)}
                      <span className="muted small">· {run.earningCount} earning{run.earningCount === 1 ? '' : 's'}</span>
                    </div>
                    <div className="muted small">{run.reason}</div>
                  </div>
                  <button
                    className="btn btn-primary btn-small"
                    disabled={busy}
                    onClick={() => void release(run)}
                  >
                    {busy ? <Loader2 size={15} className="call-waiting-pulse" aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
                    {busy ? 'Releasing…' : 'Release'}
                  </button>
                </div>

                {run.companions.length > 0 && (
                  <div className="mt-2" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {run.companions.map((c, i) => (
                      <span key={i} className="pill small">{c.name ?? 'Companion'} — {gbp(c.amountMinor)}</span>
                    ))}
                  </div>
                )}

                {result && (
                  <p
                    className="small mt-2"
                    style={{ color: result.kind === 'ok' ? 'var(--color-success-text)' : result.kind === 'blocked' ? 'var(--color-warning-text, var(--color-text))' : 'var(--color-danger-text)' }}
                  >
                    {result.kind === 'ok' ? <CheckCircle2 size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />} {result.text}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
