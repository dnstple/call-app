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
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      <PageHeader title="Trust & safety" subtitle="Companion moderation, safeguarding reports and blocks" />
      {error && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</div>}

      {health && (
        <section className="mt-6">
          <h2 className="text-base font-semibold text-stone-800">Operational health</h2>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {([
              ['Open concerns', health.open_concerns],
              ['Pending moderation', health.companions_pending_moderation],
              ['Earnings held', health.earnings_held],
              ['Active blocks', health.active_blocks],
              ['Emails pending', health.email_pending],
              ['Emails failed', health.email_failed],
            ] as [string, number][]).map(([label, n]) => (
              <div key={label} className="rounded-xl border border-stone-200 bg-white p-3">
                <div className="text-2xl font-semibold text-stone-800">{n}</div>
                <div className="text-xs text-stone-500">{label}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-6">
        <h2 className="text-base font-semibold text-stone-800">Companion moderation</h2>
        <div className="mt-2 space-y-2">
          {mods.length === 0 && <p className="text-sm text-stone-500">No companions.</p>}
          {mods.map((m) => (
            <div key={m.profile_id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-stone-200 bg-white p-3">
              <div className="text-sm">
                <span className="font-medium text-stone-800">{m.first_name} {m.last_initial}.</span>
                <span className="ml-2 rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600">{m.moderation_status}</span>
                <span className="ml-2 text-xs text-stone-400">{m.completion_pct}% complete</span>
              </div>
              <div className="flex gap-2">
                {m.moderation_status !== 'approved' && <button disabled={busy} className="btn btn-ghost text-sm" onClick={() => void moderate(m.profile_id, 'approved')}>Approve</button>}
                {m.moderation_status !== 'suspended' && <button disabled={busy} className="btn btn-ghost text-sm" onClick={() => void moderate(m.profile_id, 'suspended')}>Suspend</button>}
                {m.moderation_status !== 'rejected' && <button disabled={busy} className="btn btn-ghost text-sm" onClick={() => void moderate(m.profile_id, 'rejected')}>Reject</button>}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-base font-semibold text-stone-800">Safeguarding & concern reports</h2>
        <div className="mt-2 space-y-2">
          {concerns.length === 0 && <p className="text-sm text-stone-500">No open concerns.</p>}
          {concerns.map((c) => (
            <div key={c.concern_id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-stone-200 bg-white p-3">
              <div className="text-sm">
                {c.priority === 'high' && <span className="mr-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">High</span>}
                <span className="font-medium text-stone-800">{c.category.replace(/_/g, ' ')}</span>
                <span className="ml-2 text-xs text-stone-500">by {c.reporter_role}</span>
                {c.earning_held && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">payout held</span>}
              </div>
              <button disabled={busy} className="btn btn-ghost text-sm" onClick={() => void resolve(c.concern_id)}>Resolve</button>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-base font-semibold text-stone-800">Active blocks</h2>
        <div className="mt-2 space-y-1">
          {blocks.length === 0 && <p className="text-sm text-stone-500">No active blocks.</p>}
          {blocks.map((b) => (
            <div key={b.block_id} className="rounded-lg border border-stone-100 bg-white px-3 py-2 text-xs text-stone-600">
              {b.direction.replace(/_/g, ' ')} {b.coordinator_authority ? '(coordinator)' : ''} · {new Date(b.created_at).toLocaleDateString('en-GB')}
            </div>
          ))}
        </div>
      </section>

      {conflicts.length > 0 && (
        <section className="mt-8">
          <h2 className="text-base font-semibold text-red-700">Blocks colliding with future bookings</h2>
          <p className="mt-1 text-xs text-stone-500">These are surfaced for manual review. Bookings are never auto-cancelled or refunded.</p>
          <div className="mt-2 space-y-1">
            {conflicts.map((c) => (
              <div key={c.block_id + c.booking_id} className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-800">
                Booking {c.booking_id.slice(0, 8)} on {new Date(c.starts_at).toLocaleString('en-GB')} — {c.direction.replace(/_/g, ' ')}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
