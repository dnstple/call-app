/**
 * Broadcast (/internal/broadcast) — support-admin only.
 *
 * Pick one or more role segments (members / companions / coordinators), choose a
 * channel (email or text), compose the message, and send. Opted-out people are
 * always excluded. Text reaches verified mobiles; email reaches everyone in the
 * segment with an address.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Mail, MessageSquare, Send, Eye } from 'lucide-react';
import { broadcast, type BroadcastResult } from '../repositories/broadcastRepository';

const SELF = '__self';
const SEGMENTS: { key: string; label: string }[] = [
  { key: 'member', label: 'Members' },
  { key: 'companion', label: 'Companions' },
  { key: 'coordinator', label: 'Coordinators' },
  { key: SELF, label: 'Just me (test)' },
];

const SMS_LIMIT = 480; // ~3 segments; keep texts short

export default function InternalBroadcast() {
  const [roles, setRoles] = useState<Set<string>>(new Set(['companion']));
  const [channel, setChannel] = useState<'email' | 'text'>('email');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BroadcastResult | null>(null);

  // Selecting "Just me (test)" is exclusive — it clears the real segments, and
  // picking a real segment clears the test option.
  const toggleRole = (k: string) =>
    setRoles((s) => {
      const n = new Set(s);
      if (n.has(k)) { n.delete(k); return n; }
      if (k === SELF) return new Set([SELF]);
      n.delete(SELF);
      n.add(k);
      return n;
    });

  const isSelf = roles.has(SELF);
  const roleList = () => Array.from(roles).filter((r) => r !== SELF);
  const hasContent = body.trim().length > 0 && (channel === 'text' || subject.trim().length > 0);
  const canSend = (isSelf || roleList().length > 0) && hasContent;

  const run = async (dryRun: boolean) => {
    if (!canSend) return;
    if (!dryRun) {
      const who = isSelf ? 'just you (test)' : SEGMENTS.filter((s) => roles.has(s.key)).map((s) => s.label).join(', ');
      if (!window.confirm(`Send this ${channel === 'email' ? 'email' : 'text'} to: ${who}?${isSelf ? '' : '\nOpted-out people are excluded.'}`)) return;
    }
    setBusy(true); setResult(null);
    try {
      setResult(await broadcast({ roles: roleList(), channel, subject, body, dryRun, selfTest: isSelf }));
    } finally { setBusy(false); }
  };

  return (
    <div className="col" style={{ gap: 18, maxWidth: 760 }}>
      <header className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span className="section-label">Support</span>
          <h1 style={{ margin: 0 }}>Broadcast</h1>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Link className="btn btn-ghost btn-small" to="/internal/outreach">Reach out</Link>
          <Link className="btn btn-ghost btn-small" to="/internal">Internal home</Link>
        </div>
      </header>

      <p className="muted small" style={{ margin: 0 }}>
        Send a one-off message to whole segments of your users. People who have opted out are always excluded.
        Text goes to verified mobiles only; email reaches everyone in the segment with an address.
      </p>

      <section className="card col" style={{ gap: 14 }}>
        <div className="col" style={{ gap: 6 }}>
          <strong style={{ fontSize: 14 }}>1. Who to send to</strong>
          <div className="row wrap" style={{ gap: 14 }}>
            {SEGMENTS.map((s) => (
              <label key={s.key} className="row" style={{ gap: 6, alignItems: 'center', fontSize: 14 }}>
                <input type="checkbox" checked={roles.has(s.key)} onChange={() => toggleRole(s.key)} />
                {s.label}
              </label>
            ))}
          </div>
        </div>

        <div className="col" style={{ gap: 6 }}>
          <strong style={{ fontSize: 14 }}>2. Channel</strong>
          <div className="row wrap" style={{ gap: 14 }}>
            <label className="row" style={{ gap: 6, alignItems: 'center', fontSize: 14 }}>
              <input type="radio" name="channel" checked={channel === 'email'} onChange={() => setChannel('email')} />
              <Mail size={14} aria-hidden="true" /> Email
            </label>
            <label className="row" style={{ gap: 6, alignItems: 'center', fontSize: 14 }}>
              <input type="radio" name="channel" checked={channel === 'text'} onChange={() => setChannel('text')} />
              <MessageSquare size={14} aria-hidden="true" /> Text
            </label>
          </div>
        </div>

        <div className="col" style={{ gap: 8 }}>
          <strong style={{ fontSize: 14 }}>3. Compose</strong>
          {channel === 'email' && (
            <label className="col" style={{ gap: 4, fontSize: 13 }}>
              Subject line
              <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. A paid opportunity for our companions" />
            </label>
          )}
          <label className="col" style={{ gap: 4, fontSize: 13 }}>
            {channel === 'email' ? 'Email body' : 'Text message'}
            <textarea
              className="input"
              rows={channel === 'email' ? 8 : 4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={channel === 'text' ? SMS_LIMIT : undefined}
              placeholder={channel === 'text'
                ? 'Keep it short. A link and “Reply STOP to opt out” is good practice.'
                : 'Write your message. Line breaks are preserved and links become clickable.'}
            />
            {channel === 'text' && <span className="muted small">{body.length}/{SMS_LIMIT} characters</span>}
          </label>
        </div>

        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn btn-secondary btn-small" disabled={busy || !canSend} onClick={() => void run(true)}>
            <Eye size={14} aria-hidden="true" /> Preview count
          </button>
          <button className="btn btn-primary btn-small" disabled={busy || !canSend} onClick={() => void run(false)}>
            {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />} Send
          </button>
        </div>

        {result && (
          <div className={`banner ${result.ok ? '' : 'banner-danger'}`} role="status" style={{ margin: 0 }}>
            {result.message}
            {result.errors && result.errors.length > 0 && (
              <ul className="access-mini-list" style={{ marginTop: 6 }}>
                {result.errors.map((e, i) => <li key={i} className="small">{e}</li>)}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
