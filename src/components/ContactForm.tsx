/**
 * Shared in-app contact form. Posts straight to the database via
 * submit_contact_message (no email) — support reads it at /internal/contact.
 * Works for anyone (signed in or not). In local preview (mock mode) there's no
 * backend, so it shows a short note instead.
 */
import { useState, type FormEvent } from 'react';
import { isSupabaseMode } from '../config/dataMode';
import { submitContactMessage } from '../repositories/contactRepository';

export function ContactForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  if (!isSupabaseMode()) {
    return <p className="landing-fineprint">The contact form is available on the live site.</p>;
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
    if (message.trim() === '') { setError('Please write a message.'); return; }
    setStatus('sending'); setError(null);
    try {
      await submitContactMessage(name, email, message);
      setStatus('sent');
    } catch (err) {
      const m = String((err as { message?: string })?.message ?? '').toLowerCase();
      setError(m.includes('too_long')
        ? 'That message is a little long — please shorten it.'
        : 'We couldn’t send that just now. Please try again.');
      setStatus('idle');
    }
  }

  return (
    <form className="landing-contact-form" onSubmit={onSubmit}>
      <div className="landing-contact-row">
        <input className="landing-contact-input" placeholder="Your name (optional)"
          value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        <input className="landing-contact-input" type="email" placeholder="Your email (optional)"
          value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} />
      </div>
      <textarea className="landing-contact-input" placeholder="How can we help?" rows={4}
        value={message} onChange={(e) => setMessage(e.target.value)} maxLength={4000} required />
      {error && <p className="access-inline-error" style={{ marginTop: 0 }}>{error}</p>}
      <button type="submit" className="btn btn-primary btn-large" disabled={status === 'sending'}>
        {status === 'sending' ? 'Sending…' : 'Send message'}
      </button>
    </form>
  );
}
