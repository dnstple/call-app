import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Heart } from 'lucide-react';
import type { User } from '../types';
import { useAppState } from '../state/store';
import { isFavourite } from '../state/selectors';
import { toggleFavourite } from '../state/actions';
import { overallRating } from '../domain/ratings';
import { generateSlots, nextAvailableLabel } from '../domain/availability';
import { formatPence } from '../domain/commission';
import { ProfilePhoto, RatingStars, VerificationBadge } from './ui';
import { CardRatingSummary } from './CompanionReviews';
import { isSupabaseMode } from '../config/dataMode';
import { getMarketMeta } from '../repositories/profileRepository';
import { formatMinor } from '../repositories/availabilityRepository';
import {
  ensureFavouritesLoaded,
  toggleFavouriteSupabase,
  useSupabaseFavourites,
} from '../state/favourites';
import { useEffect } from 'react';

function FavButton({ user, className }: { user: User; className?: string }) {
  const state = useAppState();
  const supabase = isSupabaseMode();
  const supaFavs = useSupabaseFavourites();
  useEffect(() => {
    if (supabase) void ensureFavouritesLoaded();
  }, [supabase]);
  const fav = supabase ? supaFavs.ids.includes(user.id) : isFavourite(state, user.id);
  return (
    <button
      className={`icon-btn ${className ?? ''}`}
      aria-pressed={fav}
      aria-label={fav ? `Remove ${user.firstName} from favourites` : `Save ${user.firstName} to favourites`}
      onClick={(e) => {
        e.stopPropagation();
        if (supabase) void toggleFavouriteSupabase(user.id);
        else toggleFavourite(user.id);
      }}
    >
      <Heart
        size={20}
        aria-hidden="true"
        fill={fav ? 'var(--accent)' : 'none'}
        style={{ color: fav ? 'var(--accent)' : 'var(--text-primary)' }}
      />
    </button>
  );
}

/** Large photo (initials fallback) used at the top of marketplace cards. */
function CardPhoto({ user }: { user: User }) {
  const [failed, setFailed] = useState(false);
  if (!user.photoUrl || failed) {
    return (
      <div className="avatar-fallback" style={{ background: user.avatarColor }} aria-hidden="true">
        {user.firstName[0]}
        {user.lastName[0]}
      </div>
    );
  }
  return <img src={user.photoUrl} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

/** Marketplace profile card — photo-led, one primary action. */
export function ProfileCard({ user }: { user: User }) {
  const state = useAppState();
  const navigate = useNavigate();
  const rating = overallRating(state.ratings, user.id);
  const trial = state.offers.find((o) => o.companionId === user.id && o.kind === 'trial' && o.active);
  const slots =
    user.role === 'companion'
      ? generateSlots(state.availabilityRules, state.availabilityExceptions, state.bookings, user.id, 30, new Date(), 14)
      : [];
  const interests = user.interests.slice(0, 3);

  return (
    <article className="card profile-card">
      <div className="photo-wrap">
        <CardPhoto user={user} />
        <FavButton user={user} className="fav" />
      </div>
      <div className="body">
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <h3 style={{ margin: 0 }}>
            {user.firstName} <span className="muted" style={{ fontWeight: 500 }}>· {user.ageBand}</span>
          </h3>
          {isSupabaseMode() && user.role === 'companion' ? (
            <CardRatingSummary profileId={user.id} />
          ) : (
            <RatingStars average={rating.average} reviewerCount={rating.reviewerCount} compact />
          )}
        </div>
        <VerificationBadge state={user.verification} />
        <p className="muted" style={{ margin: 0 }}>{user.headline}</p>
        <p className="faint simple-hide" style={{ margin: 0 }}>
          Enjoys {interests.map((i) => i.toLowerCase()).join(', ')}
        </p>
        {user.role === 'companion' && !isSupabaseMode() && (
          <p className="small" style={{ margin: 0 }}>
            {trial && (
              <>
                <strong>Trial {formatPence(trial.pricePence)}</strong>
                <span className="muted"> · </span>
              </>
            )}
            <span className="muted">{nextAvailableLabel(slots, new Date())}</span>
          </p>
        )}
        {user.role === 'companion' && isSupabaseMode() && (() => {
          const meta = getMarketMeta(user.id);
          if (!meta) return null;
          return (
            <p className="small" style={{ margin: 0 }}>
              {meta.trialPriceMinor !== null && (
                <>
                  <strong>Trial {formatMinor(meta.trialPriceMinor)}</strong>
                  {meta.minSinglePriceMinor !== null && <span className="muted"> · </span>}
                </>
              )}
              {meta.minSinglePriceMinor !== null && (
                <span className="muted">from {formatMinor(meta.minSinglePriceMinor)}</span>
              )}
              {meta.acceptingNewMembers === false && (
                <span className="muted"> · not taking new members</span>
              )}
            </p>
          );
        })()}
        <div style={{ marginTop: 'auto', paddingTop: 8 }}>
          <button className="btn btn-secondary btn-small btn-block" onClick={() => navigate(`/people/${user.id}`)}>
            View profile
          </button>
        </div>
      </div>
    </article>
  );
}

/** Compact horizontal card for Home recommendations. */
export function ProfileCardCompact({ user, reason }: { user: User; reason?: string }) {
  const state = useAppState();
  const navigate = useNavigate();
  const rating = overallRating(state.ratings, user.id);

  return (
    <button
      className="card card-tight card-click row"
      style={{ width: 300, alignItems: 'flex-start', border: '1px solid var(--border)' }}
      onClick={() => navigate(`/people/${user.id}`)}
      aria-label={`View ${user.firstName}'s profile`}
    >
      <ProfilePhoto user={user} size={64} radius={14} />
      <span className="col grow" style={{ gap: 3, textAlign: 'left' }}>
        <span className="row between">
          <span className="bold">{user.firstName}</span>
          <RatingStars average={rating.average} reviewerCount={rating.reviewerCount} compact />
        </span>
        <span className="faint ellipsis" style={{ whiteSpace: 'normal' }}>{user.headline}</span>
        {reason && <span className="faint" style={{ color: 'var(--accent-strong)' }}>{reason}</span>}
      </span>
    </button>
  );
}
