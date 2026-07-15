import { describe, expect, it } from 'vitest';
import { overallRating, upsertRating } from '../ratings';
import type { Rating } from '../../types';

const base = { revieweeId: 'comp-1', bookingId: 'b1' };

describe('unique-reviewer rating rule', () => {
  it('creates a first rating', () => {
    const out = upsertRating([], { ...base, reviewerId: 'u1', stars: 5 });
    expect(out).toHaveLength(1);
    expect(out[0].stars).toBe(5);
    expect(out[0].active).toBe(true);
  });

  it('updates the existing rating instead of adding another (one person = one rating)', () => {
    let ratings = upsertRating([], { ...base, reviewerId: 'u1', stars: 5 });
    ratings = upsertRating(ratings, { ...base, reviewerId: 'u1', stars: 3, bookingId: 'b2' });
    expect(ratings).toHaveLength(1);
    expect(ratings[0].stars).toBe(3);
    expect(ratings[0].bookingId).toBe('b2');
  });

  it('repeated conversations cannot give a reviewer extra weight', () => {
    let ratings: Rating[] = [];
    ratings = upsertRating(ratings, { ...base, reviewerId: 'u1', stars: 5 });
    ratings = upsertRating(ratings, { ...base, reviewerId: 'u1', stars: 5 });
    ratings = upsertRating(ratings, { ...base, reviewerId: 'u2', stars: 3 });
    const { average, reviewerCount } = overallRating(ratings, 'comp-1');
    expect(reviewerCount).toBe(2);
    expect(average).toBe(4); // (5 + 3) / 2, not weighted by repeat ratings
  });

  it('computes the documented example: 5, 4, 4 from three unique people → 4.3', () => {
    let ratings: Rating[] = [];
    ratings = upsertRating(ratings, { ...base, reviewerId: 'u1', stars: 5 });
    ratings = upsertRating(ratings, { ...base, reviewerId: 'u2', stars: 4 });
    ratings = upsertRating(ratings, { ...base, reviewerId: 'u3', stars: 4 });
    const { average, reviewerCount } = overallRating(ratings, 'comp-1');
    expect(average).toBe(4.3);
    expect(reviewerCount).toBe(3);
  });

  it('returns null average with no ratings', () => {
    expect(overallRating([], 'comp-1')).toEqual({ average: null, reviewerCount: 0 });
  });

  it('ignores inactive ratings', () => {
    let ratings = upsertRating([], { ...base, reviewerId: 'u1', stars: 1 });
    ratings = ratings.map((r) => ({ ...r, active: false }));
    expect(overallRating(ratings, 'comp-1').reviewerCount).toBe(0);
  });

  it('rejects out-of-range stars', () => {
    expect(() => upsertRating([], { ...base, reviewerId: 'u1', stars: 0 })).toThrow();
    expect(() => upsertRating([], { ...base, reviewerId: 'u1', stars: 6 })).toThrow();
  });
});
