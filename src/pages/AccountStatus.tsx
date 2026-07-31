/**
 * Account status page — shown when an account is blocked or suspended.
 *
 * Rendered WITHOUT the app shell/navigation (the account can't use product
 * features). Copy is user-facing only; the raw access/application enum is never
 * exposed. The account can sign out or reach support.
 */
import { ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { useAccess } from '../state/access';

export default function AccountStatus() {
  const auth = useAuth();
  const { access } = useAccess();
  const suspended = access?.applicationStatus === 'suspended';

  return (
    <div className="signup-shell">
      <main className="signup-main" style={{ maxWidth: 480 }}>
        <div className="col" style={{ gap: 14, alignItems: 'center', textAlign: 'center' }}>
          <ShieldAlert size={32} aria-hidden="true" />
          <h1 style={{ margin: 0 }}>Your account is on hold</h1>
          <p className="text-secondary" style={{ margin: 0 }}>
            {suspended
              ? 'Your account is currently paused. If you think this is a mistake, please contact our support team and we’ll help put it right.'
              : 'Access to Apricoti features isn’t available on your account right now. If you have questions, our support team is happy to help.'}
          </p>
          <div className="row" style={{ gap: 10, marginTop: 6 }}>
            <Link className="btn btn-primary" to="/contact">Contact support</Link>
            <button className="btn btn-ghost" onClick={() => void auth.signOut()}>Sign out</button>
          </div>
        </div>
      </main>
    </div>
  );
}
