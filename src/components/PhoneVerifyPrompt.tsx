/**
 * Persistent nudge asking a signed-in user to verify their UK mobile
 * (restructure Phase 6). Users are never blocked — they can use the app as
 * normal — but the prompt stays visible on every visit until the number is
 * verified.
 *
 * The verified state comes from the account row the auth bootstrap already
 * loaded (account.phone_verified), so this prompt makes NO network request of
 * its own.
 */
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';

export function PhoneVerifyPrompt() {
  const { account, status } = useAuth();

  // Only for a fully signed-in account whose number isn't verified yet.
  if (status !== 'authenticated' || !account || account.phone_verified) return null;

  return (
    <section
      className="card row between"
      style={{ gap: 12, alignItems: 'center', borderColor: 'var(--apricot, #F2A272)' }}
      aria-label="Verify your mobile"
    >
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <ShieldCheck size={20} aria-hidden="true" style={{ color: 'var(--deep-apricot, #C8643D)', flex: 'none' }} />
        <span style={{ fontSize: 14 }}>
          Please verify your UK mobile number — it keeps your account secure and lets us send essential call alerts.
        </span>
      </div>
      <Link className="btn btn-primary btn-small" to="/verify-phone" style={{ flex: 'none' }}>
        Verify now
      </Link>
    </section>
  );
}
