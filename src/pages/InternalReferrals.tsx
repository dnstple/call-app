/** /internal/referrals — who is inviting people, and whether those people book and pay (0226). */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, RefreshCw } from 'lucide-react';
import { supportReferralOverview, type ReferralOverviewRow } from '../repositories/referralRepository';

export default function InternalReferrals() {
  const [rows, setRows] = useState<ReferralOverviewRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    setErr(null); setRows(null);
    supportReferralOverview().then(setRows).catch(() => setErr('Could not load referrals.'));
  }, []);
  useEffect(load, [load]);

  const totals = (rows ?? []).reduce((t, r) => ({ joined: t.joined + r.joined, booked: t.booked + r.booked, paying: t.paying + r.paying, calls: t.calls + r.paid_calls }),
    { joined: 0, booked: 0, paying: 0, calls: 0 });

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row between wrap" style={{ gap: 8 }}>
        <h1 style={{ margin: 0 }}>Referrals</h1>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-ghost btn-small" onClick={load}><RefreshCw size={16} aria-hidden="true" /> Refresh</button>
          <Link className="btn btn-ghost btn-small" to="/internal">Internal home</Link>
        </div>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        People who joined through someone’s invite link or code. “Paying” means at least one paid (non-trial) call.
        No bonus is paid automatically.
      </p>
      {err && <p className="banner banner-danger" role="alert">{err}</p>}
      {!rows && !err && <Loader2 size={20} className="spin" aria-label="Loading" />}
      {rows && (
        <>
          <div className="card row wrap" style={{ gap: 24 }}>
            <span><strong>{rows.length}</strong> referrers</span>
            <span><strong>{totals.joined}</strong> joined</span>
            <span><strong>{totals.booked}</strong> booked</span>
            <span><strong>{totals.paying}</strong> paying</span>
            <span><strong>{totals.calls}</strong> paid calls</span>
          </div>
          {rows.length === 0 ? <p className="muted">No one has joined through an invite yet.</p> : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ width: '100%' }}>
                <thead><tr><th align="left">Referrer</th><th align="left">Role</th><th align="left">Code</th><th>Joined</th><th>Booked</th><th>Paying</th><th>Paid calls</th><th align="left">Last joined</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.referrer_account_id}>
                      <td><Link to={`/internal/access/preview/${r.referrer_account_id}`}>{r.referrer_name || 'Unnamed'}</Link></td>
                      <td>{r.referrer_role ?? '—'}</td>
                      <td><code>{r.code}</code></td>
                      <td align="center">{r.joined}</td><td align="center">{r.booked}</td>
                      <td align="center">{r.paying}</td><td align="center">{r.paid_calls}</td>
                      <td>{r.last_joined_at ? new Date(r.last_joined_at).toLocaleDateString('en-GB') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
