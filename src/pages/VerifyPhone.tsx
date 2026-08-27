/**
 * Verify your UK mobile (restructure Phase 6). Two steps: enter number → send a
 * code; enter the code → verified. Uses Supabase Auth phone OTP under the hood.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Check } from 'lucide-react';
import { toUkE164, sendPhoneOtp, verifyPhoneOtp } from '../repositories/phoneRepository';

export default function VerifyPhone() {
  const navigate = useNavigate();
  const [step, setStep] = useState<'number' | 'code' | 'done'>('number');
  const [input, setInput] = useState('');
  const [e164, setE164] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const send = async () => {
    const normalised = toUkE164(input);
    if (!normalised) { setErr('Please enter a valid UK mobile number (e.g. 07700 900000).'); return; }
    setBusy(true); setErr(null);
    const r = await sendPhoneOtp(normalised);
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? 'Could not send the code.'); return; }
    setE164(normalised); setStep('code');
  };

  const verify = async () => {
    if (code.trim().length < 4) { setErr('Enter the code from the text message.'); return; }
    setBusy(true); setErr(null);
    const r = await verifyPhoneOtp(e164, code);
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? 'Could not verify the code.'); return; }
    setStep('done');
  };

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

      {step === 'number' && (
        <div className="card col" style={{ gap: 10 }}>
          <label className="col" style={{ gap: 4, fontSize: 14 }}>
            UK mobile number
            <input className="input" inputMode="tel" placeholder="07700 900000"
              value={input} onChange={(e) => setInput(e.target.value)} />
          </label>
          <button className="btn btn-primary" disabled={busy} onClick={send}>
            {busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : null} Send code
          </button>
        </div>
      )}

      {step === 'code' && (
        <div className="card col" style={{ gap: 10 }}>
          <p className="text-secondary" style={{ margin: 0 }}>We’ve sent a code to <strong>{e164}</strong>.</p>
          <label className="col" style={{ gap: 4, fontSize: 14 }}>
            Enter the code
            <input className="input" inputMode="numeric" placeholder="123456"
              value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <button className="btn btn-primary" disabled={busy} onClick={verify}>
            {busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : null} Verify
          </button>
          <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => { setStep('number'); setCode(''); }}>Use a different number</button>
        </div>
      )}

      {step === 'done' && (
        <div className="card col" style={{ gap: 12, alignItems: 'center', textAlign: 'center' }}>
          <Check size={32} aria-hidden="true" style={{ color: 'var(--deep-apricot, #C8643D)' }} />
          <strong>Your number is verified</strong>
          <button className="btn btn-primary" onClick={() => navigate('/')}>Back to home</button>
        </div>
      )}
    </div>
  );
}
