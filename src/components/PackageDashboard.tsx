/**
 * Stage 2E3B1 — package dashboard (Supabase mode).
 *
 * Real purchases for the account's bookable Members, with balances that
 * ALWAYS come from the server-side ledger (never React state). Every row
 * carries the simulated/unpaid label — no payment has been taken, and
 * credits cannot be used for booking until Stage 2E3B2.
 */
import { useEffect, useState } from 'react';
import { Loader2, Package } from 'lucide-react';
import type { PackagePurchaseRow } from '../supabase/database.types';
import {
  getPackageBalance,
  listPackagePurchases,
  type PackageBalance,
} from '../repositories/packageRepository';
import { useAuthSnapshot } from '../state/authBridge';

const STATUS_LABELS: Record<PackagePurchaseRow['status'], string> = {
  active: 'Active',
  exhausted: 'All conversations used',
  cancelled: 'Cancelled',
};

/**
 * Stage 2E4B: plans are the product; a purchase backing a conversation
 * plan is hidden infrastructure and never shown as its own "package".
 */
function isPlanAllowance(purchase: PackagePurchaseRow): boolean {
  return purchase.package_offer_id === null;
}

interface Row {
  purchase: PackagePurchaseRow;
  balance: PackageBalance | null;
}

export function PackageDashboard() {
  const auth = useAuthSnapshot();
  const memberIds = auth.profiles
    .filter((p) => p.profile.role === 'member' && p.access.can_book)
    .map((p) => p.profile.id);
  const membersKey = memberIds.join(',');

  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (memberIds.length === 0) {
      setRows([]);
      return;
    }
    let live = true;
    (async () => {
      try {
        const purchases = (
          await Promise.all(memberIds.map((id) => listPackagePurchases(id)))
        )
          .flat()
          .filter((p) => !isPlanAllowance(p)); // plans render as plans, not packages
        // Authoritative balances come from the ledger, one call per purchase.
        const withBalances = await Promise.all(
          purchases.map(async (purchase) => ({
            purchase,
            balance: await getPackageBalance(purchase.id).catch(() => null),
          })),
        );
        if (live) setRows(withBalances);
      } catch {
        if (live) setError('We couldn’t load your earlier conversation bundles.');
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membersKey]);

  if (memberIds.length === 0) return null;

  if (rows !== null && rows.length === 0 && !error) return null;

  return (
    <section className="section-tight" aria-label="Earlier conversation bundles">
      <h2>Earlier conversation bundles</h2>
      {error ? (
        <p className="muted" role="alert">{error}</p>
      ) : rows === null ? (
        <div className="row" style={{ gap: 10 }}>
          <Loader2 size={18} aria-hidden="true" />
          <span className="muted">Loading…</span>
        </div>
      ) : rows.length === 0 ? (
        null // nothing to say: plans are shown by ConversationPlans
      ) : (
        <div className="stack-list">
          {rows.map(({ purchase, balance }) => (
            <div key={purchase.id} className="card card-tight row between wrap" style={{ gap: 10 }}>
              <div className="row" style={{ gap: 12 }}>
                <Package size={20} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
                <div className="col" style={{ gap: 2 }}>
                  <span className="bold">{purchase.title}</span>
                  <span className="muted small">
                    {purchase.duration_minutes}-minute conversations · bought{' '}
                    {new Date(purchase.purchased_at).toLocaleDateString('en-GB', {
                      day: 'numeric', month: 'long', year: 'numeric',
                    })}
                  </span>
                  <span className="faint small">
                    {STATUS_LABELS[purchase.status]} ·{' '}
                    {purchase.is_simulated && 'simulated purchase — no payment taken'}
                  </span>
                </div>
              </div>
              <div className="col" style={{ gap: 2, textAlign: 'right' }}>
                <span className="bold" style={{ fontSize: '1.15em' }}>
                  {balance ? `${balance.remaining} of ${purchase.conversation_count}` : '—'}
                </span>
                <span className="faint small">conversations remaining</span>
              </div>
            </div>
          ))}
          <p className="faint" style={{ margin: 0 }}>
            These are earlier test bundles kept for reference. Regular conversations now happen
            through conversation plans.
          </p>
        </div>
      )}
    </section>
  );
}
