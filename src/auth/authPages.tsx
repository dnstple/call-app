/**
 * Authentication screens — consumer-styled, part of the app, not admin forms.
 * All copy is plain language; no Supabase terminology or raw errors surface.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, Loader2, MailCheck } from 'lucide-react';
import { useAuth } from './AuthProvider';
import { AuthAppError } from './authErrors';
import { safeInternalPath } from './redirects';
import { isSupabaseConfigured } from '../supabase/client';
import { APP_NAME } from '../config/branding';

/* ---------------- Shared layout ---------------- */

function AuthLayout({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <div className="signup-shell">
      <header className="signup-header">
        <span className="bold brand-lockup"><img src="/icon.svg" alt="" className="brand-icon" />{APP_NAME}</span>
        <Link to="/login" className="btn btn-ghost btn-small">Sign in</Link>
      </header>
      <main className="signup-main" style={{ maxWidth: 480 }}>
        <div className="card card-feature col" style={{ gap: 4 }}>
          <h1 style={{ fontSize: '1.6em' }}>{title}</h1>
          {intro && <p className="muted">{intro}</p>}
          {children}
        </div>
      </main>
    </div>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  hint?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label htmlFor={id}>{label}</label>
      <div style={{ position: 'relative' }}>
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          style={{ paddingRight: 52 }}
          minLength={8}
        />
        <button
          type="button"
          className="icon-btn"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)' }}
        >
          {visible ? <EyeOff size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}
        </button>
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="banner banner-danger" role="alert">{message}</div>;
}

function useSubmit(action: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof AuthAppError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, submit, setError };
}

function NotConfigured() {
  return (
    <AuthLayout title="Supabase isn’t configured" intro="Copy .env.example to .env, add your project URL and anon key, then restart the dev server. Or switch back to mock mode in Settings → Prototype tools.">
      <Link to="/" className="btn btn-secondary">Back to the app</Link>
    </AuthLayout>
  );
}

/* ---------------- Login ---------------- */

export function LoginPage() {
  const { signIn, status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const intended = safeInternalPath((location.state as { from?: string } | null)?.from);
  const { busy, error, submit } = useSubmit(async () => {
    await signIn(email.trim(), password);
    navigate(intended, { replace: true });
  });

  useEffect(() => {
    if (status === 'authenticated') navigate(intended, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  if (!isSupabaseConfigured()) return <NotConfigured />;

  return (
    <AuthLayout title="Welcome back" intro="Sign in to continue.">
      <form onSubmit={submit} className="col" style={{ gap: 16 }}>
        <ErrorBanner message={error} />
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="login-email">Email</label>
          <input id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </div>
        <PasswordField id="login-password" label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
        <button className="btn btn-primary btn-block" disabled={busy || !email || !password}>
          {busy ? <Loader2 size={18} aria-hidden="true" /> : null} Sign in
        </button>
        <div className="row between wrap">
          <Link to="/forgot-password" className="btn btn-ghost btn-small">Forgot your password?</Link>
          <Link to="/register" className="btn btn-ghost btn-small">Create an account</Link>
        </div>
      </form>
    </AuthLayout>
  );
}

/* ---------------- Register ---------------- */

export function RegisterPage() {
  const { signUp } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const role = params.get('role') ?? '';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [agreed, setAgreed] = useState(false);
  const { busy, error, submit, setError } = useSubmit(async () => {
    if (password !== confirm) {
      setError('The passwords don’t match — please check both boxes.');
      return;
    }
    if (password.length < 8) {
      setError('Please choose a password of at least 8 characters.');
      return;
    }
    if (!agreed) {
      setError('Please agree to the community boundaries to continue.');
      return;
    }
    // Preserve the intended onboarding role locally (never the password).
    try {
      if (role) sessionStorage.setItem('companionship-intended-role', role);
    } catch { /* ignore */ }
    const { needsConfirmation } = await signUp(email.trim(), password);
    navigate(needsConfirmation ? `/verify-email?email=${encodeURIComponent(email.trim())}` : '/signup', {
      replace: true,
    });
  });

  if (!isSupabaseConfigured()) return <NotConfigured />;

  return (
    <AuthLayout
      title="Create your account"
      intro="A quick account first — then we’ll set up your profile together."
    >
      <form onSubmit={submit} className="col" style={{ gap: 16 }}>
        <ErrorBanner message={error} />
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="reg-email">Email</label>
          <input id="reg-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </div>
        <PasswordField id="reg-password" label="Password" value={password} onChange={setPassword} autoComplete="new-password" hint="At least 8 characters." />
        <PasswordField id="reg-confirm" label="Confirm password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        <label className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ width: 24, height: 24, flex: 'none' }} />
          <span className="small">
            I agree to keep conversations kind and respectful, and I understand this service offers
            companionship, not professional care. (Prototype terms.)
          </span>
        </label>
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? <Loader2 size={18} aria-hidden="true" /> : null} Create account
        </button>
        <Link to="/login" className="btn btn-ghost btn-small" style={{ alignSelf: 'center' }}>
          I already have an account
        </Link>
      </form>
    </AuthLayout>
  );
}

/* ---------------- Verify email ---------------- */

export function VerifyEmailPage() {
  const { resendConfirmation } = useAuth();
  const [params] = useSearchParams();
  const email = params.get('email') ?? '';
  const [resent, setResent] = useState(false);
  const { busy, error, submit } = useSubmit(async () => {
    if (email) await resendConfirmation(email);
    setResent(true);
  });

  return (
    <AuthLayout
      title="Check your email"
      intro={email ? `We’ve sent a confirmation link to ${email}.` : 'We’ve sent you a confirmation link.'}
    >
      <div className="col" style={{ gap: 16 }}>
        <div className="row" style={{ gap: 12 }}>
          <MailCheck size={28} aria-hidden="true" style={{ color: 'var(--color-brand-strong)', flex: 'none' }} />
          <p className="muted" style={{ margin: 0 }}>
            Click the link in the email to confirm your address, then come back and sign in.
            The link expires after a while — request a fresh one if it stops working.
          </p>
        </div>
        <ErrorBanner message={error} />
        {resent && <div className="banner banner-success">If that address is registered, a fresh link is on its way.</div>}
        <form onSubmit={submit}>
          <button className="btn btn-secondary btn-block" disabled={busy || !email}>
            {busy ? <Loader2 size={18} aria-hidden="true" /> : null} Resend the email
          </button>
        </form>
        <Link to="/register" className="btn btn-ghost btn-small" style={{ alignSelf: 'center' }}>
          Use a different email address
        </Link>
      </div>
    </AuthLayout>
  );
}

/* ---------------- Forgot password ---------------- */

export function ForgotPasswordPage() {
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, submit } = useSubmit(async () => {
    await requestPasswordReset(email.trim());
    setDone(true); // always neutral — no email enumeration
  });

  if (!isSupabaseConfigured()) return <NotConfigured />;

  return (
    <AuthLayout title="Reset your password" intro="Tell us your email and we’ll send reset instructions.">
      {done ? (
        <div className="col" style={{ gap: 16 }}>
          <div className="banner banner-success">
            If an account exists for that email address, we have sent password-reset instructions.
          </div>
          <Link to="/login" className="btn btn-secondary btn-block">Back to sign in</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="col" style={{ gap: 16 }}>
          <ErrorBanner message={error} />
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="fp-email">Email</label>
            <input id="fp-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </div>
          <button className="btn btn-primary btn-block" disabled={busy || !email}>
            {busy ? <Loader2 size={18} aria-hidden="true" /> : null} Send reset instructions
          </button>
        </form>
      )}
    </AuthLayout>
  );
}

/* ---------------- Reset password ---------------- */

export function ResetPasswordPage() {
  const { session, updatePassword, signOut } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, submit, setError } = useSubmit(async () => {
    if (password.length < 8) {
      setError('Please choose a password of at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('The passwords don’t match — please check both boxes.');
      return;
    }
    await updatePassword(password);
    setDone(true);
  });

  if (!isSupabaseConfigured()) return <NotConfigured />;

  // The recovery link signs the user into a temporary recovery session.
  if (!session && !done) {
    return (
      <AuthLayout title="This link isn’t valid any more" intro="Reset links expire after a short time or once they’ve been used.">
        <Link to="/forgot-password" className="btn btn-primary btn-block">Request a new link</Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password">
      {done ? (
        <div className="col" style={{ gap: 16 }}>
          <div className="banner banner-success">Your password has been updated.</div>
          <button className="btn btn-primary btn-block" onClick={() => navigate('/', { replace: true })}>
            Continue to the app
          </button>
          <button
            className="btn btn-ghost btn-small"
            onClick={async () => {
              await signOut();
              navigate('/login', { replace: true });
            }}
          >
            Sign out and sign in again
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="col" style={{ gap: 16 }}>
          <ErrorBanner message={error} />
          <PasswordField id="rp-password" label="New password" value={password} onChange={setPassword} autoComplete="new-password" hint="At least 8 characters." />
          <PasswordField id="rp-confirm" label="Confirm new password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? <Loader2 size={18} aria-hidden="true" /> : null} Update password
          </button>
        </form>
      )}
    </AuthLayout>
  );
}

/* ---------------- Auth callback ---------------- */

export function AuthCallbackPage() {
  const { status } = useAuth();
  const navigate = useNavigate();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    // The client's detectSessionInUrl handles the token exchange; we wait for
    // the provider to settle, then route to an approved internal destination.
    if (status === 'authenticated') navigate('/', { replace: true });
    if (status === 'unauthenticated') {
      const t = setTimeout(() => setTimedOut(true), 4000);
      return () => clearTimeout(t);
    }
  }, [status, navigate]);

  if (timedOut) {
    return (
      <AuthLayout title="That link didn’t work" intro="It may have expired or already been used.">
        <div className="col" style={{ gap: 12 }}>
          <Link to="/login" className="btn btn-primary btn-block">Go to sign in</Link>
          <Link to="/register" className="btn btn-ghost btn-small" style={{ alignSelf: 'center' }}>Create an account</Link>
        </div>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Just a moment…" intro="Confirming your details.">
      <div className="row" style={{ justifyContent: 'center', padding: 24 }}>
        <Loader2 size={28} aria-hidden="true" />
      </div>
    </AuthLayout>
  );
}
