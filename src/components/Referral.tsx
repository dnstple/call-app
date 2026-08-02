/**
 * Referral UI — two small, self-contained cards.
 *  - RedeemInviteCard: shown to waitlisted accounts; applies an invite code to
 *    jump straight to pilot access. Prefills from a ?code= link.
 *  - InviteOthersCard: shown to pilot/full accounts; their code + a copyable
 *    invite link and a gentle count of how many have joined.
 * All authority is server-side (0118); these only reflect and call it.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Gift, Check, Copy, Loader2 } from 'lucide-react';
import { isSupabaseMode } from '../config/dataMode';
import { myReferral, redeemReferral, referralErrorMessage, type MyReferral } from '../repositories/referralRepository';

function inviteLink(code: string): string {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}#/pilot?code=${encodeURIComponent(code)}`;
}

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export function RedeemInviteCard({ onRedeemed }: { onRedeemed?: () => void }) {
  const [params] = useSearchParams();
  const [code, setCode] = useState((params.get('code') ?? '').toUpperCase());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!isSupabaseMode()) return null;

  async function apply() {
    if (busy || code.trim() === '') return;
    setBusy(true); setError(null);
    try {
      await redeemReferral(code.trim());
      setDone(true);
      onRedeemed?.();
    } catch (e) {
      setError(referralErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <section className="card access-status-card access-tone-good" aria-label="Invite applied">
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <Check size={20} aria-hidden="true" />
          <h2 style={{ margin: 0, fontSize: '1.05rem' }}>You’re in</h2>
        </div>
        <p className="text-secondary" style={{ margin: '8px 0 0' }}>
          Your invite worked and your pilot access is ready. Refreshing your Pilot Hub…
        </p>
      </section>
    );
  }

  return (
    <section className="card" aria-label="Have an invite code">
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <Gift size={18} aria-hidden="true" />
        <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Have an invite code?</h2>
      </div>
      <p className="text-secondary" style={{ margin: '8px 0 12px' }}>
        If someone on Apricoti invited you, enter their code to join the pilot now.
      </p>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <input
          aria-label="Invite code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === 'Enter') void apply(); }}
          placeholder="ABCD2345"
          maxLength={16}
          style={{ flex: '1 1 180px', letterSpacing: '0.08em', textTransform: 'uppercase' }}
        />
        <button className="btn btn-primary" disabled={busy || code.trim() === ''} onClick={() => void apply()}>
          {busy ? <Loader2 size={16} aria-hidden="true" /> : null} Apply code
        </button>
      </div>
      {error && <p className="access-inline-error" style={{ marginTop: 10 }} role="alert">{error}</p>}
    </section>
  );
}

export function InviteOthersCard() {
  const [ref, setRef] = useState<MyReferral | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'' | 'code' | 'link'>('');

  useEffect(() => {
    if (!isSupabaseMode()) return;
    let live = true;
    myReferral()
      .then((r) => live && setRef(r))
      .catch((e) => live && setError(referralErrorMessage(e)));
    return () => { live = false; };
  }, []);

  if (!isSupabaseMode()) return null;
  if (error) return null;      // eligibility errors just hide the card (only pilot/full see it)
  if (!ref) return null;

  const flash = (which: 'code' | 'link') => { setCopied(which); setTimeout(() => setCopied(''), 1800); };

  return (
    <section className="card" aria-label="Invite others">
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <Gift size={18} aria-hidden="true" />
        <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Invite someone you know</h2>
      </div>
      <p className="text-secondary" style={{ margin: '8px 0 12px' }}>
        Know someone who’d value good conversation? Share your code and they can join the pilot
        straight away. There’s never any obligation.
      </p>

      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span
          style={{
            fontFamily: 'var(--font-mono, monospace)', fontSize: '1.25rem', fontWeight: 700,
            letterSpacing: '0.12em', background: 'var(--color-brand-subtle)', color: 'var(--color-brand-strong)',
            padding: '8px 16px', borderRadius: 'var(--radius-m)',
          }}
        >{ref.code}</span>
        <button className="btn btn-secondary btn-small" onClick={() => void copy(ref.code).then((okc) => okc && flash('code'))}>
          {copied === 'code' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
          {copied === 'code' ? 'Copied' : 'Copy code'}
        </button>
        <button className="btn btn-ghost btn-small" onClick={() => void copy(inviteLink(ref.code)).then((okc) => okc && flash('link'))}>
          {copied === 'link' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
          {copied === 'link' ? 'Copied' : 'Copy invite link'}
        </button>
      </div>

      <p className="text-secondary" style={{ margin: '12px 0 0', fontSize: '0.9rem' }}>
        {ref.accepted > 0
          ? `${ref.accepted} ${ref.accepted === 1 ? 'person has' : 'people have'} joined so far · `
          : ''}
        {ref.remaining} {ref.remaining === 1 ? 'invite' : 'invites'} left.
      </p>
    </section>
  );
}
