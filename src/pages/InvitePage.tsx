/**
 * /invite — a referrer's personal invite link, share buttons, ready-made
 * messages, a printable flyer, the rules, and simple stats (0226).
 */
import { useEffect, useState } from 'react';
import { Check, Copy, Printer, MessageCircle, Mail, Share2 } from 'lucide-react';
import { appUrl } from '../auth/redirects';
import { useAccountRole } from '../state/managedMember';
import { useAuth } from '../auth/AuthProvider';
import { myReferral, myReferralStats, type ReferralStats } from '../repositories/referralRepository';
import { inviteLink } from '../referrals/refCapture';
import { INVITE_RULES, flyerHtml, inviteMessages } from '../referrals/inviteKit';

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn btn-secondary btn-small" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 2000); } catch { /* blocked */ }
    }}>
      {done ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />} {done ? 'Copied' : label}
    </button>
  );
}

export default function InvitePage() {
  const role = useAccountRole();
  const auth = useAuth();
  const owned = auth.profiles.find((p) => p.access.access_role === 'owner')?.profile as { first_name?: string | null } | undefined;
  const [code, setCode] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'not_eligible'>('loading');
  const [stats, setStats] = useState<ReferralStats | null>(null);

  useEffect(() => {
    let live = true;
    myReferral().then((r) => { if (live) { setCode(r.code); setState('ready'); } })
      .catch(() => { if (live) setState('not_eligible'); });
    myReferralStats().then((s) => { if (live) setStats(s); }).catch(() => { /* optional */ });
    return () => { live = false; };
  }, []);

  if (state === 'loading') return <p className="muted" style={{ padding: 24 }}>Loading your invite link…</p>;
  if (state === 'not_eligible' || !code) {
    return (
      <div className="col" style={{ gap: 12, maxWidth: 720 }}>
        <h1>Invite people you know</h1>
        <p className="muted">Invites open once your account is fully set up. If you think this is wrong, email info@apricoti.co.uk.</p>
      </div>
    );
  }

  const isCompanion = role === 'companion';
  const link = inviteLink(appUrl(), code);
  const messages = inviteMessages(link, isCompanion);
  const first = messages[0].text;
  const firstName = owned?.first_name ?? null;
  const printFlyer = () => {
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(flyerHtml(link, code, firstName));
    w.document.close();
  };
  const canShare = typeof navigator !== 'undefined' && 'share' in navigator;

  return (
    <div className="col" style={{ gap: 18, maxWidth: 760 }}>
      <header className="col" style={{ gap: 6 }}>
        <h1 style={{ margin: 0 }}>Invite people you know</h1>
        <p className="muted" style={{ margin: 0 }}>
          {isCompanion
            ? 'Know an older person who’d enjoy a regular chat, or someone who’d arrange it for a parent? Share your link. Their first call is free, they can book it with you, and you earn from the paid calls you go on to have together.'
            : 'Know someone who’d enjoy friendly conversation? Share your link. Their first call is free.'}
        </p>
      </header>

      <section className="card col" style={{ gap: 10 }} aria-label="Your invite link">
        <h2 className="section-label" style={{ margin: 0 }}>Your invite link</h2>
        <p style={{ margin: 0, wordBreak: 'break-all' }}><strong>{link}</strong></p>
        <p className="small muted" style={{ margin: 0 }}>Invite code: <strong style={{ letterSpacing: 1 }}>{code}</strong> (for people who type it in at sign-up)</p>
        <div className="row wrap" style={{ gap: 8 }}>
          <CopyButton text={link} label="Copy link" />
          <a className="btn btn-secondary btn-small" target="_blank" rel="noreferrer"
            href={`https://wa.me/?text=${encodeURIComponent(first)}`}>
            <MessageCircle size={16} aria-hidden="true" /> WhatsApp
          </a>
          <a className="btn btn-secondary btn-small"
            href={`mailto:?subject=${encodeURIComponent('A friendly chat with Apricoti')}&body=${encodeURIComponent(messages[messages.length - 1].text)}`}>
            <Mail size={16} aria-hidden="true" /> Email
          </a>
          <a className="btn btn-secondary btn-small" target="_blank" rel="noreferrer"
            href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(link)}`}>
            <Share2 size={16} aria-hidden="true" /> Facebook
          </a>
          {canShare && (
            <button type="button" className="btn btn-secondary btn-small"
              onClick={() => { void navigator.share({ title: 'Apricoti', text: first, url: link }).catch(() => {}); }}>
              <Share2 size={16} aria-hidden="true" /> More…
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-small" onClick={printFlyer}>
            <Printer size={16} aria-hidden="true" /> Print a flyer
          </button>
        </div>
      </section>

      {stats && (
        <section className="card row wrap" style={{ gap: 24 }} aria-label="Your invites so far">
          <div className="col"><strong style={{ fontSize: 24 }}>{stats.joined}</strong><span className="small muted">joined</span></div>
          <div className="col"><strong style={{ fontSize: 24 }}>{stats.booked}</strong><span className="small muted">booked a call</span></div>
          <div className="col"><strong style={{ fontSize: 24 }}>{stats.paying}</strong><span className="small muted">now paying</span></div>
        </section>
      )}

      <section className="col" style={{ gap: 10 }} aria-label="Ready-made messages">
        <h2 className="section-label" style={{ margin: 0 }}>Ready-made messages</h2>
        {messages.map((m) => (
          <div key={m.id} className="card col" style={{ gap: 8 }}>
            <strong>{m.title}</strong>
            <p className="muted" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{m.text}</p>
            <div><CopyButton text={m.text} label="Copy message" /></div>
          </div>
        ))}
      </section>

      <section className="card col" style={{ gap: 6 }} aria-label="Invite rules">
        <h2 className="section-label" style={{ margin: 0 }}>A few rules</h2>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {INVITE_RULES.map((r) => <li key={r} className="muted">{r}</li>)}
        </ul>
        <p className="small faint" style={{ margin: 0 }}>Full details: <a href="#/referral-terms">Referral programme terms</a>.</p>
      </section>
    </div>
  );
}
