/**
 * Contact messages inbox (/internal/contact) — support-admin only.
 *
 * Reads messages submitted from the landing contact form via the admin_* RPCs
 * (which re-check support-admin authority server-side). Support can mark a
 * message handled. No email is involved.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Mail } from 'lucide-react';
import {
  adminListContactMessages, adminMarkContactHandled, type ContactMessage,
} from '../repositories/contactRepository';

export default function InternalContact() {
  const [rows, setRows] = useState<ContactMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    adminListContactMessages(filter === 'open' ? false : null, 100, 0)
      .then((r) => { setRows(r.rows); setTotal(r.total); })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  async function toggle(m: ContactMessage) {
    setBusy(m.id);
    try { await adminMarkContactHandled(m.id, !m.handled); load(); }
    finally { setBusy(null); }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <header className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span className="section-label">Support</span>
          <h1 style={{ margin: 0 }}>Contact messages</h1>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <select className="input" value={filter} onChange={(e) => setFilter(e.target.value as 'open' | 'all')}>
            <option value="open">Unhandled</option>
            <option value="all">All</option>
          </select>
          <button className="btn btn-ghost btn-small" onClick={load}><RefreshCw size={16} aria-hidden="true" /> Refresh</button>
        </div>
      </header>

      {loading ? (
        <div className="row" style={{ justifyContent: 'center', padding: 32 }}>
          <Loader2 size={22} aria-hidden="true" /><span className="visually-hidden">Loading</span>
        </div>
      ) : rows.length === 0 ? (
        <div className="card access-support-row">
          <Mail size={18} aria-hidden="true" />
          <span>{filter === 'open' ? 'No unhandled messages — you’re all caught up.' : 'No messages yet.'}</span>
        </div>
      ) : (
        <div className="col" style={{ gap: 12 }}>
          <span className="text-secondary">{total} message{total === 1 ? '' : 's'}</span>
          {rows.map((m) => (
            <section key={m.id} className={`card${m.handled ? ' access-tone-good access-status-card' : ''}`}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <div>
                  <strong>{m.name || 'Someone'}</strong>{' '}
                  {m.email && <a href={`mailto:${m.email}`} className="text-secondary">{m.email}</a>}
                  {m.from_member && <span className="access-badge" style={{ marginLeft: 8 }}>signed-in</span>}
                  {m.handled && <span className="access-badge a-full" style={{ marginLeft: 8 }}>Handled</span>}
                </div>
                <span className="text-secondary" style={{ fontSize: '0.85rem' }}>
                  {new Date(m.created_at).toLocaleString()}
                </span>
              </div>
              <p style={{ margin: '8px 0 12px', whiteSpace: 'pre-wrap' }}>{m.message}</p>
              <button className="btn btn-ghost btn-small" disabled={busy === m.id} onClick={() => toggle(m)}>
                {m.handled ? 'Mark unhandled' : 'Mark handled'}
              </button>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
