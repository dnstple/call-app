/**
 * In-app invite prompt shown on the home screen. For COMPANIONS this is the
 * headline growth prompt: invite the members/coordinators you know, and earn from
 * the conversations you have with the people you recruit (no cash bounty — the
 * reward is the ongoing paid calls). For members/coordinators it's a simple
 * "introduce someone you know" prompt. Pulls the REAL referral code from
 * my_referral_code() (0118); hidden entirely for accounts not eligible to invite.
 */
import { useEffect, useState } from 'react';
import { UserPlus, Check } from 'lucide-react';
import { appUrl } from '../auth/redirects';
import { myReferral } from '../repositories/referralRepository';

export function ReferralProgrammeCard({ role }: { role?: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let live = true;
    myReferral()
      .then((r) => { if (live) setCode(r.code); })
      .catch(() => { if (live) setCode(null); });  // not eligible → stay hidden
    return () => { live = false; };
  }, []);

  if (dismissed || !code) return null;

  const isCompanion = role === 'companion';
  const link = `${appUrl()}/join?ref=${encodeURIComponent(code)}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <section className="card section-tight col" style={{ gap: 10 }} aria-label="Invite people you know to Apricoti">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <h2 className="section-label" style={{ margin: 0 }}>
          {isCompanion ? 'Invite people you know — and earn' : 'Introduce someone to Apricoti'}
        </h2>
        <button className="btn btn-ghost btn-small" onClick={() => setDismissed(true)} aria-label="Dismiss this prompt">
          Dismiss
        </button>
      </div>
      {isCompanion ? (
        <p className="muted" style={{ margin: 0 }}>
          Know a member or coordinator who'd love a regular chat? Invite them with your personal link. When
          they join and book calls with you, <strong>you earn from every conversation you have together</strong> —
          it's the easiest way to fill your calendar with people you'll enjoy talking to.
        </p>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          Know someone who'd love friendly companionship on Apricoti? Share your personal link and help them get
          started — they begin with a free 30-minute trial call.
        </p>
      )}
      <p className="small" style={{ margin: 0 }}>
        Your invite code: <strong style={{ letterSpacing: 1 }}>{code}</strong>
      </p>
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-small" onClick={copy}>
          {copied ? <Check size={16} aria-hidden="true" /> : <UserPlus size={16} aria-hidden="true" />}
          {copied ? ' Link copied' : ' Copy my invite link'}
        </button>
        <a className="btn btn-secondary btn-small" href="/referrals">View my invites</a>
      </div>
      <p className="faint small" style={{ margin: 0 }}>
        Share your link with people you know — please don't send us anyone's personal details; they choose to
        join themselves. New users and households only; no self-referrals.
      </p>
    </section>
  );
}
