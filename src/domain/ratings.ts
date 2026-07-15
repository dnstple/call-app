import type { Rating } from '../types';

/**
 * "One person equals one rating": one active rating per reviewer–reviewee pair.
 * A later rating from the same reviewer updates their existing entry rather than
 * adding another public score.
 */
export function upsertRating(
  ratings: Rating[],
  input: {
    reviewerId: string;
    revieweeId: string;
    bookingId: string;
    stars: number;
    publicComment?: string;
    privateFeedback?: string;
  },
  now: string = new Date().toISOString(),
): Rating[] {
  if (input.stars < 1 || input.stars > 5) {
    throw new Error('Stars must be between 1 and 5');
  }
  const existing = ratings.find(
    (r) => r.active && r.reviewerId === input.reviewerId && r.revieweeId === input.revieweeId,
  );
  if (existing) {
    return ratings.map((r) =>
      r.id === existing.id
        ? {
            ...r,
            stars: input.stars,
            bookingId: input.bookingId,
            publicComment: input.publicComment,
            privateFeedback: input.privateFeedback,
            updatedAt: now,
          }
        : r,
    );
  }
  return [
    ...ratings,
    {
      id: `rating-${input.reviewerId}-${input.revieweeId}`,
      reviewerId: input.reviewerId,
      revieweeId: input.revieweeId,
      bookingId: input.bookingId,
      stars: input.stars,
      publicComment: input.publicComment,
      privateFeedback: input.privateFeedback,
      active: true,
      updatedAt: now,
    },
  ];
}

/**
 * overall_rating = sum(latest active rating from each unique reviewer)
 *                  ÷ number of unique reviewers, rounded to 1 decimal place.
 */
export function overallRating(
  ratings: Rating[],
  revieweeId: string,
): { average: number | null; reviewerCount: number } {
  const active = ratings.filter((r) => r.active && r.revieweeId === revieweeId);
  const byReviewer = new Map<string, Rating>();
  for (const r of active) {
    const prev = byReviewer.get(r.reviewerId);
    if (!prev || r.updatedAt > prev.updatedAt) byReviewer.set(r.reviewerId, r);
  }
  const unique = [...byReviewer.values()];
  if (unique.length === 0) return { average: null, reviewerCount: 0 };
  const sum = unique.reduce((acc, r) => acc + r.stars, 0);
  return {
    average: Math.round((sum / unique.length) * 10) / 10,
    reviewerCount: unique.length,
  };
}

export function publicComments(ratings: Rating[], revieweeId: string): Rating[] {
  return ratings
    .filter((r) => r.active && r.revieweeId === revieweeId && r.publicComment)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
