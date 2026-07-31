import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Shield, Sparkles, Tag, UserRound, Video } from 'lucide-react';
import { APP_NAME } from '../config/branding';
import { isSupabaseMode } from '../config/dataMode';
import { publicLaunchMode, type LaunchMode } from '../repositories/accessRepository';
import { submitContactMessage } from '../repositories/contactRepository';
import { landingCopy, landingImages, type LandingImageSlot } from '../content/landingContent';

/**
 * The signed-out landing page adapts to the authoritative launch mode
 * (public.public_launch_mode). During the companion_waitlist launch the primary
 * action is "Apply to become a Companion" and Member/Coordinator access is shown
 * as invitation-only — public booking is never implied. Invited sign-up links
 * keep working throughout. index.html's noindex,nofollow is preserved.
 */
function useLaunchMode(): LaunchMode {
  // Local preview (mock mode) has no pilot — show the open experience.
  const [mode, setMode] = useState<LaunchMode>(isSupabaseMode() ? 'companion_waitlist' : 'public');
  useEffect(() => {
    if (!isSupabaseMode()) return;
    let live = true;
    publicLaunchMode().then((m) => live && m && setMode(m)).catch(() => {});
    return () => { live = false; };
  }, []);
  return mode;
}

/**
 * Public landing page (Block 12 + closeout Sections 9–10).
 *
 * Copy is sourced from the approved product-scope document via
 * src/content/landingContent.ts (vision, per-audience value propositions, the
 * £5 trial, and the safety framing). Terminology (Member/Companion/Coordinator)
 * is preserved; no testimonials, statistics, ratings, certifications or press
 * are invented. Photography lives in replaceable image slots — set a slot's
 * `src` in landingContent.ts to drop in real art; until then a neutral
 * photo-frame placeholder renders (never developer text in the public UI).
 *
 * The page keeps index.html's noindex,nofollow during the controlled pilot.
 */

/** One replaceable image area. Real art → set slot.src in landingContent.ts. */
function LandingImage({ slot, className }: { slot: LandingImageSlot; className?: string }) {
  const style = {
    aspectRatio: slot.aspectRatio,
    ['--landing-object-position' as string]: slot.objectPosition,
  } as CSSProperties;
  if (slot.src) {
    return (
      <img
        src={slot.src}
        alt={slot.alt}
        loading="lazy"
        className={`landing-photo landing-photo-${slot.mobileTreatment} ${className ?? ''}`}
        style={style}
      />
    );
  }
  // Neutral placeholder: a calm gradient frame, labelled for assistive tech,
  // with an internal-only note that never shows to normal users.
  return (
    <div
      className={`landing-photo landing-photo-placeholder landing-tone-${slot.tone} ${className ?? ''}`}
      style={style}
      role="img"
      aria-label={slot.alt}
    >
      <Sparkles size={26} aria-hidden="true" />
      <span className="landing-photo-devnote" aria-hidden="true" data-dev-only>
        Image: {slot.alt}
      </span>
    </div>
  );
}

export default function LandingPage() {
  const c = landingCopy;
  // Account creation starts registration in hosted mode; the local preview
  // opens the sign-up wizard.
  const startTo = isSupabaseMode() ? '/register' : '/signup';
  // The homepage looks and behaves normally (all roles can sign up); the only
  // launch-mode effect is a single pilot flag shown while we're not fully public.
  const inPilot = useLaunchMode() !== 'public';

  return (
    <div className="landing">
      {/* Header */}
      <header className="landing-header">
        <div className="landing-container landing-header-row">
          <Link to="/" className="landing-brand" aria-label={`${APP_NAME} home`}>
            <img src="/icon.svg" alt="" className="landing-brand-mark" />
            <span className="landing-brand-name">{APP_NAME}</span>
          </Link>
          <nav className="landing-header-actions" aria-label="Account">
            <Link to="/login" className="btn btn-ghost">Sign in</Link>
            <Link to={startTo} className="btn btn-primary">Find a Companion</Link>
          </nav>
        </div>
      </header>

      {/* Hero — text + image, larger type and CTAs */}
      <section className="landing-hero">
        <div className="landing-container landing-hero-grid">
          <div className="landing-hero-text">
            <h1>{c.hero.title}</h1>
            <p className="landing-lede">{c.hero.lede}</p>

            {inPilot && (
              <div className="landing-launch-note" role="note">
                Apricoti is currently in a pilot. Please set up your profile while we roll out full
                access gradually.
              </div>
            )}

            <div className="landing-cta-row">
              <Link to={startTo} className="btn btn-primary btn-large">Find a Companion</Link>
              <Link to={startTo} className="btn btn-secondary btn-large">Become a Companion</Link>
            </div>
            <p className="landing-fineprint">{c.hero.fineprint}</p>
          </div>
          <LandingImage slot={landingImages.hero} className="landing-hero-photo" />
        </div>
      </section>

      {/* Feature / USP strip */}
      <section className="landing-trust" aria-label="What Apricoti offers">
        <div className="landing-container landing-trust-row">
          {c.trust.map((t, i) => (
            <span key={t} className="landing-trust-item">
              {[<Video key="v" size={18} aria-hidden="true" />, <UserRound key="u" size={18} aria-hidden="true" />,
                <Sparkles key="s" size={18} aria-hidden="true" />, <Tag key="t" size={18} aria-hidden="true" />][i]}
              {' '}{t}
            </span>
          ))}
        </div>
      </section>

      {/* For families / Coordinators — moved above How it works */}
      <section className="landing-section landing-section-muted">
        <div className="landing-container landing-split">
          <LandingImage slot={landingImages.coordinator} />
          <div className="landing-split-text">
            <span className="section-label">{c.coordinator.label}</span>
            <h2>{c.coordinator.title}</h2>
            <p>{c.coordinator.body}</p>
            <ul className="landing-ticks">
              {c.coordinator.ticks.map((t) => (
                <li key={t}><CheckCircle2 size={18} aria-hidden="true" /> {t}</li>
              ))}
            </ul>
            <Link to={startTo} className="btn btn-primary btn-large">{c.coordinator.cta}</Link>
          </div>
        </div>
      </section>

      {/* How it works — three steps, one row on desktop */}
      <section className="landing-section">
        <div className="landing-container">
          <div className="landing-section-head">
            <h2>How it works</h2>
            <p>From first visit to a regular conversation.</p>
          </div>
          <ol className="landing-steps landing-steps-3">
            <li className="card">
              <span className="landing-step-num" aria-hidden="true">1</span>
              <h3>Explore Companions</h3>
              <p>Browse profiles and consider interests, conversation style, availability, languages and price.</p>
            </li>
            <li className="card">
              <span className="landing-step-num" aria-hidden="true">2</span>
              <h3>Start with a trial</h3>
              <p>Book one paid video conversation at a time and see how the match feels.</p>
            </li>
            <li className="card">
              <span className="landing-step-num" aria-hidden="true">3</span>
              <h3>Make it regular</h3>
              <p>When both people are happy, arrange future conversations around their availability.</p>
            </li>
          </ol>
        </div>
      </section>

      {/* For self — image right */}
      <section className="landing-section">
        <div className="landing-container landing-split landing-split-reverse">
          <LandingImage slot={landingImages.self} />
          <div className="landing-split-text">
            <span className="section-label">{c.self.label}</span>
            <h2>{c.self.title}</h2>
            <p>{c.self.body}</p>
            <ul className="landing-ticks">
              {c.self.ticks.map((t) => (
                <li key={t}><CheckCircle2 size={18} aria-hidden="true" /> {t}</li>
              ))}
            </ul>
            <Link to={startTo} className="btn btn-primary btn-large">{c.self.cta}</Link>
          </div>
        </div>
      </section>

      {/* Regular companionship — full-width image band */}
      <section className="landing-section landing-section-brand">
        <div className="landing-container landing-center">
          <Sparkles size={28} aria-hidden="true" className="landing-center-icon" />
          <h2>{c.regular.title}</h2>
          <p className="landing-center-lede">{c.regular.body}</p>
          <LandingImage slot={landingImages.regular} className="landing-band-photo" />
          <Link to={startTo} className="btn btn-primary btn-large">{c.regular.cta}</Link>
        </div>
      </section>

      {/* Trial — image left */}
      <section className="landing-section">
        <div className="landing-container landing-split">
          <LandingImage slot={landingImages.trial} />
          <div className="landing-split-text">
            <span className="section-label">{c.trial.label}</span>
            <h2>{c.trial.title}</h2>
            <p>{c.trial.body}</p>
            <Link to={startTo} className="btn btn-secondary btn-large">{c.trial.cta}</Link>
          </div>
        </div>
      </section>

      {/* Safety */}
      <section className="landing-section landing-section-muted">
        <div className="landing-container">
          <div className="landing-section-head">
            <Shield size={28} aria-hidden="true" className="landing-center-icon" />
            <h2>{c.safety.title}</h2>
            <p>{c.safety.body}</p>
          </div>
          <div className="grid-cards landing-safety-grid">
            {c.safety.cards.map((card) => (
              <div key={card.title} className="card">
                <h3>{card.title}</h3>
                <p>{card.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Become a Companion — text only */}
      <section className="landing-section">
        <div className="landing-container">
          <div className="landing-split-text landing-solo-text">
            <span className="section-label">{c.companion.label}</span>
            <h2>{c.companion.title}</h2>
            <p>{c.companion.body}</p>
            <ul className="landing-ticks">
              {c.companion.ticks.map((t) => (
                <li key={t}><CheckCircle2 size={18} aria-hidden="true" /> {t}</li>
              ))}
            </ul>
            <Link to={startTo} className="btn btn-primary btn-large">{c.companion.cta}</Link>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="landing-section landing-section-muted">
        <div className="landing-container landing-faq">
          <div className="landing-section-head">
            <h2>Questions, answered</h2>
          </div>
          <details className="landing-faq-item">
            <summary>What is a Companion?</summary>
            <p>A Companion is someone who offers scheduled social conversations through Apricoti. They create a profile, set their availability and price, and talk with Members about everyday life and shared interests. They are not carers, therapists or medical professionals in this role.</p>
          </details>
          <details className="landing-faq-item">
            <summary>Who are the conversations for?</summary>
            <p>Apricoti is designed for adults who would enjoy more regular, friendly conversation. A Member can arrange conversations themselves, or a family member, friend or trusted person can help with permission.</p>
          </details>
          <details className="landing-faq-item">
            <summary>Can I arrange conversations for somebody else?</summary>
            <p>Yes. You can help create or manage a Member profile, explore Companions and arrange conversations for someone you care about. The Member should remain involved in the choice wherever possible.</p>
          </details>
          <details className="landing-faq-item">
            <summary>How does a trial conversation work?</summary>
            <p>Each Member can book one paid trial with each Companion. The length and price are shown before payment. A trial is a chance for both people to decide whether they would like to speak again.</p>
          </details>
          <details className="landing-faq-item">
            <summary>Are Companions carers or therapists?</summary>
            <p>No. Apricoti is for social companionship. Companions do not provide personal care, therapy, counselling, medical advice or emergency support.</p>
          </details>
          <details className="landing-faq-item">
            <summary>How do payments work?</summary>
            <p>The Companion’s price and any Apricoti service fee are shown before payment. Payments are taken through the platform. Companion payouts are handled separately after the completion checks are satisfied.</p>
          </details>
        </div>
      </section>

      {/* Final CTA */}
      <section className="landing-section landing-final">
        <div className="landing-container landing-center">
          <h2>Start with one conversation.</h2>
          <p className="landing-center-lede">Explore Companions, choose who feels right, and arrange a friendly video conversation at a time that works. No pressure to continue — the first conversation is simply a chance to see how it feels.</p>
          <div className="landing-cta-row landing-cta-center">
            <Link to={startTo} className="btn btn-primary btn-large">Find a Companion</Link>
            <Link to={startTo} className="btn btn-secondary btn-large">Become a Companion</Link>
          </div>
        </div>
      </section>

      {/* Contact — opens the visitor's email client to our support address. */}
      <section id="contact" className="landing-section landing-section-muted">
        <div className="landing-container landing-center">
          <span className="section-label">Contact</span>
          <h2>Questions? Get in touch</h2>
          <p className="landing-center-lede">
            Have a question about {APP_NAME}, becoming a Companion, or arranging conversations for
            someone you care about? Send us a message and we’ll get back to you.
          </p>
          <ContactForm />
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="landing-container landing-footer-row">
          <div className="landing-brand">
            <img src="/icon.svg" alt="" className="landing-brand-mark" />
            <span className="landing-brand-name">{APP_NAME}</span>
          </div>
          <nav className="landing-footer-links" aria-label="Footer">
            <Link to={startTo}>Find a Companion</Link>
            <Link to={startTo}>Become a Companion</Link>
            <a href="#contact">Contact</a>
            <Link to="/login">Sign in</Link>
          </nav>
          <p className="landing-footer-note">
            Apricoti provides social companionship through scheduled conversations. It is not a
            healthcare, counselling, care or emergency service. © {new Date().getFullYear()} {APP_NAME}.
          </p>
        </div>
      </footer>
    </div>
  );
}

/**
 * In-app contact form. Sends the message straight to the database via
 * submit_contact_message (no email); support reads it in the app. Anyone can
 * send, signed in or not. In local preview (mock mode) there's no backend, so
 * we show a short note instead.
 */
function ContactForm() {
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
