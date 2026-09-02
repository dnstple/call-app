/**
 * Subscription cancellation flow (retention → credit offer → reason → Stripe).
 *
 * Steps:
 *   1. Retention — "meet another companion first?" links to recommended companions.
 *   2. Credit — if the member has no credits left, offer one free call; if they
 *      still have credits, remind them. Either way they can continue.
 *   3. Reason — a required reason + at least 50 characters of notes.
 *   4. Stripe — send them to the hosted billing portal to actually cancel.
 */
import { useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { HeartHandshake, Loader2, Sparkles, X } from 'lucide-react';
import {
  grantRetentionCredit, submitCancellationFeedback, openBillingPortal,
  type MyMembership,
} from '../repositories/membershipRepository';

const REASONS = [
  'Too expensive',
  'I’m not using it enough',
  'I didn’t find the right companion',
  'I got what I needed',
  'Technical problems',
  'Something else',
];

type Step = 'retention' | 'credit' | 'reason';

export function CancellationFlow({ membership, onClose }: { membership: MyMembership; onClose: () => void }) {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('retention');
  const [balance, setBalance] = useState<number>(membership.creditBalance ?? 0);
  const [granted, setGranted] = useState(false);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const claimFreeCredit = async () => {
    setBusy(true); setErr(null);
    const r = await grantRetentionCredit();
    setBusy(false);
    if (r.granted) { setGranted(true); setBalance(1); }
    else if (r.reason === 'has_credits') setBalance(r.balance ?? balance);
    else if (r.reason === 'already_granted') setErr('You’ve already had a free call from us before.');
    else setErr('We couldn’t add the free call just now.');
  };

  const toStripe = async () => {
    setBusy(true); setErr(null);
    const fb = await submitCancellationFeedback(reason, notes);
    if (!fb.ok) { setBusy(false); setErr(fb.error ?? 'Please check your answers.'); return; }
    const portal = await openBillingPortal(); // redirects on success
    if (!portal.ok) { setBusy(false); setErr(portal.error ?? 'We couldn’t open the billing page.'); }
  };

  const overlay: CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(32,28,25,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
  };
  const panel: CSSProperties = { maxWidth: 460, width: '100%', gap: 12, padding: 24, borderRadius: 16 };

  return (
    <div role="dialog" aria-modal="true" aria-label="Cancel subscription" style={overlay} onClick={onClose}>
      <div className="card col" style={panel} onClick={(e) => e.stopPropagation()}>
        <div className="row between" style={{ alignItems: 'center' }}>
          <span className="row" style={{ gap: 8, alignItems: 'center' }}>
            <HeartHandshake size={18} aria-hidden="true" />
            <strong>{step === 'retention' ? 'Sorry to see you go' : step === 'credit' ? 'Before you cancel' : 'One last thing'}</strong>
          </span>
          <button className="btn btn-ghost btn-small" aria-label="Close" onClick={onClose}><X size={16} aria-hidden="true" /></button>
        </div>

        {step === 'retention' && (
          <>
            <p style={{ margin: 0 }}>
              Are you sure you don’t want to meet another companion first? Sometimes the right person
              makes all the difference — we can suggest a few based on your interests.
            </p>
            <div className="col" style={{ gap: 8, marginTop: 6 }}>
              <button className="btn btn-primary btn-block" onClick={() => { onClose(); navigate('/recommended'); }}>
                <Sparkles size={16} aria-hidden="true" /> Show me recommended companions
              </button>
              <button className="btn btn-ghost btn-block" onClick={() => setStep('credit')}>
                No thanks, continue cancelling
              </button>
            </div>
          </>
        )}

        {step === 'credit' && (
          <>
            {granted ? (
              <>
                <p style={{ margin: 0 }}>
                  We’ve added <strong>one free call</strong> to your account — we’d love for you to use it.
                </p>
                <div className="col" style={{ gap: 8, marginTop: 6 }}>
                  <button className="btn btn-primary btn-block" onClick={onClose}>Great — I’ll stay</button>
                  <button className="btn btn-ghost btn-block" onClick={() => setStep('reason')}>Continue cancelling anyway</button>
                </div>
              </>
            ) : balance > 0 ? (
              <>
                <p style={{ margin: 0 }}>
                  You still have <strong>{balance} call {balance === 1 ? 'credit' : 'credits'}</strong> left —
                  that’s {balance === 1 ? 'a call' : 'calls'} already paid for and ready to use whenever you like.
                </p>
                <div className="col" style={{ gap: 8, marginTop: 6 }}>
                  <button className="btn btn-primary btn-block" onClick={onClose}>Use my credits</button>
                  <button className="btn btn-ghost btn-block" onClick={() => setStep('reason')}>Continue cancelling</button>
                </div>
              </>
            ) : (
              <>
                <p style={{ margin: 0 }}>
                  You’ve used all your credits. Before you go — here’s <strong>one free call on us</strong>,
                  no strings attached.
                </p>
                <div className="col" style={{ gap: 8, marginTop: 6 }}>
                  <button className="btn btn-primary btn-block" disabled={busy} onClick={() => void claimFreeCredit()}>
                    {busy ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />} Claim my free call
                  </button>
                  <button className="btn btn-ghost btn-block" onClick={() => setStep('reason')}>No thanks, continue</button>
                </div>
              </>
            )}
          </>
        )}

        {step === 'reason' && (
          <>
            <p style={{ margin: 0 }}>We’re sorry it wasn’t right. Please tell us why so we can improve.</p>
            <label className="col" style={{ gap: 4 }}>
              <span className="small bold">Reason</span>
              <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="">Choose a reason…</option>
                {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label className="col" style={{ gap: 4 }}>
              <span className="small bold">Tell us a little more</span>
              <textarea
                className="input" rows={4} value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="What led to this decision? (at least 50 characters)"
              />
              <span className="small muted">{notes.trim().length}/50 characters minimum</span>
            </label>
            <div className="col" style={{ gap: 8, marginTop: 6 }}>
              <button
                className="btn btn-danger btn-block"
                disabled={busy || !reason || notes.trim().length < 50}
                onClick={() => void toStripe()}
              >
                {busy ? <Loader2 size={15} className="spin" aria-hidden="true" /> : null} Continue to cancellation
              </button>
              <button className="btn btn-ghost btn-block" onClick={() => setStep('credit')}>Back</button>
            </div>
          </>
        )}

        {err && <p className="small" role="alert" style={{ margin: 0, color: 'var(--color-danger-text)' }}>{err}</p>}
      </div>
    </div>
  );
}
