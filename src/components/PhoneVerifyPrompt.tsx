/**
 * Dashboard prompt asking a signed-in user to verify their mobile (restructure
 * Phase 6). Existing users are never blocked — this is a dismissible nudge shown
 * only until their number is verified.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { getPhoneStatus } from '../repositories/phoneRepository';

export function PhoneVerifyPrompt() {
  const [show, setShow] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let live = true;
    getPhoneStatus().then((s) => { if (live) setShow(!s.verified); }).catch(() => {});
    return () => { live = false; };
  }, []);

  if (!show || dismissed) return null;

  return (
    <section className="card row between" style={{ gap: 12, alignItems: 'center', borderColor: 'var(--apricot, #F2A272)' }} aria-label="Verify your mobile">
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <ShieldCheck size={20} aria-hidden="true" style={{ color: 'var(--deep-apricot, #C8643D)', flex: 'none' }} />
        <span style={{ fontSize: 14 }}>
          Please verify your UK mobile number — it keeps your account secure and lets us send essential call alerts.
        </span>
      </div>
      <div className="row" style={{ gap: 8, flex: 'none' }}>
        <Link className="btn btn-primary btn-small" to="/verify-phone">Verify now</Link>
        <button className="btn btn-ghost btn-small" onClick={() => setDismissed(true)}>Not now</button>
      </div>
    </section>
  );
}
