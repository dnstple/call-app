/**
 * Block 11 (favourites visibility, privacy-safe slice).
 *
 * A quiet, encouraging note shown to a signed-in Companion telling them how
 * many people have saved (favourited) their profile. It shows a COUNT only —
 * the server never reveals who favourited them (migration 0099) — so there is
 * no privacy concern. If nobody has yet, or the count can't be loaded, the
 * note renders nothing rather than a discouraging zero.
 */
import { useEffect, useState } from 'react';
import { Heart } from 'lucide-react';
import { getMyFavouriteCount } from '../repositories/profileRepository';

export function CompanionFavouriteNote() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    getMyFavouriteCount()
      .then((n) => { if (live) setCount(n); })
      .catch(() => { if (live) setCount(0); });
    return () => { live = false; };
  }, []);

  if (!count || count < 1) return null;

  return (
    <div className="card card-tight row" style={{ gap: 12, alignItems: 'center' }}>
      <Heart size={20} aria-hidden="true" style={{ color: 'var(--color-brand-strong)', flexShrink: 0 }} fill="currentColor" />
      <p style={{ margin: 0 }}>
        <span className="bold">{count} {count === 1 ? 'person has' : 'people have'} saved your profile.</span>{' '}
        <span className="muted">They may reach out to arrange a conversation.</span>
      </p>
    </div>
  );
}
