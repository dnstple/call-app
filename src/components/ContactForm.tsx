/**
 * Shared in-app contact form. Posts straight to the database via
 * submit_contact_message (no email) — support reads it at /internal/contact.
 * Works for anyone (signed in or not). In local preview (mock mode) there's no
 * backend, so it points people at the email address instead of showing a form
 * that can't submit.
 */
import { useState, type FormEvent } from 'react';
import { isSupabaseMode } from '../config/dataMode';
import { submitContactMessage } from '../repositories/contactRepository';
import { SUPPORT_EMAIL } from '../content/landingContent';

export function ContactForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  if (!isSupabaseMode()) {
    return (
      <p className="landing-fineprint" style={{ margin: 0 }}>
        Prefer to write to us directly? Email{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    );
  }
  if (status === 'sent') {
    return (
      <div className="landing-contact-sent" role="status">
        Thanks — we’ve got your message and we’ll be in touch.
      </div>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (email.trim() === '') { setError('Please add your email so we can reply.'); return; }
    if (message.trim() === '') { setError('Please write a short message.'); return; }
    setStatus('sending'); setError(null);
    try {
      await submitContactMessage(name, email, message);
      setStatus('sent');
    } catch (err) {
      const m = String((err as { message?: string })?.message ?? '').toLowerCase();
      setError(m.includes('too_long')
        ? 'That message is a little long — please shorten it.'
        : 'We couldn’t send that just now. Please try again, or email us directly.');
      setStatus('idle');
    }
  }

  const sending = status === 'sending';
  return (
    <form className="landing-contact-form" onSubmit={onSubmit} noValidate>
      <div className="landing-field">
        <label htmlFor="cf-name">Your name <span className="landing-field-opt">(optional)</span></label>
        <input id="cf-name" className="landing-contact-input" autoComplete="name"
          value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
      </div>
      <div className="landing-field">
        <label htmlFor="cf-email">Your email</label>
        <input id="cf-email" className="landing-contact-input" type="email" required autoComplete="email"
          value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} />
      </div>
      <div className="landing-field">
        <label htmlFor="cf-message">Message</label>
        <textarea id="cf-message" className="landing-contact-input" rows={4} required
          value={message} onChange={(e) => setMessage(e.target.value)} maxLength={4000} />
      </div>
      <div aria-live="polite" className="landing-contact-feedback">
        {error && <p className="access-inline-error" role="alert" style={{ margin: 0 }}>{error}</p>}
      </div>
      <button type="submit" className="btn btn-primary btn-large" disabled={sending}>
        {sending ? 'Sending…' : 'Send message'}
      </button>
    </form>
  );
}
