import type { Session, User } from '@supabase/supabase-js';
import type { AccountRow, ProfileAccessRow, ProfileRow } from '../supabase/database.types';

/** A profile the signed-in account may act as, with its access grant. */
export interface AccessibleProfile {
  profile: ProfileRow;
  access: ProfileAccessRow;
}

export type AuthStatus =
  | 'loading'
  | 'unauthenticated'
  | 'authenticated'
  | 'setup_pending' // signed in, account bootstrap / profile load in flight or failed
  | 'error';

export interface AuthState {
  status: AuthStatus;
  session: Session | null;
  user: User | null;
  account: AccountRow | null;
  profiles: AccessibleProfile[];
  activeProfileId: string | null;
  error: string | null;
}

export interface AuthActions {
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<{ needsConfirmation: boolean }>;
  signOut(): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  updatePassword(newPassword: string): Promise<void>;
  resendConfirmation(email: string): Promise<void>;
  refreshProfiles(): Promise<void>;
  setActiveProfile(profileId: string): void;
  markOnboardingComplete(): Promise<void>;
}

export type AuthContextValue = AuthState & AuthActions;
