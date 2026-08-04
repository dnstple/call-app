import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, CalendarClock, ChevronDown, Compass, CreditCard, HeartHandshake, Leaf, Lock,
  Mail, Menu, Sparkles, Tag, UserRound, Video, X,
} from 'lucide-react';
import { APP_NAME } from '../config/branding';
import { isSupabaseMode } from '../config/dataMode';
import { publicLaunchMode, type LaunchMode } from '../repositories/accessRepository';
import { ContactForm } from '../components/ContactForm';
import { landingCopy, landingMeta, SUPPORT_EMAIL } from '../content/landingContent';

/**
 * Public homepage (signed-out). Typography-led, no photography: warm neutral
 * canvas, charcoal headings, apricot reserved for the logo, primary buttons and
 * small accents. The hero visual is a small, decorative, code-native product
 * composition (aria-hidden). All CTAs use the real application routes; index.html's
 * noindex,nofollow is preserved during the controlled pilot.
 */
function useLaunchMode(): LaunchMode {
  const [mode, setMode] = useState<LaunchMode>(isSupabaseMode() ? 'companion_waitlist' : 'public');
  useEffect(() => {
    if (!isSupabaseMode()) return;
    let live = true;
    publicLaunchMode().then((m) => live && m && setMode(m)).catch(() => {});
    return () => { live = false; };
  }, []);
  return mode;
}

/** Sets the document title + meta description for the public homepage. */
function usePageMeta() {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = landingMeta.title;
    let meta = document.querySelector('meta[name="description"]');
    const created = !meta;
    if (!meta) { meta = document.createElement('meta'); meta.setAttribute('name', 'description'); document.head.appendChild(meta); }
    const prevDesc = meta.getAttribute('content');
    meta.setAttribute('content', landingMeta.description);
    return () => {
      document.title = prevTitle;
      if (created) meta?.remove();
      else if (prevDesc !== null) meta?.setAttribute('content', prevDesc);
    };
  }, []);
}

/** Small, decorative product motif — interface cards, no people or fake data. */
function HeroVisual() {
  return (
    <div className="landing-hero-visual" aria-hidden="true">
      <div className="lv-card lv-interests">
        <span className="lv-eyebrow"><Sparkles size={14} /> Shared interests</span>
        <div className="lv-chips">
          <span className="lv-chip">Gardening</span>
          <span className="lv-chip">History</span>
          <span className="lv-chip">Music</span>
        </div>
      </div>
      <div className="lv-card lv-trial">
        <span className="lv-icon"><Video size={18} /></span>
        <div>
          <span className="lv-title">Trial conversation</span>
          <span className="lv-sub"><CalendarClock size={13} /> Thursday · 2:00 pm · 30 min</span>
        </div>
      </div>
      <div className="lv-card lv-availability">
        <span className="lv-eyebrow">Availability</span>
        <div className="lv-week">
          {['M', 'T', 'W', 'T', 'F'].map((d, i) => (
            <span key={i} className={`lv-day${i === 1 || i === 3 ? ' is-on' : ''}`}>{d}</span>
          ))}
        </div>
      </div>
      <div className="lv-card lv-privacy">
        <span className="lv-icon lv-icon-soft"><Lock size={16} /></span>
        <span className="lv-title">Private by default</span>
      </div>
    </div>
  );
}

const REASSURE_ICONS = [UserRound, CreditCard, Tag, Video];
const STEP_ICONS = [Compass, CalendarClock, HeartHandshake];
const PRINCIPLE_ICONS = [Sparkles, Leaf, Lock];

export default function LandingPage() {
  const c = landingCopy;
  const startTo = isSupabaseMode() ? '/register' : '/signup';
  const inPilot = useLaunchMode() !== 'public';
  const [menuOpen, setMenuOpen] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  usePageMeta();

  const navLinks = (
    <>
      <a href="#how-it-works" onClick={() => setMenuOpen(false)}>How it works</a>
      <a href="#safety" onClick={() => setMenuOpen(false)}>Safety</a>
      <a href="#companions" onClick={() => setMenuOpen(false)}>For Companions</a>
      <Link to="/login" onClick={() => setMenuOpen(false)}>Sign in</Link>
    </>
  );

  return (
    <div className="landing">
      {/* Header */}
      <header className="landing-header">
        <div className="landing-container landing-header-row">
          <Link to="/" className="landing-brand" aria-label={`${APP_NAME} home`}>
            <img src="/icon.svg" alt="" className="landing-brand-mark" />
            <span className="landing-brand-name">{APP_NAME}</span>
          </Link>

          <nav className="landing-nav" aria-label="Primary">{navLinks}</nav>

          <div className="landing-header-actions">
            <Link to="/login" className="btn btn-ghost landing-signin-desktop">Sign in</Link>
            <Link to={startTo} className="btn btn-primary">Find a Companion</Link>
            <button
              type="button"
              className="landing-menu-toggle"
              aria-expanded={menuOpen}
              aria-controls="landing-mobile-nav"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              onClick={() => setMenuOpen((o) => !o)}
            >
              {menuOpen ? <X size={22} /> : <Menu size={22} />}
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav id="landing-mobile-nav" className="landing-mobile-nav" aria-label="Menu">{navLinks}</nav>
        )}
      </header>

      <main>
        {/* Hero */}
        <section className="landing-hero">
          <div className="landing-container landing-hero-grid">
            <div className="landing-hero-text">
              <span className="landing-eyebrow">{c.hero.eyebrow}</span>
              <h1>{c.hero.title}</h1>
              <p className="landing-lede">{c.hero.lede}</p>
              <div className="landing-cta-row">
                <Link to={startTo} className="btn btn-primary btn-large">{c.hero.primary}</Link>
                <Link to={startTo} className="btn btn-secondary btn-large">{c.hero.secondary}</Link>
              </div>
              <p className="landing-fineprint">{c.hero.supporting}</p>
              {inPilot && (
                <p className="landing-pilot-chip">
                  <span className="landing-pilot-dot" aria-hidden="true" /> {c.hero.pilot}
                </p>
              )}
            </div>
            <HeroVisual />
          </div>
        </section>

        {/* Reassurance row */}
        <section className="landing-reassure" aria-label="What Apricoti offers">
          <div className="landing-container landing-reassure-row">
            {c.reassurance.map((t, i) => {
              const Icon = REASSURE_ICONS[i] ?? Sparkles;
              return (
                <span key={t} className="landing-reassure-item">
                  <Icon size={18} aria-hidden="true" /> {t}
                </span>
              );
            })}
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="landing-section">
          <div className="landing-container">
            <div className="landing-section-head">
              <h2>{c.how.title}</h2>
              <p>{c.how.lede}</p>
            </div>
            <ol className="landing-steps">
              {c.how.steps.map((s, i) => {
                const Icon = STEP_ICONS[i] ?? Compass;
                return (
                  <li key={s.title} className="landing-step">
                    <span className="landing-step-num" aria-hidden="true">{i + 1}</span>
                    <span className="landing-step-icon" aria-hidden="true"><Icon size={20} /></span>
                    <h3>{s.title}</h3>
                    <p>{s.body}</p>
                  </li>
                );
              })}
            </ol>
          </div>
        </section>

        {/* Two audience pathways */}
        <section className="landing-section landing-section-muted">
          <div className="landing-container">
            <div className="landing-section-head">
              <h2>{c.audiences.title}</h2>
            </div>
            <div className="landing-pathways">
              <div className="landing-panel">
                <h3>{c.audiences.members.title}</h3>
                <p>{c.audiences.members.body}</p>
                <Link to={startTo} className="landing-textlink">
                  {c.audiences.members.cta} <ArrowRight size={16} aria-hidden="true" />
                </Link>
              </div>
              <div className="landing-panel">
                <h3>{c.audiences.coordinators.title}</h3>
                <p>{c.audiences.coordinators.body}</p>
                <a href="#how-it-works" className="landing-textlink">
                  {c.audiences.coordinators.cta} <ArrowRight size={16} aria-hidden="true" />
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* What makes Apricoti different */}
        <section className="landing-section">
          <div className="landing-container">
            <div className="landing-section-head">
              <h2>{c.principles.title}</h2>
            </div>
            <div className="landing-principles">
              {c.principles.items.map((p, i) => {
                const Icon = PRINCIPLE_ICONS[i] ?? Sparkles;
                return (
                  <div key={p.title} className="landing-principle">
                    <span className="landing-principle-icon" aria-hidden="true"><Icon size={20} /></span>
                    <h3>{p.title}</h3>
                    <p>{p.body}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Safety and boundaries */}
        <section id="safety" className="landing-section landing-section-muted">
          <div className="landing-container landing-safety">
            <div className="landing-safety-text">
              <span className="landing-eyebrow">Safety</span>
              <h2>{c.safety.title}</h2>
              <p>{c.safety.body}</p>
            </div>
            <ul className="landing-safety-list">
              {c.safety.points.map((point) => (
                <li key={point}><HeartHandshake size={18} aria-hidden="true" /> {point}</li>
              ))}
            </ul>
          </div>
        </section>

        {/* Become a Companion */}
        <section id="companions" className="landing-section">
          <div className="landing-container landing-companion">
            <div className="landing-companion-text">
              <span className="landing-eyebrow">{c.companion.eyebrow}</span>
              <h2>{c.companion.title}</h2>
              <p>{c.companion.body}</p>
              <Link to={startTo} className="btn btn-primary btn-large">{c.companion.cta}</Link>
            </div>
            <ul className="landing-benefits">
              {c.companion.benefits.map((b) => (
                <li key={b}><Sparkles size={16} aria-hidden="true" /> {b}</li>
              ))}
            </ul>
          </div>
        </section>

        {/* FAQ */}
        <section className="landing-section landing-section-muted">
          <div className="landing-container landing-faq">
            <div className="landing-section-head">
              <h2>Questions, answered</h2>
            </div>
            <div className="landing-accordion">
              {c.faq.map((item, i) => {
                const open = openFaq === i;
                return (
                  <div key={item.q} className="landing-faq-item">
                    <h3 className="landing-faq-q">
                      <button
                        type="button"
                        className="landing-faq-btn"
                        aria-expanded={open}
                        aria-controls={`faq-panel-${i}`}
                        id={`faq-btn-${i}`}
                        onClick={() => setOpenFaq(open ? null : i)}
                      >
                        <span>{item.q}</span>
                        <ChevronDown size={18} aria-hidden="true" className={`landing-faq-chev${open ? ' is-open' : ''}`} />
                      </button>
                    </h3>
                    <div
                      id={`faq-panel-${i}`}
                      role="region"
                      aria-labelledby={`faq-btn-${i}`}
                      className="landing-faq-panel"
                      hidden={!open}
                    >
                      <p>{item.a}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Contact */}
        <section id="contact" className="landing-section">
          <div className="landing-container landing-contact">
            <div className="landing-section-head">
              <span className="landing-eyebrow">Contact</span>
              <h2>{c.contact.title}</h2>
              <p>{c.contact.body}</p>
              <a href={`mailto:${SUPPORT_EMAIL}`} className="btn btn-secondary btn-large landing-email-btn">
                <Mail size={18} aria-hidden="true" /> {SUPPORT_EMAIL}
              </a>
            </div>
            <ContactForm />
          </div>
        </section>
      </main>

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
              <a href="#how-it-works">How it works</a>
              <a href="#safety">Safety</a>
              <a href="#contact">FAQ</a>
              <Link to="/login">Sign in</Link>
              <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
            </nav>
          </div>
          <p className="landing-footer-note">{c.footer.boundary}</p>
          <p className="landing-footer-copy">© {new Date().getFullYear()} {APP_NAME}</p>
        </div>
      </footer>
    </div>
  );
}
