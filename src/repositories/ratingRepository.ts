/**
 * Ratings persistence (Supabase mode, Stage 2E2A).
 *
 * Product model: the MEMBER side rates the COMPANION after a COMPLETED
 * conversation. Reviewer, reviewee and actor are derived server-side from
 * the booking — the browser sends only booking id, score and comments.
 * One rating per pair: repeat conversations update, never stack.
 * Private feedback is for the platform team and never appears publicly.
 * NO payment, package or notification side effects. Never mock data.
 */
import { getSupabaseClient } from '../supabase/client';
import type {
  PublicReviewRow,
  RatingRow,
  RatingSummaryPayload,
} from '../supabase/database.types';
import { RepoError, type RepoErrorKind } from './profileRepository';

export type RatingErrorCode =
  | 'too_early'
  | 'booking_not_completed'
  | 'unauthorised'
  | 'invalid_score'
  | 'invalid_comment'
  | 'self_rating'
  | 'not_found'
  | 'network_failure'
  | 'unknown';

export class RatingError extends RepoError {
  constructor(message: string, kind: RepoErrorKind, public readonly code: RatingErrorCode) {
    super(message, kind);
    this.name = 'RatingError';
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapRatingError(e: any): RatingError {
  const msg = String(e?.message ?? '').toLowerCase();
  if (import.meta.env?.DEV) console.warn('[ratings]', e?.code ?? '', e?.message ?? '');
  if (msg.includes('not been completed yet')) {
    return new RatingError('This conversation hasn’t been completed yet — confirm how it went first.', 'validation', 'too_early');
  }
  if (msg.includes('booking_not_completed')) {
    return new RatingError('Only completed conversations can be rated.', 'validation', 'booking_not_completed');
  }
  if (msg.includes('invalid_score')) {
    return new RatingError('Please choose a score from 1 to 5.', 'validation', 'invalid_score');
  }
  if (msg.includes('invalid_comment')) {
    return new RatingError('That comment is too long.', 'validation', 'invalid_comment');
  }
  if (msg.includes('self_rating') || msg.includes('they do not rate')) {
    return new RatingError('Companions receive ratings — they don’t rate members.', 'validation', 'self_rating');
  }
  if (msg.includes('cannot rate') || msg.includes('row-level security') || msg.includes('permission denied') || msg.includes('not authenticated')) {
    return new RatingError('You don’t have permission to rate this conversation.', 'unauthorised', 'unauthorised');
  }
  if (msg.includes('not found')) {
    return new RatingError('We couldn’t find that conversation.', 'not_found', 'not_found');
  }
  if (msg.includes('failed to fetch') || msg.includes('network')) {
    return new RatingError('We couldn’t reach the server. Please check your connection.', 'network', 'network_failure');
  }
  return new RatingError('Something went wrong. Please try again.', 'database', 'unknown');
}

export const PUBLIC_COMMENT_MAX = 1000;
export const PRIVATE_FEEDBACK_MAX = 2000;

export interface RatingInput {
  score: number;
  publicComment?: string;
  privateFeedback?: string;
}

/** Client-side pre-validation (the server enforces the same rules again). */
export function validateRatingInput(input: RatingInput): RatingError | null {
  if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
    return new RatingError('Please choose a score from 1 to 5.', 'validation', 'invalid_score');
  }
  if ((input.publicComment ?? '').length > PUBLIC_COMMENT_MAX) {
    return new RatingError('That public comment is too long.', 'validation', 'invalid_comment');
  }
  if ((input.privateFeedback ?? '').length > PRIVATE_FEEDBACK_MAX) {
    return new RatingError('That private feedback is too long.', 'validation', 'invalid_comment');
  }
  return null;
}

/**
 * Rate the Companion of a COMPLETED booking. Sends ONLY booking id, score
 * and comments — reviewer/reviewee/actor are derived server-side. Repeat
 * ratings for the same Companion update the existing rating.
 */
export async function submitRating(bookingId: string, input: RatingInput): Promise<RatingRow> {
  const invalid = validateRatingInput(input);
  if (invalid) throw invalid;
  const { data, error } = await getSupabaseClient().rpc('submit_rating', {
    p_booking: bookingId,
    p_score: input.score,
    p_public_comment: input.publicComment?.trim() || null,
    p_private_feedback: input.privateFeedback?.trim() || null,
  });
  if (error) throw mapRatingError(error);
  return data as RatingRow;
}

/** The caller's own rating for a reviewer–reviewee pair (RLS-scoped). */
export async function getRatingForPair(
  reviewerProfileId: string,
  revieweeProfileId: string,
): Promise<RatingRow | null> {
  const { data, error } = await getSupabaseClient()
    .from('ratings')
    .select('*')
    .eq('reviewer_profile_id', reviewerProfileId)
    .eq('reviewee_profile_id', revieweeProfileId)
    .maybeSingle();
  if (error) throw mapRatingError(error);
  return (data as RatingRow | null) ?? null;
}

/** The caller's own rating whose latest source is this booking (RLS-scoped). */
export async function getRatingForBooking(bookingId: string): Promise<RatingRow | null> {
  const { data, error } = await getSupabaseClient()
    .from('ratings')
    .select('*')
    .eq('source_booking_id', bookingId)
    .maybeSingle();
  if (error) throw mapRatingError(error);
  return (data as RatingRow | null) ?? null;
}

export interface RatingSummary {
  average: number | null;
  reviewerCount: number;
}

/** Public Companion summary — unique reviewers, never repeat bookings. */
export async function getPublicRatingSummary(profileId: string): Promise<RatingSummary> {
  const { data, error } = await getSupabaseClient().rpc('get_companion_rating_summary', {
    p_profile: profileId,
  });
  if (error) throw mapRatingError(error);
  const payload = data as RatingSummaryPayload;
  return {
    average: payload?.average !== null && payload?.average !== undefined ? Number(payload.average) : null,
    reviewerCount: Number(payload?.reviewer_count ?? 0),
  };
}

export interface PublicReview {
  reviewerFirstName: string;
  reviewerLastInitial: string | null;
  score: number;
  publicComment: string | null;
  updatedAt: string;
}

/** Public written reviews — safe columns only; NEVER private feedback. */
export async function getPublicReviews(
  profileId: string,
  pagination: { limit?: number; offset?: number } = {},
): Promise<PublicReview[]> {
  const { data, error } = await getSupabaseClient().rpc('get_companion_public_reviews', {
    p_profile: profileId,
    p_limit: pagination.limit ?? 10,
    p_offset: pagination.offset ?? 0,
  });
  if (error) throw mapRatingError(error);
  return ((data ?? []) as PublicReviewRow[]).map((r) => ({
    reviewerFirstName: r.reviewer_first_name,
    reviewerLastInitial: r.reviewer_last_initial,
    score: r.score,
    publicComment: r.public_comment,
    updatedAt: r.updated_at,
  }));
}
