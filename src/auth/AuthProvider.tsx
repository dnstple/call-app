/**
 * Central auth/session provider (Supabase mode).
 *
 * In mock mode the provider renders children immediately in a permanent
 * "unauthenticated" state and never touches the network — the prototype
 * needs no authentication.
 *
 * Active-profile security: the chosen profile id is remembered per auth
 * user, but NEVER trusted — on load and on every switch it is validated
 * against the database-derived accessible set and cleared when invalid.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { isSupabaseMode } from '../config/dataMode';
import { isSupabaseConfigured } from '../supabase/client';
import type { AccountRow } from '../supabase/database.types';
import * as svc from './authService';
import { AuthAppError } from './authErrors';
import { setAuthSnapshot } from '../state/authBridge';
import type { AccessibleProfile, AuthContextValue, AuthStatus } from './authTypes';

const ACTIVE_PROFILE_KEY = (userId: string) => `companionship-active-profile-${userId}`;

/** Reject a hung bootstrap call so sign-in surfaces a retry instead of spinning forever. */
function withTimeout<T>(p: Promise<T>, ms = 12000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('bootstrap_timeout')), ms)),
  ]);
}

const AuthContext = createContext<AuthContextValue | null>(null);

const IDLE: Pick<AuthContextValue, 'status' | 'session' | 'user' | 'account' | 'profiles' | 'activeProfileId' | 'error'> = {
  status: 'unauthenticated',
  session: null,
  user: null,
  account: null,
  profiles: [],
  activeProfileId: null,
  error: null,
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const supabaseActive = isSupabaseMode() && isSupabaseConfigured();
  const [status, setStatus] = useState<AuthStatus>(supabaseActive ? 'loading' : 'unauthenticated');
  const [session, setSession] = useState<Session | null>(null);
  const [account, setAccount] = useState<AccountRow | null>(null);
  const [profiles, setProfiles] = useState<AccessibleProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bootstrapping = useRef<string | null>(null); // guards duplicate bootstrap per user
  const bootstrappedUser = useRef<string | null>(null); // user id already fully set up

  // Publish the account's accessible profiles to the mode-aware view state
  // (fresh-account rule: Supabase mode renders only this — never mock data).
  // Only published when this provider actually manages a Supabase session,
  // so tests and unconfigured environments can control the snapshot.
  useEffect(() => {
    if (!supabaseActive) return;
    setAuthSnapshot({
      userId: session?.user?.id ?? null,
      activeProfileId,
      profiles,
    });
  }, [supabaseActive, session?.user?.id, activeProfileId, profiles]);

  const applySession = useCallback(async (next: Session | null) => {
    setSession(next);
    if (!next?.user) {
      setAccount(null);
      setProfiles([]);
      setActiveProfileId(null);
      bootstrappedUser.current = null;
      setStatus('unauthenticated');
      return;
    }
    const userId = next.user.id;
    // Already fully set up for this user (e.g. USER_UPDATED after a phone change,
    // or a background TOKEN_REFRESHED): adopt the new token silently. Re-running
    // the bootstrap here would flip status to 'setup_pending' and momentarily
    // unmount the current page — which is what wiped the OTP code-entry screen.
    if (bootstrappedUser.current === userId) return;
    if (bootstrapping.current === userId) return; // already bootstrapping this user
    bootstrapping.current = userId;
    setStatus('setup_pending');
    try {
      const acct = await withTimeout(svc.ensureAccount(next.user.email ?? undefined));
      setAccount(acct);
      const accessible = await withTimeout(svc.loadAccessibleProfiles());
      setProfiles(accessible);

      // Validate any cached active-profile id against the permitted set.
      let active: string | null = null;
      try {
        const cached = localStorage.getItem(ACTIVE_PROFILE_KEY(userId));
        if (cached && accessible.some((p) => p.profile.id === cached)) {
          active = cached;
        } else if (cached) {
          localStorage.removeItem(ACTIVE_PROFILE_KEY(userId)); // clear invalid cache
        }
      } catch {
        /* storage unavailable */
      }
      if (!active) {
        active =
          accessible.find((p) => p.access.access_role === 'owner')?.profile.id ??
          accessible[0]?.profile.id ??
          null;
      }
      setActiveProfileId(active);
      setError(null);
      bootstrappedUser.current = userId;
      setStatus('authenticated');
    } catch (e) {
      setError(e instanceof AuthAppError ? e.message : 'We couldn’t finish setting up your account.');
      setStatus('setup_pending');
    } finally {
      bootstrapping.current = null;
    }
  }, []);

  useEffect(() => {
    if (!supabaseActive) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    (async () => {
      try {
        // Never let a hung getSession freeze the app on a spinner — time out and
        // treat as no session (the landing/login still renders; a real session
        // will arrive via the auth-change subscription below).
        const initial = await Promise.race([
          svc.getCurrentSession(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
        ]);
        if (!cancelled) await applySession(initial);
      } catch {
        if (!cancelled) setStatus('unauthenticated');
      }
      unsubscribe = svc.subscribeToAuthChanges((event, next) => {
        if (cancelled) return;
        if (event === 'SIGNED_OUT') {
          void applySession(null);
        } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
          void applySession(next);
        } else if (event === 'PASSWORD_RECOVERY') {
          // Recovery session: keep it, ResetPassword page handles the update.
          setSession(next);
        }
      });
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [supabaseActive, applySession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...(supabaseActive
        ? { status, session, user: session?.user ?? null, account, profiles, activeProfileId, error }
        : IDLE),
      async signIn(email, password) {
        const s = await svc.signInWithPassword(email, password);
        await applySession(s);
      },
      async signUp(email, password, intendedRole) {
        return svc.signUpWithPassword(email, password, intendedRole);
      },
      async signOut() {
        await svc.signOut();
        await applySession(null);
      },
      async requestPasswordReset(email) {
        await svc.requestPasswordReset(email);
      },
      async updatePassword(newPassword) {
        await svc.updatePassword(newPassword);
      },
      async resendConfirmation(email) {
        await svc.resendConfirmation(email);
      },
      async refreshProfiles() {
        const accessible = await svc.loadAccessibleProfiles();
        setProfiles(accessible);
        if (activeProfileId && !accessible.some((p) => p.profile.id === activeProfileId)) {
          setActiveProfileId(accessible[0]?.profile.id ?? null);
        }
      },
      async refreshAccount() {
        if (!session?.user) return;
        try {
          const acct = await withTimeout(svc.ensureAccount(session.user.email ?? undefined));
          setAccount(acct);
        } catch {
          /* best-effort refresh — leave the existing account in place on failure */
        }
      },
      setActiveProfile(profileId) {
        // Only ever accept ids from the database-derived permitted set.
        if (!profiles.some((p) => p.profile.id === profileId)) return;
        setActiveProfileId(profileId);
        try {
          if (session?.user) localStorage.setItem(ACTIVE_PROFILE_KEY(session.user.id), profileId);
        } catch {
          /* ignore */
        }
      },
      async markOnboardingComplete() {
        await svc.markOnboardingComplete();
        if (account) setAccount({ ...account, onboarding_complete: true });
      },
    }),
    [supabaseActive, status, session, account, profiles, activeProfileId, error, applySession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
