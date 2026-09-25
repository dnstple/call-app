/**
 * Public UGC recruitment landing (/ugc) — companions arrive here from the
 * broadcast link. Explains the paid video opportunity and links out to an
 * external form that collects the actual video (so we don't pay to store video
 * in Supabase). Set UGC_SUBMIT_URL to your Google Form / Tally / Drive request.
 */
import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Video, PoundSterling, TrendingUp, CheckCircle2 } from 'lucide-react';

// Where companions upload their video. Set this to your Dropbox File Request
// link (recommended — no account needed), a Tally form, or a Google Form.
// Can also be set without a code change via the VITE_UGC_SUBMIT_URL env var.
const UGC_SUBMIT_URL = (import.meta.env.VITE_UGC_SUBMIT_URL as string | undefined)?.trim()
  || 'https://www.dropbox.com/request/REPLACE_ME';

// True until a real destination is set, so we never show a broken link.
const SUBMIT_READY = /^https?:\/\//.test(UGC_SUBMIT_URL) && !/REPLACE_ME|your-ugc-form/.test(UGC_SUBMIT_URL);

export default function UgcLanding() {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px 64px' }}>
      <div className="col" style={{ gap: 8, textAlign: 'center', marginBottom: 24 }}>
        <span className="section-label" style={{ color: 'var(--deep-apricot, #C8643D)' }}>Apricoti creators</span>
        <h1 style={{ margin: 0, fontSize: '2rem' }}>Get paid to help spread the word</h1>
        <p className="muted" style={{ margin: '4px auto 0', maxWidth: 540, fontSize: '1.05rem' }}>
          We’re looking for companions to make short, honest videos about Apricoti. If we use your video,
          we’ll pay you <strong>£5</strong> — and our best creators get the chance to make more at a higher rate.
        </p>
      </div>

      <div className="row col" style={{ justifyContent: 'center', alignItems: 'center', marginBottom: 28, gap: 6 }}>
        <SubmitCta className="btn btn-primary btn-large" label="Submit your video" withIcon />
        {!SUBMIT_READY && <span className="muted small">Video uploads are opening very soon — check back shortly.</span>}
      </div>

      <section className="card col" style={{ gap: 16, marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: '1.15rem' }}>How it works</h2>
        <div className="col" style={{ gap: 12 }}>
          <Step icon={<Video size={18} aria-hidden="true" />} title="Record a short video"
            body="30–60 seconds on your phone is perfect. Talk about why you enjoy being an Apricoti companion, or what a call is like." />
          <Step icon={<CheckCircle2 size={18} aria-hidden="true" />} title="Submit it"
            body="Upload it through the link above — it only takes a minute." />
          <Step icon={<PoundSterling size={18} aria-hidden="true" />} title="Get paid £5 if we use it"
            body="If we post your video, we’ll pay you £5 as a thank you." />
          <Step icon={<TrendingUp size={18} aria-hidden="true" />} title="Do more, earn more"
            body="Creators whose videos perform well get the opportunity to make more videos at a higher rate." />
        </div>
      </section>

      <section className="card col" style={{ gap: 8, marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: '1.05rem' }}>A few tips</h2>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>Film in a bright, quiet spot — natural light is best.</li>
          <li>Hold the phone steady, upright (portrait) or landscape.</li>
          <li>Be yourself and speak naturally — authentic beats polished.</li>
          <li>Please don’t share any member’s details or anything private.</li>
        </ul>
      </section>

      <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
        <SubmitCta className="btn btn-primary" label="Submit your video" />
        <Link className="btn btn-ghost" to="/">Back to Apricoti</Link>
      </div>
    </div>
  );
}

function SubmitCta({ className, label, withIcon }: { className: string; label: string; withIcon?: boolean }) {
  if (!SUBMIT_READY) {
    return (
      <button type="button" className={className} disabled title="Video uploads are opening soon">
        {withIcon && <Video size={18} aria-hidden="true" />} {label}
      </button>
    );
  }
  return (
    <a className={className} href={UGC_SUBMIT_URL} target="_blank" rel="noopener noreferrer">
      {withIcon && <Video size={18} aria-hidden="true" />} {label}
    </a>
  );
}

function Step({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
      <span style={{ color: 'var(--deep-apricot, #C8643D)', flex: 'none', marginTop: 2 }}>{icon}</span>
      <div className="col" style={{ gap: 2 }}>
        <strong>{title}</strong>
        <span className="muted small">{body}</span>
      </div>
    </div>
  );
}
