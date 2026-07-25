/**
 * Stage 3E-G — Companion earnings panel (Settings, companion role only).
 *
 * Read-only view over the 0085 owner-scoped projections. All grouping and
 * status vocabulary comes from the server (single authority); this panel
 * renders buckets and a recent list with neutral wording. It never shows
 * provider identifiers, bank details, or another user's information, and it
 * never claims 'Paid' for anything that has not genuinely transferred.
 */
import { useEffect, useState } from 'react';
import {
  EARNING_BUCKET_COPY,
  getMyEarningsSummary,
  listMyEarnings,
  type CompanionEarningRow,
  type EarningsSummary,
} from '../repositories/earningsRepository';

const fmt = (minor: number) => `£${(minor / 100).toFixed(2)}`;

const SUMMARY_ORDER = ['available', 'processing', 'pending', 'on_hold', 'transferred', 'action_required'] as const;

export function EarningsPanel() {
  const [summary, setSummary] = useState<EarningsSummary | null>(null);
  const [rows, setRows] = useState<CompanionEarningRow[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    void getMyEarningsSummary().then((s) => { if (alive) setSummary(s); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!expanded || rows !== null) return;
    let alive = true;
    void listMyEarnings(50).then((r) => { if (alive) setRows(r); });
    return () => { alive = false; };
  }, [expanded, rows]);

  const anyEarnings = summary && SUMMARY_ORDER.some((b) => summary.countsByBucket[b] > 0);

  return (
    <section className="card col" style={{ gap: 10 }} aria-label="Earnings">
      <h3 style={{ margin: 0 }}>Earnings</h3>
      {!summary && <span className="small" role="status">Loading your earnings…</span>}
      {summary && !anyEarnings && (
        <p className="muted small" style={{ margin: 0 }}>
          Your earnings from completed conversations will appear here.
        </p>
      )}
      {summary && anyEarnings && (
        <div className="col" style={{ gap: 6 }}>
          {SUMMARY_ORDER.filter((b) => summary.countsByBucket[b] > 0).map((b) => (
            <div key={b} className="row" style={{ justifyContent: 'space-between' }}>
              <span title={EARNING_BUCKET_COPY[b].hint}>{EARNING_BUCKET_COPY[b].label}</span>
              <strong>{fmt(summary.totalsMinor[b])}</strong>
            </div>
          ))}
        </div>
      )}
      {summary && anyEarnings && (
        <button className="btn btn-ghost btn-small" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Hide details' : 'Show details'}
        </button>
      )}
      {expanded && rows === null && <span className="small" role="status">Loading…</span>}
      {expanded && rows !== null && rows.length > 0 && (
        <ul className="col" style={{ gap: 8, listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map((r) => (
            <li key={r.earningId} className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
              <span className="small">
                {r.bookingStartsAt ? new Date(r.bookingStartsAt).toLocaleDateString('en-GB') : '—'}
                {' · '}{r.memberFirstName}{r.isTrial ? ' · Trial' : ''}
              </span>
              <span className="small muted">{EARNING_BUCKET_COPY[r.bucket].label}</span>
              <strong className="small">{fmt(r.netMinor)}</strong>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small" style={{ margin: 0 }}>
        Amounts shown are what you receive after the platform fee. Trials carry
        no platform fee. Payouts are sent to your Stripe account once confirmed.
      </p>
    </section>
  );
}
