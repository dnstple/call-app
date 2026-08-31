/**
 * Companion backup-cover response page (reached from the SMS link:
 * /#/cover?o=<offerId>&t=<token>). Shows only date/time/duration before
 * assignment, and lets the companion say "I'm available" or "Not available".
 * Standby (initial batch) → "on standby"; emergency batch → immediate confirm.
 */
import { useEffect, useState } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { Loader2, CalendarClock, CheckCircle2 } from 'lucide-react';
import { getBackupOffer, respondBackupOffer, type BackupOfferView } from '../repositories/coverRepository';

function fmtDate(iso?: string, tz?: string): string {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long',
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz ?? 'Europe/London',
    }).format(new Date(iso));
  } catch { return iso; }
}

export default function CoverResponse() {
  const loc = useLocation();
  const params = new URLSearchParams(loc.search || loc.hash.split('?')[1] || '');
  const offerId = params.get('o') ?? '';
  const token = params.get('t') ?? '';

  const [offer, setOffer] = useState<BackupOfferView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (!offerId || !token) { setLoading(false); return; }
    getBackupOffer(offerId, token).then((o) => { if (live) { setOffer(o); setLoading(false); } });
    return () => { live = false; };
  }, [offerId, token]);

  const respond = async (available: boolean) => {
    setBusy(true);
    const r = await respondBackupOffer(offerId, token, available);
    setBusy(false);
    setResult(r.state);
  };

  const shell = (children: React.ReactNode) => (
    <div className="col" style={{ maxWidth: 460, margin: '0 auto', gap: 16, padding: '24px 0' }}>
      <header className="col" style={{ gap: 4 }}>
        <span className="section-label">Apricoti — cover request</span>
      </header>
      {children}
      <p className="muted small" style={{ textAlign: 'center' }}>
        <Link to="/">Go to Apricoti</Link>
      </p>
    </div>
  );

  if (loading) return shell(<div className="row" style={{ justifyContent: 'center', padding: 24 }}><Loader2 size={22} aria-hidden="true" className="spin" /></div>);

  if (!offerId || !token) return shell(<div className="card"><p style={{ margin: 0 }}>This link is missing its details. Please open it directly from your text message.</p></div>);

  if (!offer || !offer.ok) {
    const msg = offer?.state === 'expired'
      ? 'This cover request has expired or the call is no longer open.'
      : offer?.state === 'forbidden'
        ? 'This link isn’t valid for this account.'
        : 'We couldn’t find this cover request. It may have been filled already.';
    return shell(<div className="card"><p style={{ margin: 0 }}>{msg}</p></div>);
  }

  // Post-response confirmations.
  if (result) {
    let title = 'Thanks';
    let body = '';
    if (result === 'available') { title = 'You’re on standby'; body = 'Thanks — you’re on standby for this call. We’ll let you know if you’re needed.'; }
    else if (result === 'selected') { title = 'You’re confirmed'; body = 'Thank you — you’re now confirmed for this call. You’ll find it in your conversations.'; }
    else if (result === 'declined') { title = 'No problem'; body = 'Thanks for letting us know — we won’t call on you for this one.'; }
    else if (result === 'already_taken' || result === 'no_longer_free') { title = 'Already covered'; body = 'Thanks — this call has already been covered by someone else.'; }
    else if (result === 'expired') { title = 'No longer needed'; body = 'This cover request has expired or the call is no longer open.'; }
    else { title = 'Thanks'; body = 'Your response has been recorded.'; }
    return shell(
      <div className="card col" style={{ gap: 12, alignItems: 'center', textAlign: 'center', padding: '24px 20px' }}>
        <CheckCircle2 size={30} aria-hidden="true" style={{ color: 'var(--deep-apricot, #C8643D)' }} />
        <strong style={{ fontSize: '1.1em' }}>{title}</strong>
        <p className="muted" style={{ margin: 0 }}>{body}</p>
      </div>,
    );
  }

  const emergency = offer.batch === 'emergency';
  return shell(
    <div className="card col" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <CalendarClock size={22} aria-hidden="true" style={{ color: 'var(--deep-apricot, #C8643D)' }} />
        <div>
          <strong>{emergency ? 'Cover needed for a call' : 'A call may need cover'}</strong>
          <div className="muted small">{offer.durationMinutes ?? 45}-minute conversation</div>
        </div>
      </div>
      <div className="banner" role="status" style={{ margin: 0 }}>{fmtDate(offer.startsAt, offer.timezone)}</div>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        {emergency
          ? 'If you can take this call, confirm below and it’s yours right away.'
          : 'Let us know if you could step in if the original companion doesn’t confirm. You’re not committed until we let you know you’re needed.'}
      </p>
      {!offer.isOpen ? (
        <p className="banner banner-danger" role="alert" style={{ margin: 0 }}>This call is no longer open for cover.</p>
      ) : (
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-primary btn-block" disabled={busy} onClick={() => respond(true)}>
            {busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : null} {emergency ? 'Yes, I’ll take it' : 'I’m available'}
          </button>
          <button className="btn btn-secondary btn-block" disabled={busy} onClick={() => respond(false)}>
            Not available
          </button>
        </div>
      )}
    </div>,
  );
}
