/**
 * Mandatory phone-verification step in the Companion sign-up flow. Companions
 * must confirm a UK mobile before continuing (numbers are core to how the app
 * runs calls and cover). Reuses the phone OTP repository; on success it refreshes
 * the account so the rest of the app sees the verified number.
 */
import { useState } from 'react';
import { Loader2, Check } from 'lucide-react';
import { toUkE164, sendPhoneOtp, verifyPhoneOtp } from '../repositories/phoneRepository';
import { useAuth } from '../auth/AuthProvider';

export function CompanionVerifyStep({ verified, onVerified }: { verified: boolean; onVerified: () => void }) {
  const { refreshAccount } = useAuth();
  const [input, setInput] = useState('');
  const [e164, setE164] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (verified) {
    return (
      <div className="signup-step">
        <h2>Your mobile is verified</h2>
        <div className="card col" style={{ gap: 10, alignItems: 'center', textAlign: 'center', padding: '20px' }}>
          <Check size={30} aria-hidden="true" style={{ color: 'var(--deep-apricot, #C8643D)' }} />
          <strong>You’re all set — continue to the next step.</strong>
        </div>
      </div>
    );
  }

  const send = async () => {
    const normalised = toUkE164(input);
    if (!normalised) { setErr('Please enter a valid UK mobile number (e.g. 07700 900000).'); return; }
    setBusy(true); setErr(null); setMsg(null);
    const r = await sendPhoneOtp(normalised);
    setBusy(false);
    setE164(normalised);
    setCodeSent(true);
    if (r.ok) setMsg(`We’ve sent a code to ${normalised}. Enter it below.`);
    else setErr(r.error ?? 'If the code doesn’t arrive shortly, press “Resend code”.');
  };

  const verify = async () => {
    if (code.trim().length < 4) { setErr('Enter the code from the text message.'); return; }
    setBusy(true); setErr(null);
    const r = await verifyPhoneOtp(e164, code);
    setBusy(false);
    if (r.ok) { void refreshAccount(); onVerified(); return; }
    setErr(r.error ?? 'That code wasn’t right — check it, or press “Resend code”.');
  };

  return (
    <div className="signup-step">
      <h2>Verify your mobile</h2>
      <p className="muted">
        Companions confirm a UK mobile number before continuing — it keeps your account secure and lets us
        reach you about your calls.
      </p>

      {err && <p className="banner banner-danger" role="alert">{err}</p>}
      {msg && <p className="banner" role="status">{msg}</p>}

      <div className="card col" style={{ gap: 12 }}>
        <label className="col" style={{ gap: 4, fontSize: 14 }}>
          UK mobile number
          <input className="input" inputMode="tel" placeholder="07700 900000"
            value={input} disabled={busy || codeSent}
            onChange={(e) => setInput(e.target.value)} />
        </label>

        {!codeSent ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={send}>
            {busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : null} Send code
          </button>
        ) : (
          <>
            <label className="col" style={{ gap: 4, fontSize: 14 }}>
              Enter the code from the text
              <input className="input" inputMode="numeric" placeholder="123456"
                value={code} onChange={(e) => setCode(e.target.value)} />
            </label>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={verify}>
              {busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : null} Verify
            </button>
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={send}>Resend code</button>
              <button type="button" className="btn btn-ghost btn-small" disabled={busy}
                onClick={() => { setCodeSent(false); setCode(''); setErr(null); setMsg(null); }}>
                Use a different number
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
