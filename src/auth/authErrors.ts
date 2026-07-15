/**
 * Central auth error mapping — raw Supabase/PostgREST errors never reach the
 * interface. Development logs get sanitised technical context only.
 */

export class AuthAppError extends Error {
  constructor(
    message: string,
    public readonly code: AuthErrorCode,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'AuthAppError';
  }
}

export type AuthErrorCode =
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'already_registered'
  | 'weak_password'
  | 'expired_link'
  | 'rate_limited'
  | 'network'
  | 'service_unavailable'
  | 'missing_session'
  | 'bootstrap_failed'
  | 'profile_creation_failed'
  | 'access_denied'
  | 'unknown';

interface RawError {
  message?: string;
  status?: number;
  code?: string;
  name?: string;
}

export function mapAuthError(raw: unknown, context = ''): AuthAppError {
  const e = (raw ?? {}) as RawError;
  const msg = (e.message ?? '').toLowerCase();
  const status = e.status ?? 0;

  if (import.meta.env?.DEV) {
    // Sanitised: never log passwords, tokens, links or full headers.
    console.warn(`[auth] ${context || 'error'}:`, e.name ?? '', e.code ?? '', e.message ?? '');
  }

  if (msg.includes('invalid login credentials') || msg.includes('invalid_credentials')) {
    return new AuthAppError('That email and password combination didn’t work. Please try again.', 'invalid_credentials', true);
  }
  if (msg.includes('email not confirmed')) {
    return new AuthAppError('Please confirm your email first — check your inbox for our message.', 'email_not_confirmed', true);
  }
  if (msg.includes('already registered') || msg.includes('already been registered')) {
    return new AuthAppError('An account already exists for this email. Try signing in instead.', 'already_registered');
  }
  if (msg.includes('password') && (msg.includes('at least') || msg.includes('weak') || msg.includes('short'))) {
    return new AuthAppError('Please choose a longer password — at least 8 characters.', 'weak_password', true);
  }
  if (msg.includes('expired') || msg.includes('invalid or has expired') || msg.includes('otp_expired')) {
    return new AuthAppError('That link has expired or was already used. Request a fresh one below.', 'expired_link', true);
  }
  if (status === 429 || msg.includes('rate limit') || msg.includes('too many')) {
    return new AuthAppError('Too many attempts just now — please wait a minute and try again.', 'rate_limited', true);
  }
  if (msg.includes('failed to fetch') || msg.includes('network') || e.name === 'TypeError') {
    return new AuthAppError('We couldn’t reach the server. Check your connection and try again.', 'network', true);
  }
  if (status >= 500 || msg.includes('service unavailable')) {
    return new AuthAppError('The service is having a moment. Please try again shortly.', 'service_unavailable', true);
  }
  if (msg.includes('session') && (msg.includes('missing') || msg.includes('not found'))) {
    return new AuthAppError('Your session has expired. Please sign in again.', 'missing_session');
  }
  if (msg.includes('row-level security') || msg.includes('permission denied') || status === 403 || status === 401) {
    return new AuthAppError('You don’t have access to that. If this seems wrong, sign out and back in.', 'access_denied');
  }
  return new AuthAppError('Something went wrong. Please try again.', 'unknown', true);
}
