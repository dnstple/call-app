/**
 * Auth bridge — strict data separation between modes (fresh-account rule).
 *
 * AuthProvider publishes a snapshot of the authenticated account's accessible
 * profiles here. In Supabase mode the view state shown to every page is built
 * ONLY from this snapshot: seeded Stage 1 activity (bookings, packages,
 * ratings, notifications, favourites) can never leak into a real account.
 * An empty database result stays empty — there is no mock fallback.
 */
import { useSyncExternalStore } from 'react';
import type {
  AppState,
  ManagedRelationship,
  Medium,
  User,
  UserSettings,
} from '../types';
import type { ProfileAccessRow, ProfileRow } from '../supabase/database.types';

export interface AuthSnapshot {
  userId: string | null;
  activeProfileId: string | null;
  profiles: { profile: ProfileRow; access: ProfileAccessRow }[];
}

const EMPTY_SNAPSHOT: AuthSnapshot = { userId: null, activeProfileId: null, profiles: [] };

let snapshot: AuthSnapshot = EMPTY_SNAPSHOT;
const listeners = new Set<() => void>();

export function setAuthSnapshot(next: AuthSnapshot): void {
  snapshot = next;
  listeners.forEach((l) => l());
}

export function clearAuthSnapshot(): void {
  setAuthSnapshot(EMPTY_SNAPSHOT);
}

export function getAuthSnapshot(): AuthSnapshot {
  return snapshot;
}

export function subscribeAuthSnapshot(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAuthSnapshot(): AuthSnapshot {
  return useSyncExternalStore(subscribeAuthSnapshot, getAuthSnapshot);
}

/* ---------------- Row → domain mapping ---------------- */

export function profileRowToUser(row: ProfileRow): User {
  return {
    id: row.id,
    role: row.role,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email ?? '',
    phone: row.phone ?? '',
    ageBand: row.age_band ?? '',
    region: row.region ?? '',
    headline: row.headline ?? '',
    bio: row.bio ?? '',
    interests: row.interests ?? [],
    languages: row.languages ?? ['English'],
    style: (row.style as User['style']) || 'relaxed',
    mediums: (row.mediums as Medium[])?.length ? (row.mediums as Medium[]) : ['phone'],
    avatarColor: row.avatar_color || '#c8643d',
    photoUrl: row.photo_url ?? undefined,
    verification: row.verification === 'verified' ? 'verified' : row.verification,
    accessibilityNeeds: row.accessibility_needs ?? undefined,
    preferredTimes: row.preferred_times ?? undefined,
    boundaries: row.boundaries ?? undefined,
    joinedAt: row.joined_at,
  };
}

/* ---------------- Supabase view state ---------------- */

const DEFAULT_CONFIG = {
  standardCommissionPct: 2,
  trialCommissionPct: 0,
  recommendedTrialPence: 500,
  trialDurationMins: 30,
  completionReminderHours: 24,
  currency: 'GBP' as const,
};

/**
 * Build the application state visible in Supabase mode.
 * Contains only the authenticated account's accessible profiles and derived
 * relationships. All user-specific activity is empty until each feature
 * genuinely migrates (Stage 2C+) — never seeded, never merged from mock.
 *
 * `uiSettings` is passed through deliberately: it holds only safe interface
 * preferences (text size, contrast, motion…) keyed by profile UUID, so it is
 * naturally namespaced per account and never contains activity data.
 */
export function buildSupabaseViewState(auth: AuthSnapshot, uiSettings: UserSettings[]): AppState {
  const users = auth.profiles.map((p) => profileRowToUser(p.profile));

  // Transitional placeholder so pages never crash while profiles load or
  // when an account has not created a profile yet. Carries no activity.
  if (users.length === 0) {
    users.push({
      id: 'pending-profile',
      role: 'member',
      firstName: 'there',
      lastName: '',
      email: '',
      phone: '',
      ageBand: '',
      region: '',
      headline: '',
      bio: '',
      interests: [],
      languages: ['English'],
      style: 'relaxed',
      mediums: ['phone'],
      avatarColor: '#c8643d',
      verification: 'not_verified',
      joinedAt: new Date().toISOString(),
    });
  }

  // Derive Coordinator → managed Member relationships from profile_access.
  const ownerCoordinator = auth.profiles.find(
    (p) => p.access.access_role === 'owner' && p.profile.role === 'coordinator',
  );
  const relationships: ManagedRelationship[] = ownerCoordinator
    ? auth.profiles
        .filter((p) => p.access.access_role === 'coordinator')
        .map((p) => ({
          id: p.access.id,
          coordinatorId: ownerCoordinator.profile.id,
          memberId: p.profile.id,
          relationship: 'Managed profile',
          consentStatus: p.access.consent_status === 'confirmed' ? 'recorded' : 'pending',
          canBook: p.access.can_book,
          createdAt: p.access.created_at,
        }))
    : [];

  const activeId =
    auth.activeProfileId && users.some((u) => u.id === auth.activeProfileId)
      ? auth.activeProfileId
      : users[0]?.id ?? '';
  const active = users.find((u) => u.id === activeId);
  const activeMemberId =
    active?.role === 'coordinator'
      ? relationships[0]?.memberId
      : active?.role === 'member'
        ? active.id
        : undefined;

  return {
    version: 1,
    session: { currentUserId: activeId, activeMemberId },
    config: DEFAULT_CONFIG,
    users,
    relationships,
    availabilityRules: [],
    availabilityExceptions: [],
    offers: [],
    purchases: [],
    bookings: [],
    confirmations: [],
    ratings: [],
    notifications: [],
    reports: [],
    transactions: [],
    favourites: {},
    settings: uiSettings,
    signupUserIds: [],
  };
}
