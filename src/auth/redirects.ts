/**
 * Redirect handling. The app URL comes from VITE_APP_URL (falling back to the
 * current origin) so confirmation and reset emails point at the right
 * deployment. Post-auth redirects only ever go to approved internal routes —
 * never to arbitrary user-supplied URLs.
 */

export function appUrl(): string {
  try {
    const configured = import.meta.env?.VITE_APP_URL;
    if (configured) return configured.replace(/\/$/, '');
  } catch {
    /* fall through */
  }
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173';
}

/** Where Supabase sends the user after clicking the confirmation email. */
export function emailConfirmRedirect(): string {
  return `${appUrl()}/#/auth/callback`;
}

/** Where Supabase sends the user after clicking the password-reset email. */
export function passwordResetRedirect(): string {
  return `${appUrl()}/#/reset-password`;
}

const SAFE_INTERNAL = /^\/(?!\/)[a-z0-9\-/?=&_]*$/i;

/** Validate an intended internal destination; falls back to home. */
export function safeInternalPath(path: string | null | undefined): string {
  if (!path) return '/';
  if (!SAFE_INTERNAL.test(path)) return '/';
  if (path.startsWith('/auth') || path.startsWith('/login') || path.startsWith('/register')) return '/';
  return path;
}
