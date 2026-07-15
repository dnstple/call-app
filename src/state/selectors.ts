import type { AppState, Booking, User, UserSettings } from '../types';
import { effectiveStatus } from '../domain/bookings';

export function userById(state: AppState, id: string | undefined): User | undefined {
  return state.users.find((u) => u.id === id);
}

export function currentUser(state: AppState): User {
  return userById(state, state.session.currentUserId) ?? state.users[0];
}

/** Members managed by a Coordinator (consent recorded). */
export function managedMembers(state: AppState, coordinatorId: string): User[] {
  return state.relationships
    .filter((r) => r.coordinatorId === coordinatorId)
    .map((r) => userById(state, r.memberId))
    .filter((u): u is User => Boolean(u));
}

/** The Member currently in focus: self for Members, active managed Member for Coordinators. */
export function activeMember(state: AppState): User | undefined {
  const me = currentUser(state);
  if (me.role === 'member') return me;
  if (me.role === 'coordinator') {
    const members = managedMembers(state, me.id);
    return members.find((m) => m.id === state.session.activeMemberId) ?? members[0];
  }
  return undefined;
}

/** Bookings visible to the current user, with time-derived status applied. */
export function visibleBookings(state: AppState, now = new Date()): Booking[] {
  const me = currentUser(state);
  return state.bookings
    .filter((b) => {
      if (me.role === 'companion') return b.companionId === me.id;
      if (me.role === 'member') return b.memberId === me.id;
      return b.coordinatorId === me.id || managedMembers(state, me.id).some((m) => m.id === b.memberId);
    })
    .map((b) => ({ ...b, status: effectiveStatus(b, now) }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

export function unreadCount(state: AppState): number {
  return state.notifications.filter((n) => n.userId === state.session.currentUserId && !n.read).length;
}

export function myNotifications(state: AppState) {
  return state.notifications
    .filter((n) => n.userId === state.session.currentUserId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const DEFAULT_SETTINGS = (userId: string): UserSettings => ({
  userId,
  notificationPrefs: {
    bookingRequests: true,
    confirmations: true,
    reminders: true,
    changes: true,
    completionPrompts: true,
    ratings: true,
    marketing: false,
    channels: { email: true, sms: false, push: true, inApp: true },
  },
  accessibility: {
    textSize: 'default',
    highContrast: false,
    reducedMotion: false,
    captions: false,
    simpleMode: false,
  },
  profileVisible: true,
  shareContactAfterConfirm: true,
  blockedUserIds: [],
});

export function settingsFor(state: AppState, userId: string): UserSettings {
  return state.settings.find((s) => s.userId === userId) ?? DEFAULT_SETTINGS(userId);
}

export function isFavourite(state: AppState, profileId: string): boolean {
  return (state.favourites[state.session.currentUserId] ?? []).includes(profileId);
}

/** Active purchases for a member (or all the current user can see). */
export function purchasesForMember(state: AppState, memberId: string) {
  return state.purchases.filter((p) => p.memberId === memberId);
}
