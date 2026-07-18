/**
 * Redesign Phase B — explicit managed-Member context.
 *
 * The authenticated account holder (usually a Coordinator) may manage one
 * or more Member profiles. Anywhere the chosen Member changes behaviour
 * (messaging, bookings, plans, invitations, payments) the selection must
 * be EXPLICIT:
 *  - zero managed members  → context null;
 *  - exactly one           → that member, shown as plain page context;
 *  - several, none chosen  → null — callers must ask, never members[0];
 *  - several, one chosen   → the validated stored choice.
 *
 * The choice is per-account, sessionStorage-persisted, and NEVER trusted:
 * it is re-validated against the database-derived coordinated set on
 * every read.
 */
import { useSyncExternalStore } from 'react';
import { useAuthSnapshot } from './authBridge';
import { isSupabaseMode } from '../config/dataMode';
import { useAppState } from './store';
import { activeMember, currentUser, managedMembers } from './selectors';

const KEY = (accountId: string) => `companionship-managed-member-${accountId}`;

let version = 0;
const listeners = new Set<() => void>();
function bump() {
  version += 1;
  listeners.forEach((l) => l());
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function setManagedMember(accountId: string, profileId: string): void {
  try {
    sessionStorage.setItem(KEY(accountId), profileId);
  } catch {
    /* storage unavailable */
  }
  bump();
}

function storedMember(accountId: string): string | null {
  try {
    return sessionStorage.getItem(KEY(accountId));
  } catch {
    return null;
  }
}

export interface ManagedMemberOption {
  profileId: string;
  name: string;
}

export interface ManagedMemberContext {
  /** All member profiles this account coordinates. */
  members: ManagedMemberOption[];
  /** The explicit selection — null when several exist and none is chosen. */
  selected: ManagedMemberOption | null;
  /** True when a page must ask before member-scoped actions. */
  needsChoice: boolean;
  select: (profileId: string) => void;
}

export function useManagedMember(): ManagedMemberContext {
  useSyncExternalStore(subscribe, () => version);
  const auth = useAuthSnapshot();
  const state = useAppState();

  if (!isSupabaseMode()) {
    // Mock mode: derived from the demo state (single explicit active member).
    const me = currentUser(state);
    const members = (me.role === 'coordinator' ? managedMembers(state, me.id) : []).map((m) => ({
      profileId: m.id,
      name: `${m.firstName} ${m.lastName}`.trim(),
    }));
    const act = activeMember(state);
    const selected = members.find((m) => m.profileId === act?.id) ?? (members.length === 1 ? members[0] : null);
    return {
      members,
      selected,
      needsChoice: members.length > 1 && !selected,
      select: () => undefined, // mock mode selection flows through demo actions
    };
  }

  const accountId = auth.userId ?? '';
  const members: ManagedMemberOption[] = auth.profiles
    .filter((p) => p.access.access_role === 'coordinator'
      && p.profile.role === 'member'
      && p.access.consent_status !== 'withdrawn')
    .map((p) => ({
      profileId: p.profile.id,
      name: `${p.profile.first_name} ${p.profile.last_name ?? ''}`.trim(),
    }));

  let selected: ManagedMemberOption | null = null;
  if (members.length === 1) {
    selected = members[0];
  } else if (members.length > 1) {
    const stored = storedMember(accountId);
    // Validate the stored id against the permitted set — never trust it.
    selected = members.find((m) => m.profileId === stored) ?? null;
  }

  return {
    members,
    selected,
    needsChoice: members.length > 1 && !selected,
    select: (profileId) => {
      if (!members.some((m) => m.profileId === profileId)) return; // permitted set only
      setManagedMember(accountId, profileId);
    },
  };
}

/** The account holder's own role — the identity shown top-right. */
export function useAccountRole(): 'coordinator' | 'companion' | 'member' {
  const auth = useAuthSnapshot();
  const state = useAppState();
  if (!isSupabaseMode()) return currentUser(state).role;
  const owned = auth.profiles.find((p) => p.access.access_role === 'owner');
  if (owned) return owned.profile.role as 'coordinator' | 'companion' | 'member';
  // An account whose only access rows are coordinator-side manages members.
  return auth.profiles.length > 0 ? 'coordinator' : 'coordinator';
}
