import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Shield, Sparkles } from 'lucide-react';
import { APP_NAME } from '../config/branding';
import { isSupabaseMode } from '../config/dataMode';
import { landingCopy, landingImages, type LandingImageSlot } from '../content/landingContent';

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
            <p className="landing-eyebrow">{c.hero.eyebrow}</p>
            <h1>{c.hero.title}</h1>
            <h2 className="landing-hero-tagline">{c.hero.tagline}</h2>
            <p className="landing-lede">{c.hero.lede}</p>
            <div className="landing-cta-row">
              <Link to={startTo} className="btn btn-primary btn-large">Find a Companion</Link>
              <Link to={startTo} className="btn btn-secondary btn-large">Become a Companion</Link>
            </div>
            <p className="landing-fineprint">{c.hero.fineprint}</p>
          </div>
          <LandingImage slot={landingImages.hero} className="landing-hero-photo" />
        </div>
      </section>

      {/* Brand-line band */}
      <section className="landing-trust" aria-label="Our mission">
        <div className="landing-container landing-trust-row">
          <p className="landing-trust-tagline">{c.trust[0]}</p>
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

      {/* Become a Companion — image right */}
      <section className="landing-section">
        <div className="landing-container landing-split landing-split-reverse">
          <LandingImage slot={landingImages.companion} />
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
