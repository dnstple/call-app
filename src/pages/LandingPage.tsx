import { Link } from 'react-router-dom';
import {
  CalendarHeart, Heart, MessageCircle, Phone, Shield, Sparkles,
  UserRound, Users, Video, CheckCircle2,
} from 'lucide-react';
import { APP_NAME } from '../config/branding';
import { isSupabaseMode } from '../config/dataMode';

/**
 * Public landing page (Block 12).
 *
 * The one page a signed-out visitor sees at the site root. It is deliberately
 * honest: there are no invented testimonials, user counts, outcome statistics,
 * certifications, response-time promises, review scores, or press logos. Every
 * claim describes how the product works, not results we cannot yet evidence.
 *
 * The page keeps the noindex,nofollow meta from index.html — it is a public
 * route, not a publicly *indexed* one, during the pilot.
 */
export default function LandingPage() {
  // The primary call to action starts account creation. In hosted mode that
  // begins with registration; in the local preview it opens the sign-up wizard.
  const startTo = isSupabaseMode() ? '/register' : '/signup';

  return (
    <div className="landing">
      {/* 1 — Header */}
      <header className="landing-header">
        <div className="landing-container landing-header-row">
          <Link to="/" className="landing-brand" aria-label={`${APP_NAME} home`}>
            <img src="/icon.svg" alt="" className="landing-brand-mark" />
            <span className="landing-brand-name">{APP_NAME}</span>
          </Link>
          <nav className="landing-header-actions" aria-label="Account">
            <Link to="/login" className="btn btn-ghost btn-small">Sign in</Link>
            <Link to={startTo} className="btn btn-primary btn-small">Get started</Link>
          </nav>
        </div>
      </header>

      {/* 2 — Hero */}
      <section className="landing-hero">
        <div className="landing-container landing-hero-inner">
          <p className="landing-eyebrow">Warm, arranged companionship by phone and video</p>
          <h1>Meaningful conversation, made easy to arrange.</h1>
          <p className="landing-lede">
            {APP_NAME} helps you set up regular, friendly conversations with a companion —
            for a parent, a loved one, or yourself. You choose who, how often, and for
            how long. We handle the scheduling, the reminders, and keeping it safe.
          </p>
          <div className="landing-cta-row">
            <Link to={startTo} className="btn btn-primary">Get started</Link>
            <Link to={startTo} className="btn btn-secondary">Become a Companion</Link>
          </div>
          <p className="landing-fineprint">Free to set up. You only pay for conversations you arrange.</p>
        </div>
      </section>

      {/* 3 — Trust strip */}
      <section className="landing-trust" aria-label="What guides us">
        <div className="landing-container landing-trust-row">
          <span className="landing-trust-item"><Shield size={18} aria-hidden="true" /> Safety-first by design</span>
          <span className="landing-trust-item"><Heart size={18} aria-hidden="true" /> Kind, unhurried conversation</span>
          <span className="landing-trust-item"><UserRound size={18} aria-hidden="true" /> Companions you choose yourself</span>
          <span className="landing-trust-item"><CheckCircle2 size={18} aria-hidden="true" /> Cancel or change any time</span>
        </div>
      </section>

      {/* 4 — How it works */}
      <section className="landing-section">
        <div className="landing-container">
          <div className="landing-section-head">
            <h2>How it works</h2>
            <p>Three simple steps from first visit to first conversation.</p>
          </div>
          <ol className="landing-steps">
            <li className="card">
              <span className="landing-step-num" aria-hidden="true">1</span>
              <h3>Browse companions</h3>
              <p>Read companion profiles and choose someone whose warmth and interests feel right.</p>
            </li>
            <li className="card">
              <span className="landing-step-num" aria-hidden="true">2</span>
              <h3>Arrange a conversation</h3>
              <p>Pick a time and length. Start with a trial, a one-off chat, or a regular routine.</p>
            </li>
            <li className="card">
              <span className="landing-step-num" aria-hidden="true">3</span>
              <h3>Connect by phone or video</h3>
              <p>Join with a simple link or a phone call. We send reminders so no one has to remember.</p>
            </li>
          </ol>
        </div>
      </section>

      {/* 5 — For families / Coordinators */}
      <section className="landing-section landing-section-muted">
        <div className="landing-container landing-split">
          <div className="landing-split-text">
            <span className="section-label">For families &amp; coordinators</span>
            <h2>Arrange conversations for someone you care about</h2>
            <p>
              Set everything up on their behalf — choose the companion, the schedule, and the
              format. Your loved one simply answers a call or clicks a link when it is time.
              You stay in control of the arrangement without having to be on every call.
            </p>
            <ul className="landing-ticks">
              <li><CheckCircle2 size={18} aria-hidden="true" /> Manage it all from one place</li>
              <li><CheckCircle2 size={18} aria-hidden="true" /> No app or account needed for them to join</li>
              <li><CheckCircle2 size={18} aria-hidden="true" /> Change or pause the routine whenever life shifts</li>
            </ul>
            <Link to={startTo} className="btn btn-primary">Arrange for someone else</Link>
          </div>
          <div className="landing-split-visual" aria-hidden="true">
            <Users size={40} />
            <CalendarHeart size={40} />
          </div>
        </div>
      </section>

      {/* 6 — For self */}
      <section className="landing-section">
        <div className="landing-container landing-split landing-split-reverse">
          <div className="landing-split-text">
            <span className="section-label">For yourself</span>
            <h2>Set up companionship for your own week</h2>
            <p>
              Prefer to arrange it yourself? Create your own account, choose a companion, and
              build a routine that fits around your life. It is your schedule and your choice —
              adjust it whenever you like.
            </p>
            <ul className="landing-ticks">
              <li><CheckCircle2 size={18} aria-hidden="true" /> A friendly, familiar voice each week</li>
              <li><CheckCircle2 size={18} aria-hidden="true" /> Phone or video, whatever suits you</li>
              <li><CheckCircle2 size={18} aria-hidden="true" /> Full control of times and frequency</li>
            </ul>
            <Link to={startTo} className="btn btn-primary">Arrange for myself</Link>
          </div>
          <div className="landing-split-visual" aria-hidden="true">
            <UserRound size={40} />
            <MessageCircle size={40} />
          </div>
        </div>
      </section>

      {/* 7 — Regular companionship */}
      <section className="landing-section landing-section-brand">
        <div className="landing-container landing-center">
          <Sparkles size={28} aria-hidden="true" className="landing-center-icon" />
          <h2>The value is in the routine</h2>
          <p className="landing-center-lede">
            A single call is lovely. A regular one becomes something to look forward to. {APP_NAME}
            is built around ongoing companionship — the same companion, a familiar rhythm, and a
            growing sense of connection over time.
          </p>
          <Link to={startTo} className="btn btn-primary">Set up a regular conversation</Link>
        </div>
      </section>

      {/* 8 — Trial */}
      <section className="landing-section">
        <div className="landing-container landing-split">
          <div className="landing-split-text">
            <span className="section-label">Start gently</span>
            <h2>Try a first conversation</h2>
            <p>
              Not sure where to begin? Start with a short trial conversation to see whether a
              companion feels like the right fit — before committing to a regular routine. If it
              is not right, you can simply choose someone else.
            </p>
            <Link to={startTo} className="btn btn-secondary">Start with a trial</Link>
          </div>
          <div className="landing-split-visual" aria-hidden="true">
            <Phone size={40} />
            <Video size={40} />
          </div>
        </div>
      </section>

      {/* 9 — Safety */}
      <section className="landing-section landing-section-muted">
        <div className="landing-container">
          <div className="landing-section-head">
            <Shield size={28} aria-hidden="true" className="landing-center-icon" />
            <h2>Built to feel safe</h2>
            <p>Companionship should feel comfortable and secure for everyone involved.</p>
          </div>
          <div className="grid-cards landing-safety-grid">
            <div className="card">
              <h3>Companions are reviewed</h3>
              <p>Companion profiles are checked and approved before they can appear to families and members.</p>
            </div>
            <div className="card">
              <h3>You stay in control</h3>
              <p>Report a concern or block someone at any time. You decide who you speak with and when.</p>
            </div>
            <div className="card">
              <h3>Private by default</h3>
              <p>Personal details are only shared where they are needed to arrange and hold a conversation.</p>
            </div>
          </div>
        </div>
      </section>

      {/* 10 — Become a Companion */}
      <section className="landing-section">
        <div className="landing-container landing-split landing-split-reverse">
          <div className="landing-split-text">
            <span className="section-label">Become a Companion</span>
            <h2>Share your time, on your terms</h2>
            <p>
              If you enjoy conversation and want to make a difference, you can offer your time as a
              companion. Set your own availability and the kinds of conversations you offer, and
              connect with people who value a warm, regular chat.
            </p>
            <ul className="landing-ticks">
              <li><CheckCircle2 size={18} aria-hidden="true" /> Choose your own hours</li>
              <li><CheckCircle2 size={18} aria-hidden="true" /> Offer trials, one-off chats, or regular routines</li>
              <li><CheckCircle2 size={18} aria-hidden="true" /> Get paid for the conversations you hold</li>
            </ul>
            <Link to={startTo} className="btn btn-primary">Apply to be a Companion</Link>
          </div>
          <div className="landing-split-visual" aria-hidden="true">
            <Heart size={40} />
            <Sparkles size={40} />
          </div>
        </div>
      </section>

      {/* 11 — FAQ */}
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
            <summary>Can I change or stop the arrangement?</summary>
            <p>Yes. You can adjust the schedule, pause it, or cancel at any time.</p>
          </details>
          <details className="landing-faq-item">
            <summary>How does payment work?</summary>
            <p>Setting up an account is free. You pay for the conversations you arrange, and you can see the price before you confirm anything.</p>
          </details>
        </div>
      </section>

      {/* 12 — Final CTA */}
      <section className="landing-section landing-final">
        <div className="landing-container landing-center">
          <h2>Ready to arrange a conversation?</h2>
          <p className="landing-center-lede">It takes a few minutes to set up, and you can change your mind at any point.</p>
          <div className="landing-cta-row landing-cta-center">
            <Link to={startTo} className="btn btn-primary">Get started</Link>
            <Link to="/login" className="btn btn-secondary">Sign in</Link>
          </div>
        </div>
      </section>

      {/* 13 — Footer */}
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
