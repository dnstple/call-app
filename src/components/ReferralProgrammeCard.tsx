/**
 * In-app counterpart to the referral invitation email — a short, restrained
 * prompt shown to eligible referrers (pilot/full accounts that hold a referral
 * code). Pulls the REAL referral code from my_referral_code() (0118); it never
 * fabricates a code. Hidden entirely for accounts that aren't eligible to invite.
 *
 * Note: reward MILESTONE tracking / payout is not yet automated (see report) —
 * the copy describes the pilot programme; rewards are validated before payout.
 */
import { useEffect, useState } from 'react';
import { UserPlus, Check } from 'lucide-react';
import { appUrl } from '../auth/redirects';
import { myReferral } from '../repositories/referralRepository';

export function ReferralProgrammeCard() {
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

  const link = `${appUrl()}/join?ref=${encodeURIComponent(code)}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <section className="card section-tight col" style={{ gap: 10 }} aria-label="Introduce a family to Apricoti">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <h2 className="section-label" style={{ margin: 0 }}>Introduce a family to Apricoti</h2>
        <button className="btn btn-ghost btn-small" onClick={() => setDismissed(true)} aria-label="Dismiss this prompt">
          Dismiss
        </button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Get <strong>£5 for a successful referral</strong>. Invite a Coordinator or Member you know — they
        start with a free 30-minute trial, and once their household completes four paid calls, you receive £5.
      </p>
      <p className="small" style={{ margin: 0 }}>
        Your referral code: <strong style={{ letterSpacing: 1 }}>{code}</strong>
      </p>
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-small" onClick={copy}>
          {copied ? <Check size={16} aria-hidden="true" /> : <UserPlus size={16} aria-hidden="true" />}
          {copied ? ' Link copied' : ' Copy my referral link'}
        </button>
        <a className="btn btn-secondary btn-small" href="/referrals">View my referrals</a>
      </div>
      <p className="faint small" style={{ margin: 0 }}>
        Terms: share your link — please don’t send us anyone’s personal details. The £5 is paid once the
        household completes four paid calls; trial, cancelled, refunded or disputed calls don’t count. New
        users and households only; no self-referrals. One reward per household. Pilot limited to the first 25 households.
      </p>
    </section>
  );
}
