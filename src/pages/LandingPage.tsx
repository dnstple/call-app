import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Heart, Shield, Sparkles, UserRound } from 'lucide-react';
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
            <Link to={startTo} className="btn btn-primary">Get started</Link>
          </nav>
        </div>
      </header>

      {/* Hero — text + image, larger type and CTAs */}
      <section className="landing-hero">
        <div className="landing-container landing-hero-grid">
          <div className="landing-hero-text">
            <p className="landing-eyebrow">{c.hero.eyebrow}</p>
            <h1>{c.hero.title}</h1>
            <p className="landing-lede">{c.hero.lede}</p>
            <div className="landing-cta-row">
              <Link to={startTo} className="btn btn-primary btn-large">Get started</Link>
              <Link to={startTo} className="btn btn-secondary btn-large">Become a Companion</Link>
            </div>
            <p className="landing-fineprint">{c.hero.fineprint}</p>
          </div>
          <LandingImage slot={landingImages.hero} className="landing-hero-photo" />
        </div>
      </section>

      {/* Trust strip */}
      <section className="landing-trust" aria-label="What guides us">
        <div className="landing-container landing-trust-row">
          {c.trust.map((t, i) => (
            <span key={t} className="landing-trust-item">
              {[<Shield key="s" size={18} aria-hidden="true" />, <Heart key="h" size={18} aria-hidden="true" />,
                <UserRound key="u" size={18} aria-hidden="true" />, <CheckCircle2 key="c" size={18} aria-hidden="true" />][i]}
              {' '}{t}
            </span>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="landing-section">
        <div className="landing-container">
          <div className="landing-section-head">
            <h2>How it works</h2>
            <p>Three simple steps from first visit to first conversation.</p>
          </div>
          <ol className="landing-steps">
            <li className="card">
              <span className="landing-step-num" aria-hidden="true">1</span>
              <h3>Browse Companions</h3>
              <p>Read Companion profiles and choose someone whose warmth and interests feel right.</p>
            </li>
            <li className="card">
              <span className="landing-step-num" aria-hidden="true">2</span>
              <h3>Arrange a conversation</h3>
              <p>Pick a time and length. Start with a trial, a single conversation, or a regular routine.</p>
            </li>
            <li className="card">
              <span className="landing-step-num" aria-hidden="true">3</span>
              <h3>Connect by phone or video</h3>
              <p>Join with a simple link or a phone call. We send reminders so no one has to remember.</p>
            </li>
          </ol>
        </div>
      </section>

      {/* For families / Coordinators — image left */}
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
            <summary>Who is {APP_NAME} for?</summary>
            <p>Anyone who would value regular, friendly conversation — arranged by a family member or coordinator, or by the person themselves.</p>
          </details>
          <details className="landing-faq-item">
            <summary>Does the person I arrange for need an account?</summary>
            <p>No. If you arrange conversations on someone else’s behalf, they can join with a simple link or a phone call — no app or account required.</p>
          </details>
          <details className="landing-faq-item">
            <summary>Phone or video?</summary>
            <p>Both. You can hold conversations by phone or by video, whichever is more comfortable.</p>
          </details>
          <details className="landing-faq-item">
            <summary>How does payment work?</summary>
            <p>Setting up an account is free. You pay for the conversations you arrange, and you can see the price before you confirm anything.</p>
          </details>
        </div>
      </section>

      {/* Final CTA */}
      <section className="landing-section landing-final">
        <div className="landing-container landing-center">
          <h2>Ready to arrange a conversation?</h2>
          <p className="landing-center-lede">It takes a few minutes to set up, and you can change your mind at any point.</p>
          <div className="landing-cta-row landing-cta-center">
            <Link to={startTo} className="btn btn-primary btn-large">Get started</Link>
            <Link to="/login" className="btn btn-secondary btn-large">Sign in</Link>
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
            <Link to={startTo}>Get started</Link>
            <Link to="/login">Sign in</Link>
          </nav>
          <p className="landing-footer-note">© {new Date().getFullYear()} {APP_NAME}. Warm companionship, arranged with care.</p>
        </div>
      </footer>
    </div>
  );
}
