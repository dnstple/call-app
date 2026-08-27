/**
 * Member/Coordinator home card showing call-credit balance, next expiry and a
 * book CTA. 1 credit = one 45-minute call. Credits expire 3 months after issue,
 * so we surface the next expiry (and a warning when something expires soon).
 * Hidden if the balance can't be read (e.g. no membership yet).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ticket, Clock } from 'lucide-react';
import { getCreditBalance, type CreditBalance } from '../repositories/creditsRepository';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '—';
  }
}

export function CreditsCard({ memberProfileId, memberFirstName }: { memberProfileId: string; memberFirstName?: string }) {
  const [c, setC] = useState<CreditBalance | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    getCreditBalance(memberProfileId)
      .then((r) => { if (live) { setC(r); setLoaded(true); } })
      .catch(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [memberProfileId]);

  if (!loaded || !c) return null;

  const who = memberFirstName ? `${memberFirstName}'s` : 'Your';
  const noneLeft = c.balance === 0;

  return (
    <section className="card section-tight col" style={{ gap: 10 }} aria-label="Call credits">
      <div className="row between" style={{ alignItems: 'center' }}>
        <h2 className="section-label" style={{ margin: 0 }}>{who} call credits</h2>
        <span className="row" style={{ gap: 6, alignItems: 'center', fontWeight: 700, fontSize: '1.15rem' }}>
          <Ticket size={18} aria-hidden="true" /> {c.balance}
        </span>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {noneLeft
          ? 'No credits left right now. Your membership adds more each week.'
          : `${c.balance} credit${c.balance === 1 ? '' : 's'} available — each books one 45-minute call.`}
      </p>
      {c.nextExpiry && !noneLeft && (
        <p className="small" style={{ margin: 0 }}>
          <Clock size={13} aria-hidden="true" /> Next credit expires <strong>{formatDate(c.nextExpiry)}</strong>. Credits last 3 months from when they're issued.
        </p>
      )}
      {c.expiringSoon > 0 && (
        <p className="small" style={{ margin: 0, color: 'var(--deep-apricot, #C8643D)' }}>
          {c.expiringSoon} credit{c.expiringSoon === 1 ? '' : 's'} expiring within 14 days — use {c.expiringSoon === 1 ? 'it' : 'them'} soon.
        </p>
      )}
      <div className="row wrap" style={{ gap: 8 }}>
        <Link className="btn btn-primary btn-small" to="/explore">Book a call</Link>
      </div>
    </section>
  );
}
