// @vitest-environment jsdom
/**
 * Stage 2E2A unit tests — ratings persistence.
 *
 * The database is the authority for eligibility, side derivation and the
 * one-rating-per-pair upsert; these tests prove the browser-side contract
 * (only booking + score + comments are ever sent), client validation,
 * typed error codes and the safe public payload mapping.
 * The Supabase client is mocked. Mock mode is untouched: the existing
 * ratings.test.ts still proves the Stage 1 model unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResult: { data: null as unknown, error: null as { message: string } | null },
}));

vi.mock('../../supabase/client', () => ({
  getSupabaseClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      mock.rpcCalls.push({ fn, args });
      return Promise.resolve(mock.rpcResult);
    },
  }),
  isSupabaseConfigured: () => true,
  supabaseEnv: () => ({ url: 'http://test.local', anonKey: 'anon' }),
}));

import {
  getPublicRatingSummary,
  getPublicReviews,
  mapRatingError,
  RatingError,
  submitRating,
  validateRatingInput,
} from '../../repositories/ratingRepository';
import { overallRating, upsertRating } from '../../domain/ratings';
import type { RatingRow } from '../../supabase/database.types';

const savedRow: RatingRow = {
  id: 'r1',
  reviewer_profile_id: 'member-1',
  reviewee_profile_id: 'companion-1',
  submitted_by_account_id: 'acc-1',
  source_booking_id: 'b1',
  score: 5,
  public_comment: 'Lovely chat',
  private_feedback: null,
  created_at: 'x',
  updated_at: 'x',
};

beforeEach(() => {
  mock.rpcCalls = [];
  mock.rpcResult = { data: savedRow, error: null };
});

describe('browser contract: participants are never chosen by the client', () => {
  it('9. sends only booking, score and comments — no reviewer/reviewee/account ids', async () => {
    await submitRating('b1', { score: 5, publicComment: 'Lovely chat' });
    expect(mock.rpcCalls).toHaveLength(1);
    expect(mock.rpcCalls[0].fn).toBe('submit_rating');
    expect(Object.keys(mock.rpcCalls[0].args).sort()).toEqual([
      'p_booking',
      'p_private_feedback',
      'p_public_comment',
      'p_score',
    ]);
    const raw = JSON.stringify(mock.rpcCalls[0].args).toLowerCase();
    for (const banned of ['reviewer', 'reviewee', 'account', 'profile_id', 'payment', 'credit', 'notification']) {
      expect(raw).not.toContain(banned); // 20. no side-effect fields either
    }
  });

  it('12. a successful submit returns the saved rating row', async () => {
    const row = await submitRating('b1', { score: 5 });
    expect(row.reviewer_profile_id).toBe('member-1'); // derived by the SERVER
    expect(row.reviewee_profile_id).toBe('companion-1');
  });
});

describe('client-side validation (server enforces the same rules again)', () => {
  it('10. score below 1 is rejected without any request', async () => {
    await expect(submitRating('b1', { score: 0 })).rejects.toMatchObject({ code: 'invalid_score' });
    expect(mock.rpcCalls).toHaveLength(0);
  });
  it('11. score above 5 is rejected without any request', async () => {
    await expect(submitRating('b1', { score: 6 })).rejects.toMatchObject({ code: 'invalid_score' });
    expect(mock.rpcCalls).toHaveLength(0);
  });
  it('non-integer scores and oversized comments are rejected', () => {
    expect(validateRatingInput({ score: 3.5 })?.code).toBe('invalid_score');
    expect(validateRatingInput({ score: 3, publicComment: 'x'.repeat(1001) })?.code).toBe('invalid_comment');
    expect(validateRatingInput({ score: 3, privateFeedback: 'x'.repeat(2001) })?.code).toBe('invalid_comment');
    expect(validateRatingInput({ score: 3 })).toBeNull();
  });
});

describe('typed error codes (server eligibility rules)', () => {
  const cases: [string, string][] = [
    // 2. confirmed but unfinished
    ['booking_not_completed: this conversation has not been completed yet — confirm it first', 'too_early'],
    // 3+4. needs_review / cancelled / declined / requested
    ['booking_not_completed: only completed conversations can be rated (status is needs_review)', 'booking_not_completed'],
    ['booking_not_completed: only completed conversations can be rated (status is cancelled)', 'booking_not_completed'],
    // 5. unrelated user (RLS hides the booking entirely)
    ['Booking not found', 'not_found'],
    ['You cannot rate this conversation', 'unauthorised'],
    // 6. self-rating / companion side
    ['self_rating: companions receive ratings — they do not rate members', 'self_rating'],
    ['invalid_score: the score must be between 1 and 5', 'invalid_score'],
    ['invalid_comment: the comment is too long', 'invalid_comment'],
    ['Failed to fetch', 'network_failure'],
  ];
  it.each(cases)('maps “%s” → %s', (message, code) => {
    const err = mapRatingError({ message });
    expect(err).toBeInstanceOf(RatingError);
    expect(err.code).toBe(code);
    expect(err.message).not.toMatch(/row-level|violates|constraint|booking_not_completed|self_rating/i);
  });

  it('1+2. submit surfaces server rejections as typed errors', async () => {
    mock.rpcResult = { data: null, error: { message: 'booking_not_completed: this conversation has not been completed yet — confirm it first' } };
    await expect(submitRating('b1', { score: 4 })).rejects.toMatchObject({ code: 'too_early' });
  });
});

describe('one rating per pair — repeat conversations update, never stack', () => {
  // The database enforces this with unique (reviewer, reviewee) + upsert;
  // the identical Stage 1 domain rule is the display-side mirror.
  it('13. a later conversation updates the same pair rating', () => {
    let ratings = upsertRating([], {
      reviewerId: 'm1', revieweeId: 'c1', bookingId: 'b1', stars: 3,
    });
    ratings = upsertRating(ratings, {
      reviewerId: 'm1', revieweeId: 'c1', bookingId: 'b2', stars: 5,
    });
    expect(ratings).toHaveLength(1);
    expect(ratings[0].stars).toBe(5);
    expect(ratings[0].bookingId).toBe('b2'); // re-pointed at the latest booking
  });

  it('14+16. unique reviewer count and average ignore repeat ratings', () => {
    let ratings = upsertRating([], { reviewerId: 'm1', revieweeId: 'c1', bookingId: 'b1', stars: 2 });
    ratings = upsertRating(ratings, { reviewerId: 'm1', revieweeId: 'c1', bookingId: 'b2', stars: 4 });
    ratings = upsertRating(ratings, { reviewerId: 'm2', revieweeId: 'c1', bookingId: 'b3', stars: 5 });
    const { average, reviewerCount } = overallRating(ratings, 'c1');
    expect(reviewerCount).toBe(2); // m1 counted once despite two conversations
    expect(average).toBe(4.5); // (4 + 5) / 2
  });
});

describe('public surfaces are safe', () => {
  it('16. the summary maps average and unique reviewer count', async () => {
    mock.rpcResult = { data: { average: 4.5, reviewer_count: 2 }, error: null };
    const summary = await getPublicRatingSummary('companion-1');
    expect(mock.rpcCalls[0]).toEqual({
      fn: 'get_companion_rating_summary',
      args: { p_profile: 'companion-1' },
    });
    expect(summary).toEqual({ average: 4.5, reviewerCount: 2 });
  });

  it('an unrated companion yields null average and zero reviewers', async () => {
    mock.rpcResult = { data: { average: null, reviewer_count: 0 }, error: null };
    expect(await getPublicRatingSummary('companion-1')).toEqual({ average: null, reviewerCount: 0 });
  });

  it('15. public reviews expose safe fields only — never private feedback or ids', async () => {
    mock.rpcResult = {
      data: [{
        reviewer_first_name: 'Dorothy',
        reviewer_last_initial: 'F',
        score: 5,
        public_comment: 'Lovely chat',
        updated_at: 'x',
      }],
      error: null,
    };
    const reviews = await getPublicReviews('companion-1', { limit: 10, offset: 0 });
    expect(reviews).toHaveLength(1);
    const raw = JSON.stringify(reviews[0]).toLowerCase();
    expect(raw).not.toContain('private');
    expect(raw).not.toContain('account');
    expect(raw).not.toContain('booking');
    expect(reviews[0].reviewerFirstName).toBe('Dorothy');
    expect(reviews[0].reviewerLastInitial).toBe('F'); // initial, never a surname
  });
});
