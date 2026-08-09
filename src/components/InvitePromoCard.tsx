/**
 * In-app growth prompt: encourages an existing user to invite a coordinator or
 * a member to Apricoti. Client-only, no backend — copies a shareable link or
 * opens a pre-filled email. Dismissible for the session. This complements the
 * marketing email; it is not a replacement for it.
 */
import { useState } from 'react';
import { UserPlus, Check } from 'lucide-react';
import { appUrl } from '../auth/redirects';

export function InvitePromoCard() {
  const [copied, setCopied] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const link = appUrl();
  const shareText =
    `I've been using Apricoti for friendly companion calls — I thought of you. ` +
    `Whether you'd enjoy the calls yourself or could help arrange them for someone as a coordinator, ` +
    `you can join here: ${link}`;
  const mailto = `mailto:?subject=${encodeURIComponent('Join me on Apricoti')}&body=${encodeURIComponent(shareText)}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the email option still works */
    }
  };

  return (
    <section className="card section-tight col" style={{ gap: 10 }} aria-label="Invite someone to Apricoti">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <h2 className="section-label" style={{ margin: 0 }}>Spread the word</h2>
        <button className="btn btn-ghost btn-small" onClick={() => setDismissed(true)} aria-label="Dismiss this prompt">
          Dismiss
        </button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Know someone who’d love a friendly companion — or someone who could help arrange calls for a
        loved one as a coordinator? Invite them to Apricoti.
      </p>
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-small" onClick={copy}>
          {copied ? <Check size={16} aria-hidden="true" /> : <UserPlus size={16} aria-hidden="true" />}
          {copied ? ' Link copied' : ' Copy invite link'}
        </button>
        <a className="btn btn-secondary btn-small" href={mailto}>Share by email</a>
      </div>
    </section>
  );
}
