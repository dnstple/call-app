import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Mail, Shield, Sparkles, Tag, UserRound, Video } from 'lucide-react';
import { APP_NAME } from '../config/branding';
import { isSupabaseMode } from '../config/dataMode';
import { publicLaunchMode, type LaunchMode } from '../repositories/accessRepository';
import { ContactForm } from '../components/ContactForm';
import { landingCopy, SUPPORT_EMAIL } from '../content/landingContent';

/**
 * The signed-out landing page adapts to the authoritative launch mode
 * (public.public_launch_mode). During the companion_waitlist launch the primary
 * action is "Apply to become a Companion" and Member/Coordinator access is shown
 * as invitation-only — public booking is never implied. Invited sign-up links
 * keep working throughout. The public homepage is indexable (index.html sets
 * robots index,follow) so it appears in search results.
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
 * The public homepage is indexable (index.html sets robots index,follow).
 */

/* The landing page uses the Apricoti brand illustrations (cropped from the
   product ad creatives) in public/: landing-hero.png and landing-companion.png. */

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
          <img src="/landing-hero.png" alt="A younger Companion and an older Member talking on the phone" loading="eager" className="landing-hero-photo landing-illus" />
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

      {/* For families / Coordinators — text only (image moved to the Companion section) */}
      <section className="landing-section landing-section-muted">
        <div className="landing-container">
          <div className="landing-split-text landing-solo-text landing-solo-center">
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

      {/* For self — text only (image removed) */}
      <section className="landing-section">
        <div className="landing-container">
          <div className="landing-split-text landing-solo-text landing-solo-center">
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
          <Link to={startTo} className="btn btn-primary btn-large">{c.regular.cta}</Link>
        </div>
      </section>

      {/* Trial — centred */}
      <section className="landing-section">
        <div className="landing-container landing-center">
          <span className="section-label">{c.trial.label}</span>
          <h2>{c.trial.title}</h2>
          <p className="landing-center-lede">{c.trial.body}</p>
          <Link to={startTo} className="btn btn-secondary btn-large">{c.trial.cta}</Link>
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

      {/* Become a Companion — centred split, image left on desktop / above on mobile */}
      <section className="landing-section">
        <div className="landing-container landing-split">
          <img src="/landing-companion.png" alt="A Companion smiling on the phone" loading="lazy" className="landing-illus" />
          <div className="landing-split-text">
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
            <p>A Companion is someone who offers scheduled social conversations through Apricoti. They create a profile, set their availability, and talk with Members about everyday life and shared interests. They are not carers, counsellors or medical professionals in this role.</p>
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
            <summary>Are Companions carers or medical professionals?</summary>
            <p>No. Apricoti is for social companionship. Companions do not provide personal care, counselling, medical advice or emergency support.</p>
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

      {/* Contact — the support email, prominently, plus the working message form. */}
      <section id="contact" className="landing-section landing-section-muted">
        <div className="landing-container landing-center">
          <span className="section-label">Contact</span>
          <h2>Questions? Get in touch</h2>
          <p className="landing-center-lede">
            Have a question about {APP_NAME}, becoming a Companion, or arranging conversations for
            someone you care about? Email us at{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and we’ll be happy to help.
          </p>
          <a href={`mailto:${SUPPORT_EMAIL}`} className="btn btn-secondary btn-large landing-email-btn">
            <Mail size={18} aria-hidden="true" /> {SUPPORT_EMAIL}
          </a>
          <ContactForm />
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="landing-container landing-footer-inner">
          <div className="landing-footer-top">
            <Link to="/" className="landing-brand" aria-label={`${APP_NAME} home`}>
              <img src="/icon.svg" alt="" className="landing-brand-mark" />
              <span className="landing-brand-name">{APP_NAME}</span>
            </Link>
            <nav className="landing-footer-links" aria-label="Footer">
              <Link to={startTo}>Find a Companion</Link>
              <Link to={startTo}>Become a Companion</Link>
              <a href="#contact">Contact</a>
              <Link to="/login">Sign in</Link>
              <Link to="/terms">Terms</Link>
              <Link to="/privacy">Privacy</Link>
              <Link to="/referral-terms">Referral terms</Link>
              <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
            </nav>
          </div>
          <p className="landing-footer-note">
            Apricoti provides social companionship through scheduled conversations. It is not a
            healthcare, counselling, care or emergency service.
          </p>
          <p className="landing-footer-copy">© {new Date().getFullYear()} {APP_NAME}</p>
        </div>
      </footer>
    </div>
  );
}
