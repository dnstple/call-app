/**
 * Central authentication service — the only place that talks to
 * supabase.auth and the account/profile-access tables. Visual components go
 * through AuthProvider/useAuth, never through the Supabase client directly.
 */
import type { Session, User } from '@supabase/supabase-js';
import { getSupabaseClient } from '../supabase/client';
import type { AccountRow } from '../supabase/database.types';
import { mapAuthError } from './authErrors';
import { emailConfirmRedirect, passwordResetRedirect } from './redirects';
import type { AccessibleProfile } from './authTypes';

export async function signUpWithPassword(email: string, password: string): Promise<{ needsConfirmation: boolean }> {
  const { data, error } = await getSupabaseClient().auth.signUp({
    email,
    password,
    options: { emailRedirectTo: emailConfirmRedirect() },
  });
  if (error) throw mapAuthError(error, 'signUp');
  // No session ⇒ email confirmation required before sign-in.
  return { needsConfirmation: !data.session };
}

export async function signInWithPassword(email: string, password: string): Promise<Session> {
  const { data, error } = await getSupabaseClient().auth.signInWithPassword({ email, password });
  if (error) throw mapAuthError(error, 'signIn');
  if (!data.session) throw mapAuthError({ message: 'session missing' }, 'signIn');
  return data.session;
}

export async function signOut(): Promise<void> {
  const { error } = await getSupabaseClient().auth.signOut();
  if (error) throw mapAuthError(error, 'signOut');
}

export async function requestPasswordReset(email: string): Promise<void> {
  const { error } = await getSupabaseClient().auth.resetPasswordForEmail(email, {
    redirectTo: passwordResetRedirect(),
  });
  // Deliberately swallow "user not found" style responses upstream:
  // the UI always shows a neutral message to avoid email enumeration.
  if (error && (error.status ?? 0) >= 500) throw mapAuthError(error, 'requestPasswordReset');
}

export async function updatePassword(newPassword: string): Promise<void> {
  const { error } = await getSupabaseClient().auth.updateUser({ password: newPassword });
  if (error) throw mapAuthError(error, 'updatePassword');
}

export async function resendConfirmation(email: string): Promise<void> {
  const { error } = await getSupabaseClient().auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo: emailConfirmRedirect() },
  });
  if (error && (error.status ?? 0) >= 500) throw mapAuthError(error, 'resendConfirmation');
}

export async function getCurrentSession(): Promise<Session | null> {
  const { data, error } = await getSupabaseClient().auth.getSession();
  if (error) throw mapAuthError(error, 'getSession');
  return data.session;
}

export async function getCurrentUser(): Promise<User | null> {
  const { data } = await getSupabaseClient().auth.getUser();
  return data.user ?? null;
}

export function subscribeToAuthChanges(
  callback: (event: string, session: Session | null) => void,
): () => void {
  const { data } = getSupabaseClient().auth.onAuthStateChange((event, session) => callback(event, session));
  return () => data.subscription.unsubscribe();
}

/** Idempotent account bootstrap — safe to call on every sign-in. */
export async function ensureAccount(displayName?: string): Promise<AccountRow> {
  const { data, error } = await getSupabaseClient().rpc('ensure_current_account', {
    p_display_name: displayName ?? null,
  });
  if (error) {
    const mapped = mapAuthError(error, 'ensureAccount');
    mapped.message = 'We couldn’t finish setting up your account. Please try again.';
    throw mapped;
  }
  return data as AccountRow;
}

/** Profiles this account may act as — the database is the authority. */
export async function loadAccessibleProfiles(): Promise<AccessibleProfile[]> {
  const client = getSupabaseClient();
  const { data: access, error: accessError } = await client
    .from('profile_access')
    .select('*')
    .neq('consent_status', 'withdrawn');
  if (accessError) throw mapAuthError(accessError, 'loadAccessibleProfiles/access');
  if (!access || access.length === 0) return [];

  const ids = access.map((a) => a.profile_id);
  const { data: profiles, error: profileError } = await client
    .from('profiles')
    .select('*')
    .in('id', ids);
  if (profileError) throw mapAuthError(profileError, 'loadAccessibleProfiles/profiles');

  // Surface catalogue interests on accessible profiles (the legacy
  // profiles.interests column stays empty in Supabase mode).
  const { data: profileInterests } = await client
    .from('profile_interests')
    .select('profile_id, interests(name, sort_order, active)')
    .in('profile_id', ids);
  if (profileInterests) {
    const byProfile = new Map<string, { name: string; sort_order: number }[]>();
    for (const row of profileInterests as unknown as {
      profile_id: string;
      interests: { name: string; sort_order: number; active: boolean } | null;
    }[]) {
      if (!row.interests?.active) continue;
      const list = byProfile.get(row.profile_id) ?? [];
      list.push(row.interests);
      byProfile.set(row.profile_id, list);
    }
    for (const p of profiles ?? []) {
      const list = byProfile.get(p.id);
      if (list) p.interests = list.sort((a, b) => a.sort_order - b.sort_order).map((i) => i.name);
    }
  }

  // Resolve stored avatars to short-lived signed URLs for display.
  const paths = (profiles ?? []).map((p) => p.avatar_path).filter((p): p is string => Boolean(p));
  if (paths.length > 0) {
    const { data: signed } = await client.storage.from('profile-avatars').createSignedUrls(paths, 3600);
    const byPath = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));
    for (const p of profiles ?? []) {
      if (p.avatar_path && byPath.get(p.avatar_path)) p.photo_url = byPath.get(p.avatar_path) as string;
    }
  }

  return access
    .map((a) => {
      const profile = (profiles ?? []).find((p) => p.id === a.profile_id);
      return profile ? { access: a, profile } : null;
    })
    .filter((x): x is AccessibleProfile => x !== null);
}

export async function markOnboardingComplete(): Promise<void> {
  const { error } = await getSupabaseClient().rpc('complete_onboarding');
  if (error) throw mapAuthError(error, 'completeOnboarding');
}
