/**
 * "Still have more questions?" capture, shown subtly at the start of the member
 * sign-up. Collects an email + mobile so the team can reach out, then lets the
 * person continue their sign-up. Non-blocking: they can close and carry on.
 */
import { useState } from 'react';
import { X, CheckCircle2, Loader2 } from 'lucide-react';
import { captureSignupLead } from '../repositories/leadRepository';

export function SignupHelpCapture({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (!email.trim()) { setErr('Please enter your email address.'); return; }
    setBusy(true); setErr(null);
    const r = await captureSignupLead(email.trim(), phone.trim(), 'member');
    setBusy(false);
    if (r.ok) setDone(true);
    else setErr(r.error ?? 'Something went wrong — please try again.');
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Still have questions?" onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(32,28,25,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} className="card"
        style={{ maxWidth: 420, width: '100%', position: 'relative', padding: 24, borderRadius: 16 }}>
        <button aria-label="Close" onClick={onClose}
          style={{ position: 'absolute', top: 12, right: 12, background: 'none', border: 'none', cursor: 'pointer' }}>
          <X size={20} aria-hidden="true" />
        </button>

        {done ? (
          <div className="col" style={{ gap: 12, alignItems: 'center', textAlign: 'center', padding: '8px 0' }}>
            <CheckCircle2 size={30} aria-hidden="true" style={{ color: 'var(--deep-apricot, #C8643D)' }} />
            <strong>Thank you — we’ll be in touch.</strong>
            <p className="muted small" style={{ margin: 0 }}>You can carry on and finish setting up your account now.</p>
            <button className="btn btn-primary" onClick={onClose}>Continue your sign up</button>
          </div>
        ) : (
          <div className="col" style={{ gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: '1.15rem' }}>Still have questions?</h2>
            <p className="muted small" style={{ margin: 0 }}>
              Leave your details and a member of the team will reach out. You can still continue your sign-up straight away.
            </p>
            {err && <p className="banner banner-danger" role="alert" style={{ margin: 0 }}>{err}</p>}
            <label className="col" style={{ gap: 4, fontSize: 13 }}>
              Email
              <input className="input" type="email" inputMode="email" value={email}
                onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            <label className="col" style={{ gap: 4, fontSize: 13 }}>
              Mobile number
              <input className="input" type="tel" inputMode="tel" value={phone}
                onChange={(e) => setPhone(e.target.value)} placeholder="07700 900000" />
            </label>
            <div className="row" style={{ gap: 8, marginTop: 4 }}>
              <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
                {busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : null} Submit
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Continue without submitting</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
