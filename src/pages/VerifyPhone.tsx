/**
 * Verify your UK mobile. Single screen: enter number → send a code; the code box
 * then always appears so you can enter it and confirm. Uses Supabase Auth phone
 * OTP (Twilio) under the hood. Resilient to provider quirks — the code entry is
 * shown whenever a code has been requested, even if the send response was odd,
 * because the SMS may still have been delivered.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Check } from 'lucide-react';
import { toUkE164, sendPhoneOtp, verifyPhoneOtp } from '../repositories/phoneRepository';

export default function VerifyPhone() {
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [e164, setE164] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const send = async () => {
    const normalised = toUkE164(input);
    if (!normalised) { setErr('Please enter a valid UK mobile number (e.g. 07700 900000).'); return; }
    setBusy(true); setErr(null); setMsg(null);
    const r = await sendPhoneOtp(normalised);
    setBusy(false);
    setE164(normalised);
    setCodeSent(true);   // always reveal the code box — the text may have sent regardless
    if (r.ok) setMsg(`We’ve sent a code to ${normalised}. Enter it below.`);
    else setErr(r.error ?? 'If the code doesn’t arrive shortly, press “Resend code”.');
  };

  const verify = async () => {
    if (code.trim().length < 4) { setErr('Enter the code from the text message.'); return; }
    setBusy(true); setErr(null);
    const r = await verifyPhoneOtp(e164, code);
    setBusy(false);
    if (r.ok) { setDone(true); return; }
    setErr(r.error ?? 'That code wasn’t right — check it, or press “Resend code”.');
  };

  if (done) {
    return (
      <div className="col" style={{ maxWidth: 440, margin: '0 auto', gap: 16 }}>
        <div className="card col" style={{ gap: 12, alignItems: 'center', textAlign: 'center', padding: '28px 20px' }}>
          <Check size={32} aria-hidden="true" style={{ color: 'var(--deep-apricot, #C8643D)' }} />
          <strong style={{ fontSize: '1.1em' }}>Your number is verified</strong>
          <button className="btn btn-primary" onClick={() => navigate('/')}>Back to home</button>
        </div>
      </div>
    );
  }

  return (
    <div className="col" style={{ maxWidth: 440, margin: '0 auto', gap: 16 }}>
      <header className="col" style={{ gap: 4 }}>
        <span className="section-label">Account security</span>
        <h1 style={{ margin: 0 }}>Verify your mobile</h1>
        <p className="text-secondary" style={{ margin: 0 }}>
          We ask everyone to confirm a UK mobile number — it keeps accounts secure and lets us send essential call alerts.
        </p>
      </header>

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
          <button className="btn btn-primary" disabled={busy} onClick={send}>
            {busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : null} Send code
          </button>
        ) : (
          <>
            <label className="col" style={{ gap: 4, fontSize: 14 }}>
              Enter the code from the text
              <input className="input" inputMode="numeric" placeholder="123456"
                value={code} onChange={(e) => setCode(e.target.value)} />
            </label>
            <button className="btn btn-primary" disabled={busy} onClick={verify}>
              {busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : null} Verify
            </button>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-ghost btn-small" disabled={busy} onClick={send}>Resend code</button>
              <button className="btn btn-ghost btn-small" disabled={busy}
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
