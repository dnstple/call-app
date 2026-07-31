/**
 * Public contact page (/contact) — reachable by anyone (anon, waitlisted,
 * blocked or full). Renders the shared in-app contact form; messages go to the
 * support inbox at /internal/contact. No email involved.
 */
import { Link } from 'react-router-dom';
import { APP_NAME } from '../config/branding';
import { ContactForm } from '../components/ContactForm';

export default function ContactPage() {
  return (
    <div className="signup-shell">
      <header className="signup-header">
        <Link to="/" className="bold brand-lockup" aria-label={`${APP_NAME} home`} style={{ textDecoration: 'none' }}>
          <img src="/icon.svg" alt="" className="brand-icon" />{APP_NAME}
        </Link>
        <Link to="/" className="btn btn-ghost btn-small">← Back</Link>
      </header>
      <main className="signup-main" style={{ maxWidth: 520 }}>
        <div className="card card-feature col" style={{ gap: 8 }}>
          <h1 style={{ fontSize: '1.6em' }}>Contact us</h1>
          <p className="muted">
            Have a question about {APP_NAME}? Send us a message and we’ll get back to you.
          </p>
          <ContactForm />
        </div>
      </main>
    </div>
  );
}
