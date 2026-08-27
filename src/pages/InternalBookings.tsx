/**
 * Internal Bookings console (/internal/bookings) — support-admin only.
 *
 * Read-only platform-wide view of every booking: who it's between, what kind
 * (trial vs paid), when it runs, and the full cost breakdown. Guarded by
 * <SupportOnly> in the router AND by app_private.require_support() inside the
 * admin_list_bookings RPC. Sortable client-side; no actions, no writes.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, RefreshCw, ArrowUp, ArrowDown } from 'lucide-react';
import { adminListBookings, getFallbackQueue, acceptFallback, type AdminBookingRow, type FallbackCall } from '../repositories/bookingsAdminRepository';

type SortKey = 'starts_at' | 'member_name' | 'companion_name' | 'kind' | 'status' | 'price_minor';

function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'GBP' }).format((minor ?? 0) / 100);
  } catch {
    return `£${((minor ?? 0) / 100).toFixed(2)}`;
  }
}

function when(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: tz || 'Europe/London',
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return new Date(iso).toLocaleString();
  }
}

function pretty(s: string | null | undefined): string {
  if (!s) return '—';
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function InternalBookings() {
  const [rows, setRows] = useState<AdminBookingRow[]>([]);
  const [currency, setCurrency] = useState('GBP');
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'starts_at', dir: 'desc' });

  const [fallbacks, setFallbacks] = useState<FallbackCall[]>([]);
  const loadFallbacks = useCallback(() => { getFallbackQueue().then(setFallbacks).catch(() => setFallbacks([])); }, []);

  const load = useCallback(() => {
    setLoading(true);
    loadFallbacks();
    adminListBookings(2000)
      .then((r) => { setRows(r.rows); setCurrency(r.currency); })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [loadFallbacks]);
  useEffect(() => { load(); }, [load]);

  const onAccept = async (id: string) => {
    const r = await acceptFallback(id);
    if (r.ok) loadFallbacks();
  };

  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      let av: string | number = '';
      let bv: string | number = '';
      if (sort.key === 'price_minor') { av = a.price_minor ?? 0; bv = b.price_minor ?? 0; }
      else if (sort.key === 'starts_at') { av = a.starts_at ?? ''; bv = b.starts_at ?? ''; }
      else { av = (a[sort.key] ?? '') as string; bv = (b[sort.key] ?? '') as string; }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [rows, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const arrow = (key: SortKey) =>
    sort.key === key ? (sort.dir === 'asc' ? <ArrowUp size={13} aria-hidden="true" /> : <ArrowDown size={13} aria-hidden="true" />) : null;

  const Th = ({ k, label, right }: { k: SortKey; label: string; right?: boolean }) => (
    <th style={{ textAlign: right ? 'right' : 'left', cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => toggleSort(k)}>
      <span className="row" style={{ gap: 4, alignItems: 'center', justifyContent: right ? 'flex-end' : 'flex-start' }}>{label} {arrow(k)}</span>
    </th>
  );

  return (
    <div className="col" style={{ gap: 18 }}>
      <header className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span className="section-label">Support</span>
          <h1 style={{ margin: 0 }}>Bookings</h1>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <Link className="btn btn-ghost btn-small" to="/internal/access">Pilot access</Link>
          <button className="btn btn-ghost btn-small" onClick={load}><RefreshCw size={16} aria-hidden="true" /> Refresh</button>
        </div>
      </header>

      {fallbacks.length > 0 && (
        <section className="card col" style={{ gap: 10, borderColor: 'var(--deep-apricot, #C8643D)' }} aria-label="Calls awaiting an admin">
          <h2 className="section-label" style={{ margin: 0, color: 'var(--deep-apricot, #C8643D)' }}>
            Calls awaiting an admin ({fallbacks.length})
          </h2>
          <ul className="access-mini-list" style={{ margin: 0 }}>
            {fallbacks.map((f) => (
              <li key={f.id} className="row between" style={{ gap: 8, alignItems: 'center' }}>
                <span>
                  <strong>{when(f.starts_at, 'Europe/London')}</strong> — {f.member_name ?? 'Member'} with {f.companion_name ?? 'Companion'}
                  {f.handled_by_admin_id ? <span className="text-secondary"> · accepted</span> : null}
                </span>
                {!f.handled_by_admin_id && (
                  <button className="btn btn-primary btn-small" onClick={() => onAccept(f.id)}>Accept call</button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" style={{ overflowX: 'auto' }}>
        {loading ? (
          <div className="row" style={{ justifyContent: 'center', padding: 24 }}><Loader2 size={20} aria-hidden="true" className="spin" /><span className="visually-hidden">Loading</span></div>
        ) : sorted.length === 0 ? (
          <p className="text-secondary" style={{ padding: 12 }}>No bookings yet.</p>
        ) : (
          <>
            <table className="access-table">
              <thead>
                <tr>
                  <Th k="member_name" label="Member" />
                  <Th k="companion_name" label="Companion" />
                  <Th k="kind" label="Kind" />
                  <Th k="starts_at" label="When" />
                  <th style={{ textAlign: 'right' }}>Mins</th>
                  <th>Method</th>
                  <Th k="status" label="Status" />
                  <Th k="price_minor" label="Price" right />
                  <th style={{ textAlign: 'right' }}>Platform fee</th>
                  <th style={{ textAlign: 'right' }}>Companion</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((b) => (
                  <tr key={b.id}>
                    <td>{b.member_name ?? '—'}</td>
                    <td>{b.companion_name ?? '—'}</td>
                    <td>
                      <span className="access-badge">{b.kind}</span>
                      {b.offer_type && b.offer_type !== 'trial' ? <span className="text-secondary" style={{ fontSize: '0.75rem' }}> · {pretty(b.offer_type)}</span> : null}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{when(b.starts_at, b.timezone)}</td>
                    <td style={{ textAlign: 'right' }}>{b.duration_minutes}</td>
                    <td>{pretty(b.communication_method)}</td>
                    <td><span className={`access-badge s-${b.status}`}>{pretty(b.status)}</span></td>
                    <td style={{ textAlign: 'right' }}>{money(b.price_minor, b.currency ?? currency)}</td>
                    <td style={{ textAlign: 'right' }}>{money(b.platform_fee_minor, b.currency ?? currency)}</td>
                    <td style={{ textAlign: 'right' }}>{money(b.companion_amount_minor, b.currency ?? currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-secondary" style={{ marginTop: 10 }}>{sorted.length} booking{sorted.length === 1 ? '' : 's'}</p>
          </>
        )}
      </section>
    </div>
  );
}
