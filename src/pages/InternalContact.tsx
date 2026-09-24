/**
 * Contact messages inbox (/internal/contact) — support-admin only.
 *
 * Reads messages submitted from the landing contact form via the admin_* RPCs
 * (which re-check support-admin authority server-side). Support can mark a
 * message handled. No email is involved.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Mail, Reply } from 'lucide-react';
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
              <div className="row wrap" style={{ gap: 8 }}>
                {m.email && <ContactReply message={m} />}
                <button className="btn btn-ghost btn-small" disabled={busy === m.id} onClick={() => toggle(m)}>
                  {m.handled ? 'Mark unhandled' : 'Mark handled'}
                </button>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Reply by email — composes a message and opens it in your default mail app
// (Outlook), so the reply is sent from your own address and lands in your
// Outlook Sent items. No email is sent by the platform.
function ContactReply({ message }: { message: ContactMessage }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('Re: your message to Apricoti');
  const [body, setBody] = useState(
    `Hi ${message.name?.trim() || 'there'},\n\n\n\n— The Apricoti team\n\n` +
    `-----\nOn ${new Date(message.created_at).toLocaleString()} you wrote:\n${message.message}`,
  );
  const [copied, setCopied] = useState(false);

  const openInMail = () => {
    const href = `mailto:${encodeURIComponent(message.email ?? '')}`
      + `?subject=${encodeURIComponent(subject)}`
      + `&body=${encodeURIComponent(body)}`;
    window.location.href = href;
  };
  const copyBody = () => {
    navigator.clipboard?.writeText(body).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard unavailable */ });
  };

  if (!open) {
    return (
      <button className="btn btn-secondary btn-small" onClick={() => setOpen(true)}>
        <Reply size={14} aria-hidden="true" /> Reply by email
      </button>
    );
  }

  return (
    <div className="col" style={{ gap: 8, width: '100%', marginTop: 8, padding: 12, background: 'var(--surface-2, #FBF3EE)', borderRadius: 10 }}>
      <label className="col" style={{ gap: 4, fontSize: 13 }}>
        To
        <input className="input" value={message.email ?? ''} readOnly />
      </label>
      <label className="col" style={{ gap: 4, fontSize: 13 }}>
        Subject
        <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label className="col" style={{ gap: 4, fontSize: 13 }}>
        Message
        <textarea className="input" rows={7} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-small" onClick={openInMail}>
          <Mail size={14} aria-hidden="true" /> Open in your email app
        </button>
        <button className="btn btn-ghost btn-small" onClick={copyBody}>{copied ? 'Copied' : 'Copy message'}</button>
        <button className="btn btn-ghost btn-small" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <span className="muted small" style={{ margin: 0 }}>
        Opens a draft in your default mail app (Outlook). Send it there and it’ll appear in your Outlook Sent items.
      </span>
    </div>
  );
}
