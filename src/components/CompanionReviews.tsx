/**
 * Stage 2E2B — public rating surfaces (Supabase mode).
 *
 * Real data only, through ratingRepository: unique-reviewer summaries and
 * paginated public reviews (reviewer first name + initial, score, comment,
 * date). Private feedback, account ids and booking details never reach
 * these components — the server doesn't send them.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Star } from 'lucide-react';
import {
  getPublicRatingSummary,
  getPublicReviews,
  type PublicReview,
  type RatingSummary,
} from '../repositories/ratingRepository';
import { RatingStars } from './ui';

const PAGE_SIZE = 5;

/* Small module-level cache so Explore grids don't refetch on re-render. */
const summaryCache = new Map<string, RatingSummary>();

/** Compact summary for cards: real stars, or “New” when unrated. */
export function CardRatingSummary({ profileId }: { profileId: string }) {
  const [summary, setSummary] = useState<RatingSummary | null>(summaryCache.get(profileId) ?? null);

  useEffect(() => {
    if (summaryCache.has(profileId)) {
      setSummary(summaryCache.get(profileId)!);
      return;
    }
    let live = true;
    getPublicRatingSummary(profileId)
      .then((s) => {
        summaryCache.set(profileId, s);
        if (live) setSummary(s);
      })
      .catch(() => undefined); // a card without a rating is fine
    return () => {
      live = false;
    };
  }, [profileId]);

  if (!summary) return null; // quiet while loading — never a fake “0.0”
  if (summary.reviewerCount === 0 || summary.average === null) {
    return <span className="faint">New</span>;
  }
  return <RatingStars average={summary.average} reviewerCount={summary.reviewerCount} compact />;
}

/** Full profile section: summary + paginated public reviews. */
export function CompanionReviews({ profileId, firstName }: { profileId: string; firstName: string }) {
  const [summary, setSummary] = useState<RatingSummary | null>(null);
  const [reviews, setReviews] = useState<PublicReview[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, r] = await Promise.all([
        getPublicRatingSummary(profileId),
        getPublicReviews(profileId, { limit: PAGE_SIZE, offset: 0 }),
      ]);
      summaryCache.set(profileId, s);
      setSummary(s);
      setReviews(r);
      setHasMore(r.length === PAGE_SIZE);
    } catch {
      setError('We couldn’t load the reviews just now.');
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await getPublicReviews(profileId, { limit: PAGE_SIZE, offset: reviews.length });
      setReviews((prev) => [...prev, ...next]);
      setHasMore(next.length === PAGE_SIZE);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section className="section-tight" aria-label="Reviews">
      <h2>Reviews</h2>
      {loading ? (
        <div className="row" style={{ gap: 10 }}>
          <Loader2 size={18} aria-hidden="true" />
          <span className="muted">Loading reviews…</span>
        </div>
      ) : error ? (
        <>
          <p className="muted" role="alert">{error}</p>
          <button className="btn btn-secondary btn-small" onClick={() => void loadFirst()}>Try again</button>
        </>
      ) : !summary || summary.reviewerCount === 0 ? (
        <p className="muted">
          No reviews yet — {firstName} is new here. Reviews appear after completed conversations.
        </p>
      ) : (
        <>
          <div className="row wrap mb-4" style={{ gap: 16 }}>
            <RatingStars average={summary.average} reviewerCount={summary.reviewerCount} />
            <span className="faint">One rating per person — repeat conversations update it, never stack.</span>
          </div>
          {reviews.length === 0 ? (
            <p className="faint">No written reviews yet — {summary.reviewerCount === 1 ? 'the rating was' : 'ratings were'} left without a comment.</p>
          ) : (
            <div className="stack-list">
              {reviews.map((r, i) => (
                <blockquote key={`${r.updatedAt}-${i}`} className="card card-tight" style={{ margin: 0 }}>
                  <div className="row between">
                    <span className="bold">
                      {r.reviewerFirstName}
                      {r.reviewerLastInitial ? ` ${r.reviewerLastInitial}.` : ''}
                    </span>
                    <span className="row" style={{ gap: 4 }} aria-label={`${r.score} out of 5 stars`}>
                      <Star size={14} fill="currentColor" aria-hidden="true" style={{ color: 'var(--color-brand-strong)' }} />
                      <span className="muted">{r.score}</span>
                    </span>
                  </div>
                  {r.publicComment && <p style={{ margin: '10px 0 0' }}>{r.publicComment}</p>}
                  <p className="faint" style={{ margin: '6px 0 0' }}>
                    {new Date(r.updatedAt).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
                  </p>
                </blockquote>
              ))}
            </div>
          )}
          {hasMore && (
            <button className="btn btn-secondary btn-small mt-4" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? 'Loading…' : 'Show more reviews'}
            </button>
          )}
        </>
      )}
    </section>
  );
}
