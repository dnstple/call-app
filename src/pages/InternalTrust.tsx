/**
 * Block 2 — support Trust & Safety console (SupportOnly).
 *
 * Extends the existing support surface (never a second admin system). Every read
 * and every action goes through a SECURITY DEFINER RPC that re-checks
 * app_private.is_support_admin() server-side. Support can approve/suspend/reject
 * Companions, review safeguarding concerns, and inspect active blocks and
 * block↔future-booking conflicts. Support can NEVER edit payment amounts,
 * earning amounts, commission snapshots, Stripe destinations or transfer
 * results — those surfaces are not exposed here.
 */
import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../components/ui';
import {
  supportModerationOverview, supportSetModeration, supportConcernsOverview,
  supportResolveConcern, supportBlockOverview, supportBlockConflicts, supportSystemHealth,
  type ModerationRow, type ConcernRow, type BlockRow, type BlockConflictRow, type SystemHealth,
} from '../repositories/trustRepository';

export default function InternalTrust() {
  const [mods, setMods] = useState<ModerationRow[]>([]);
  const [concerns, setConcerns] = useState<ConcernRow[]>([]);
  const [blocks, setBlocks] = useState<BlockRow[]>([]);
  const [conflicts, setConflicts] = useState<BlockConflictRow[]>([]);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [m, c, b, cf, h] = await Promise.all([
        supportModerationOverview(), supportConcernsOverview(),
        supportBlockOverview(), supportBlockConflicts(), supportSystemHealth(),
      ]);
      setMods(m); setConcerns(c); setBlocks(b); setConflicts(cf); setHealth(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the trust & safety console.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const moderate = async (profileId: string, status: 'approved' | 'suspended' | 'rejected') => {
    let reason: string | undefined;
    if (status !== 'approved') {
      reason = window.prompt(`Reason for ${status}:`) ?? undefined;
      if (!reason || !reason.trim()) return;
    }
    setBusy(true);
    try { await supportSetModeration(profileId, status, reason); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Action failed.'); }
    finally { setBusy(false); }
  };

  const resolve = async (concernId: string) => {
    setBusy(true);
    try { await supportResolveConcern(concernId, window.prompt('Resolution note (optional):') ?? undefined); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Action failed.'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader title="Trust & safety" subtitle="Companion moderation, safeguarding reports and blocks" />
      {error && <div className="banner banner-danger mb-4" role="alert">{error}</div>}

      {health && (
        <section className="section-tight">
          <h2>Operational health</h2>
          <div className="stat-grid">
            {([
              ['Open concerns', health.open_concerns],
              ['Pending moderation', health.companions_pending_moderation],
              ['Earnings held', health.earnings_held],
              ['Active blocks', health.active_blocks],
              ['Emails pending', health.email_pending],
              ['Emails failed', health.email_failed],
            ] as [string, number][]).map(([label, n]) => (
              <div key={label} className="card card-tight stat-tile">
                <div className="stat-value">{n}</div>
                <div className="muted small">{label}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="section-tight">
        <h2>Companion moderation</h2>
        <div className="stack-list">
          {mods.length === 0 && <p className="muted small">No companions.</p>}
          {mods.map((m) => (
            <div key={m.profile_id} className="card card-tight row between wrap">
              <div className="row-wrap">
                <span className="bold">{m.first_name} {m.last_initial}.</span>
                <span className="badge badge-neutral">{m.moderation_status}</span>
                <span className="muted small">{m.completion_pct}% complete</span>
              </div>
              <div className="row-wrap">
                {m.moderation_status !== 'approved' && <button disabled={busy} className="btn btn-secondary btn-small" onClick={() => void moderate(m.profile_id, 'approved')}>Approve</button>}
                {m.moderation_status !== 'suspended' && <button disabled={busy} className="btn btn-ghost btn-small" onClick={() => void moderate(m.profile_id, 'suspended')}>Suspend</button>}
                {m.moderation_status !== 'rejected' && <button disabled={busy} className="btn btn-ghost btn-small btn-danger" onClick={() => void moderate(m.profile_id, 'rejected')}>Reject</button>}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <h2>Safeguarding &amp; concern reports</h2>
        <div className="stack-list">
          {concerns.length === 0 && <p className="muted small">No open concerns.</p>}
          {concerns.map((c) => (
            <div key={c.concern_id} className="card card-tight row between wrap">
              <div className="row-wrap">
                {c.priority === 'high' && <span className="badge badge-danger">High</span>}
                <span className="bold">{c.category.replace(/_/g, ' ')}</span>
                <span className="muted small">by {c.reporter_role}</span>
                {c.earning_held && <span className="badge badge-pending">payout held</span>}
              </div>
              <button disabled={busy} className="btn btn-secondary btn-small" onClick={() => void resolve(c.concern_id)}>Resolve</button>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <h2>Active blocks</h2>
        <div className="stack-list" style={{ gap: 'var(--space-2)' }}>
          {blocks.length === 0 && <p className="muted small">No active blocks.</p>}
          {blocks.map((b) => (
            <div key={b.block_id} className="card card-tight muted small">
              {b.direction.replace(/_/g, ' ')} {b.coordinator_authority ? '(coordinator)' : ''} · {new Date(b.created_at).toLocaleDateString('en-GB')}
            </div>
          ))}
        </div>
      </section>

      {conflicts.length > 0 && (
        <section className="section">
          <h2 style={{ color: 'var(--color-danger-text)' }}>Blocks colliding with future bookings</h2>
          <p className="muted small">These are surfaced for manual review. Bookings are never auto-cancelled or refunded.</p>
          <div className="stack-list" style={{ gap: 'var(--space-2)' }}>
            {conflicts.map((c) => (
              <div key={c.block_id + c.booking_id} className="banner banner-danger small">
                Booking {c.booking_id.slice(0, 8)} on {new Date(c.starts_at).toLocaleString('en-GB')} — {c.direction.replace(/_/g, ' ')}
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
