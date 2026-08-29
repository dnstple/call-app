/**
 * Landing-page lead-capture popup for signed-out visitors. Appears once (per
 * session) after they scroll to the "For Members" section. Captures an email and
 * the account type they're interested in, so the team can personally reach out.
 * Submitting stores the lead via the capture_landing_lead RPC.
 */
import { useEffect, useRef, useState } from 'react';
import { X, CheckCircle2 } from 'lucide-react';
import { captureLandingLead, type LeadRole } from '../repositories/leadRepository';

const ROLES: { value: LeadRole; label: string; hint: string }[] = [
  { value: 'member', label: 'For myself (Member)', hint: 'I’d like to have conversations' },
  { value: 'coordinator', label: 'For a family member (Coordinator)', hint: 'I’m arranging this for someone else' },
  { value: 'companion', label: 'As a Companion', hint: 'I’d like to be someone people talk to' },
];

export function LeadCaptureModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<LeadRole>('member');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    if (!email.trim()) { setErr('Please enter your email address.'); return; }
    setBusy(true); setErr(null);
    const r = await captureLandingLead(email.trim(), role);
    setBusy(false);
    if (r.ok) setDone(true);
    else setErr(r.error ?? 'Something went wrong — please try again.');
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Stay in touch with Apricoti"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(32,28,25,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ maxWidth: 440, width: '100%', position: 'relative', padding: 24, borderRadius: 16 }}
      >
        <button
          aria-label="Close"
          onClick={onClose}
          className="btn btn-ghost btn-small"
          style={{ position: 'absolute', top: 10, right: 10, padding: 6 }}
        >
          <X size={18} aria-hidden="true" />
        </button>

        {done ? (
          <div className="col" style={{ gap: 12, alignItems: 'center', textAlign: 'center', padding: '8px 4px' }}>
            <CheckCircle2 size={32} aria-hidden="true" style={{ color: 'var(--deep-apricot, #C8643D)' }} />
            <h2 style={{ margin: 0, fontSize: '1.15rem' }}>Thank you — we’ll be in touch</h2>
            <p className="muted" style={{ margin: 0 }}>
              We’ll reach out personally to help you get started. No spam, and you can ignore us any time.
            </p>
            <button className="btn btn-primary" onClick={onClose} style={{ marginTop: 4 }}>Close</button>
          </div>
        ) : (
          <div className="col" style={{ gap: 14 }}>
            <div className="col" style={{ gap: 4 }}>
              <span className="section-label">Stay in touch</span>
              <h2 style={{ margin: 0, fontSize: '1.15rem' }}>Want us to reach out personally?</h2>
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>
                Leave your email and tell us what you’re interested in — a real person will get in touch to help you get started. No pressure, no spam.
              </p>
            </div>

            {err && <p className="banner banner-danger" role="alert" style={{ margin: 0 }}>{err}</p>}

            <label className="col" style={{ gap: 4, fontSize: 14 }}>
              Email address
              <input
                ref={emailRef}
                className="input"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                disabled={busy}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
              />
            </label>

            <label className="col" style={{ gap: 4, fontSize: 14 }}>
              I’m interested…
              <select
                className="input"
                value={role}
                disabled={busy}
                onChange={(e) => setRole(e.target.value as LeadRole)}
              >
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label} — {r.hint}</option>
                ))}
              </select>
            </label>

            <button className="btn btn-primary btn-large" disabled={busy} onClick={submit}>
              {busy ? 'Sending…' : 'Keep me posted'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
