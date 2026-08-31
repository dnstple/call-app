/**
 * Support-admin control panel for the backup-companion / call-failover engine.
 * Shows the feature flags (with an obvious enable/disable), the timing
 * constants, a one-click backfill, and the list of calls currently in a
 * backup/cover state with per-call actions. Rendered inside the internal
 * Bookings console. All actions call server-side, support-gated RPCs.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, ShieldAlert, RefreshCw } from 'lucide-react';
import {
  getFailoverConfig, setFailoverConfig, runBackfill, flushPendingSms,
  getActiveFailovers, switchNow, keepPrimary, startBackupSearch,
  type ActiveFailoverCall,
} from '../repositories/failoverRepository';
import type { BackupFailoverConfig } from '../config/backupFailover';

function when(iso: string): string {
  try { return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}
function stateLabel(s: string): string {
  return ({ searching: 'Searching for cover', available: 'Backup available', reassigning: 'Reassigning…', cover_required: 'Cover required' } as Record<string, string>)[s] ?? s;
}

export function FailoverControlPanel() {
  const [cfg, setCfg] = useState<BackupFailoverConfig | null>(null);
  const [active, setActive] = useState<ActiveFailoverCall[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    getFailoverConfig().then(setCfg).catch(() => setCfg(null));
    getActiveFailovers().then(setActive).catch(() => setActive([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = async (patch: { failoverEnabled?: boolean; smsEnabled?: boolean }) => {
    setBusy(true); setMsg(null);
    const next = await setFailoverConfig(patch);
    setBusy(false);
    if (next) { setCfg(next); setMsg('Saved.'); } else setMsg('Could not save.');
  };
  const onBackfill = async () => {
    setBusy(true); setMsg(null);
    const r = await runBackfill();
    setBusy(false); setMsg(r.detail); load();
  };
  const onFlush = async () => {
    setBusy(true); setMsg(null);
    const r = await flushPendingSms();
    setBusy(false); setMsg(r.detail); load();
  };
  const act = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg(`${label} done.`); } catch { setMsg(`${label} failed.`); }
    setBusy(false); load();
  };

  if (!cfg) {
    return (
      <section className="card section-tight" aria-label="Backup & failover">
        <h2 className="section-label" style={{ margin: 0 }}>Backup &amp; failover</h2>
        <p className="muted small" style={{ margin: '6px 0 0' }}>Loading… (support-admin only).</p>
      </section>
    );
  }

  return (
    <section className="card section-tight col" style={{ gap: 12 }} aria-label="Backup & failover">
      <div className="row between" style={{ alignItems: 'center' }}>
        <h2 className="section-label" style={{ margin: 0 }}>Backup &amp; failover</h2>
        <button className="btn btn-ghost btn-small" onClick={load} disabled={busy}><RefreshCw size={15} aria-hidden="true" /> Refresh</button>
      </div>

      {!cfg.failoverEnabled && (
        <div className="row" style={{ gap: 8, alignItems: 'center', color: 'var(--muted, #6b625c)' }}>
          <ShieldAlert size={16} aria-hidden="true" /> <span className="small">The engine is OFF. Nothing runs until you enable it.</span>
        </div>
      )}

      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <button className={`btn btn-small ${cfg.failoverEnabled ? 'btn-secondary' : 'btn-primary'}`} disabled={busy}
          onClick={() => toggle({ failoverEnabled: !cfg.failoverEnabled })}>
          {cfg.failoverEnabled ? 'Disable failover' : 'Enable failover'}
        </button>
        <button className={`btn btn-small ${cfg.smsEnabled ? 'btn-secondary' : 'btn-primary'}`} disabled={busy}
          onClick={() => toggle({ smsEnabled: !cfg.smsEnabled })}>
          {cfg.smsEnabled ? 'Disable SMS' : 'Enable SMS'}
        </button>
        <button className="btn btn-ghost btn-small" disabled={busy} onClick={onBackfill}>
          {busy ? <Loader2 size={15} className="spin" aria-hidden="true" /> : null} Run backfill now
        </button>
        <button className="btn btn-ghost btn-small" disabled={busy} onClick={onFlush}>
          {busy ? <Loader2 size={15} className="spin" aria-hidden="true" /> : null} Send pending texts now
        </button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Search starts T‑{Math.round(cfg.backupSearchStartMins / 60)}h · failover at T‑{Math.round(cfg.primaryAcceptanceDeadlineMins / 60)}h ·
        batches {cfg.initialBatchSize}/{cfg.emergencyBatchSize}. Enable failover first, then SMS; backfill picks up today's existing calls.
      </p>
      {msg && <p role="status" className="small" style={{ margin: 0 }}>{msg}</p>}

      <div style={{ borderTop: '1px solid var(--border, #FBE9DE)', paddingTop: 10 }}>
        <h3 className="section-label" style={{ margin: '0 0 6px' }}>Calls in backup / cover ({active.length})</h3>
        {active.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>No calls currently need cover.</p>
        ) : (
          <div className="stack-list">
            {active.map((a) => (
              <div key={a.booking_id} className="row between wrap" style={{ gap: 8, alignItems: 'center', padding: '6px 0' }}>
                <div>
                  <strong>{when(a.starts_at)}</strong> · {a.duration_minutes}m ·{' '}
                  {a.member_first ?? 'Member'} with {a.companion_first ?? 'companion'}
                  <div className="muted small">
                    {stateLabel(a.backup_state)} — {a.available_count} available / {a.offers_out} awaiting reply
                  </div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn btn-ghost btn-small" disabled={busy}
                    onClick={() => act(() => startBackupSearch(a.booking_id, a.backup_state === 'cover_required'), 'Search')}>Search now</button>
                  <button className="btn btn-primary btn-small" disabled={busy}
                    onClick={() => act(() => switchNow(a.booking_id), 'Switch')}>Switch now</button>
                  <button className="btn btn-secondary btn-small" disabled={busy}
                    onClick={() => act(() => keepPrimary(a.booking_id), 'Keep primary')}>Keep original</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
