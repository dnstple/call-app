/**
 * Service layer — all state mutations live here, not in components.
 * In Stage 2 these functions become API calls against a real backend.
 */
import type {
  AppNotification,
  AppState,
  Booking,
  CompletionOutcome,
  Medium,
  NotificationType,
  OfferKind,
  UserSettings,
} from '../types';
import { assertTransition, hasConflict, reconcileCompletion, trialEligible } from '../domain/bookings';
import { availableCredits, consumeCredit } from '../domain/packages';
import { computeFee } from '../domain/commission';
import { upsertRating } from '../domain/ratings';
import { formatDateTime } from '../domain/format';
import { getState, newId, pushToast, setState } from './store';
import { userById } from './selectors';

/* ---------------- Notifications (mock service) ---------------- */

function notify(
  state: AppState,
  userId: string,
  type: NotificationType,
  title: string,
  body: string,
  relatedBookingId?: string,
): AppState {
  const notification: AppNotification = {
    id: newId('ntf'),
    userId,
    type,
    title,
    body,
    relatedBookingId,
    read: false,
    createdAt: new Date().toISOString(),
  };
  return { ...state, notifications: [notification, ...state.notifications] };
}

function bookingParties(state: AppState, booking: Booking): string[] {
  const ids = [booking.memberId, booking.companionId];
  if (booking.coordinatorId) ids.push(booking.coordinatorId);
  return ids;
}

function notifyParties(
  state: AppState,
  booking: Booking,
  exceptUserId: string | null,
  type: NotificationType,
  title: string,
  body: string,
): AppState {
  let next = state;
  for (const id of bookingParties(state, booking)) {
    if (id === exceptUserId) continue;
    next = notify(next, id, type, title, body, booking.id);
  }
  return next;
}

/* ---------------- Session / role switcher ---------------- */

export function switchIdentity(userId: string): void {
  setState((s) => {
    const user = userById(s, userId);
    let activeMemberId = s.session.activeMemberId;
    if (user?.role === 'coordinator') {
      const managed = s.relationships.filter((r) => r.coordinatorId === userId);
      if (!managed.some((r) => r.memberId === activeMemberId)) {
        activeMemberId = managed[0]?.memberId;
      }
    }
    return { ...s, session: { currentUserId: userId, activeMemberId } };
  });
}

export function switchActiveMember(memberId: string): void {
  setState((s) => ({ ...s, session: { ...s.session, activeMemberId: memberId } }));
}

/* ---------------- Booking lifecycle ---------------- */

export interface BookingRequestInput {
  memberId: string;
  companionId: string;
  coordinatorId?: string;
  offerId: string;
  startISO: string;
  medium: Medium;
  usePackagePurchaseId?: string;
}

export function requestBooking(input: BookingRequestInput): { ok: boolean; error?: string } {
  const s = getState();
  const offer = s.offers.find((o) => o.id === input.offerId);
  if (!offer) return { ok: false, error: 'Offer not found' };

  const isTrial = offer.kind === 'trial';
  if (isTrial && !trialEligible(s.bookings, input.memberId, input.companionId)) {
    return { ok: false, error: 'A trial has already been used for this pairing.' };
  }

  const start = new Date(input.startISO);
  const end = new Date(start.getTime() + offer.durationMins * 60_000);
  if (hasConflict(s.bookings, input.companionId, start.toISOString(), end.toISOString())) {
    return { ok: false, error: 'That time has just been taken. Please pick another slot.' };
  }

  let pricePence = offer.pricePence;
  let packagePurchaseId: string | undefined;
  if (input.usePackagePurchaseId) {
    const purchase = s.purchases.find((p) => p.id === input.usePackagePurchaseId);
    if (!purchase) return { ok: false, error: 'Package not found' };
    if (availableCredits(purchase, s.bookings, new Date()) < 1) {
      return { ok: false, error: 'No package credits available.' };
    }
    pricePence = 0;
    packagePurchaseId = purchase.id;
  }

  const booking: Booking = {
    id: newId('bk'),
    memberId: input.memberId,
    companionId: input.companionId,
    coordinatorId: input.coordinatorId,
    offerId: offer.id,
    offerKind: offer.kind as OfferKind,
    packagePurchaseId,
    start: start.toISOString(),
    end: end.toISOString(),
    timeZone: 'Europe/London',
    medium: input.medium,
    durationMins: offer.durationMins,
    pricePence,
    isTrial,
    status: 'requested',
    createdAt: new Date().toISOString(),
    history: [{ at: new Date().toISOString(), event: 'Booking requested (simulated payment)' }],
  };

  setState((prev) => {
    let next: AppState = { ...prev, bookings: [...prev.bookings, booking] };
    const member = userById(prev, input.memberId);
    const requesterName = input.coordinatorId
      ? userById(prev, input.coordinatorId)?.firstName
      : member?.firstName;
    next = notify(
      next,
      input.companionId,
      'booking_requested',
      'New conversation request',
      `${requesterName ?? 'Someone'} requested a ${offer.durationMins}-minute ${isTrial ? 'trial ' : ''}conversation with ${member?.firstName ?? 'a Member'} — ${formatDateTime(booking.start)}.`,
      booking.id,
    );
    const requesterId = input.coordinatorId ?? input.memberId;
    next = notify(
      next,
      requesterId,
      'booking_requested',
      'Request sent',
      `Your request is waiting for ${userById(prev, input.companionId)?.firstName ?? 'the Companion'} to respond.`,
      booking.id,
    );
    // Non-trial paid bookings record a simulated transaction with configured commission.
    if (!packagePurchaseId && pricePence > 0) {
      const fee = computeFee(pricePence, isTrial, prev.config);
      next = {
        ...next,
        transactions: [
          ...next.transactions,
          {
            id: newId('txn'),
            kind: isTrial ? 'trial' : 'single',
            bookingId: booking.id,
            payerId: requesterId,
            companionId: input.companionId,
            grossPence: fee.grossPence,
            platformFeePence: fee.platformFeePence,
            netPence: fee.netPence,
            createdAt: new Date().toISOString(),
            simulated: true,
          },
        ],
      };
    }
    return next;
  });
  pushToast('Booking request sent (simulated payment)', 'ok');
  return { ok: true };
}

function updateBooking(
  s: AppState,
  bookingId: string,
  update: (b: Booking) => Booking,
): AppState {
  return { ...s, bookings: s.bookings.map((b) => (b.id === bookingId ? update(b) : b)) };
}

export function respondToRequest(
  bookingId: string,
  response: 'accept' | 'decline' | 'propose',
  proposedStartISO?: string,
): void {
  setState((s) => {
    const booking = s.bookings.find((b) => b.id === bookingId);
    if (!booking || booking.status !== 'requested') return s;
    const companion = userById(s, booking.companionId);
    const at = new Date().toISOString();

    if (response === 'accept') {
      assertTransition('requested', 'confirmed');
      let next = updateBooking(s, bookingId, (b) => ({
        ...b,
        status: 'confirmed',
        history: [...b.history, { at, event: `Accepted by ${companion?.firstName ?? 'Companion'}` }],
      }));
      next = notifyParties(
        next,
        booking,
        booking.companionId,
        'booking_accepted',
        'Conversation confirmed',
        `${companion?.firstName ?? 'The Companion'} accepted — ${formatDateTime(booking.start)}.`,
      );
      return next;
    }
    if (response === 'decline') {
      let next = updateBooking(s, bookingId, (b) => ({
        ...b,
        status: 'cancelled',
        cancelledBy: booking.companionId,
        cancelReason: 'Declined by Companion',
        history: [...b.history, { at, event: `Declined by ${companion?.firstName ?? 'Companion'}` }],
      }));
      next = notifyParties(
        next,
        booking,
        booking.companionId,
        'booking_declined',
        'Request declined',
        `${companion?.firstName ?? 'The Companion'} can’t make this one. Any simulated payment is refunded.`,
      );
      return next;
    }
    // propose new time
    const proposed = proposedStartISO ?? booking.start;
    let next = updateBooking(s, bookingId, (b) => ({
      ...b,
      proposedStart: proposed,
      history: [...b.history, { at, event: `New time proposed: ${formatDateTime(proposed)}` }],
    }));
    next = notifyParties(
      next,
      booking,
      booking.companionId,
      'time_proposed',
      'New time proposed',
      `${companion?.firstName ?? 'The Companion'} suggests ${formatDateTime(proposed)} instead.`,
    );
    return next;
  });
  pushToast(
    response === 'accept' ? 'Booking confirmed' : response === 'decline' ? 'Request declined' : 'New time proposed',
    response === 'decline' ? 'warn' : 'ok',
  );
}

export function acceptProposedTime(bookingId: string): void {
  setState((s) => {
    const booking = s.bookings.find((b) => b.id === bookingId);
    if (!booking?.proposedStart) return s;
    const start = booking.proposedStart;
    const end = new Date(new Date(start).getTime() + booking.durationMins * 60_000).toISOString();
    let next = updateBooking(s, bookingId, (b) => ({
      ...b,
      start,
      end,
      proposedStart: undefined,
      status: 'confirmed',
      history: [...b.history, { at: new Date().toISOString(), event: 'Proposed time accepted' }],
    }));
    next = notifyParties(next, booking, null, 'booking_accepted', 'Conversation confirmed', `Confirmed for ${formatDateTime(start)}.`);
    return next;
  });
  pushToast('New time accepted — conversation confirmed', 'ok');
}

export function rescheduleBooking(bookingId: string, newStartISO: string): { ok: boolean; error?: string } {
  const s = getState();
  const booking = s.bookings.find((b) => b.id === bookingId);
  if (!booking) return { ok: false, error: 'Booking not found' };
  const end = new Date(new Date(newStartISO).getTime() + booking.durationMins * 60_000).toISOString();
  if (hasConflict(s.bookings, booking.companionId, newStartISO, end, bookingId)) {
    return { ok: false, error: 'That time clashes with another booking.' };
  }
  setState((prev) => {
    let next = updateBooking(prev, bookingId, (b) => ({
      ...b,
      start: newStartISO,
      end,
      history: [
        ...b.history,
        { at: new Date().toISOString(), event: `Rescheduled from ${formatDateTime(b.start)} to ${formatDateTime(newStartISO)}` },
      ],
    }));
    next = notifyParties(next, booking, prev.session.currentUserId, 'booking_changed', 'Conversation rescheduled', `Now ${formatDateTime(newStartISO)}.`);
    return next;
  });
  pushToast('Conversation rescheduled', 'ok');
  return { ok: true };
}

export function cancelBooking(bookingId: string, reason: string): void {
  setState((s) => {
    const booking = s.bookings.find((b) => b.id === bookingId);
    if (!booking) return s;
    const actor = userById(s, s.session.currentUserId);
    let next = updateBooking(s, bookingId, (b) => ({
      ...b,
      status: 'cancelled',
      cancelledBy: s.session.currentUserId,
      cancelReason: reason,
      history: [...b.history, { at: new Date().toISOString(), event: `Cancelled by ${actor?.firstName ?? 'user'}` }],
    }));
    next = notifyParties(
      next,
      booking,
      s.session.currentUserId,
      'booking_cancelled',
      'Conversation cancelled',
      `${actor?.firstName ?? 'A participant'} cancelled the conversation on ${formatDateTime(booking.start)}. Any simulated payment or package credit is returned.`,
    );
    return next;
  });
  pushToast('Conversation cancelled — simulated refund issued', 'warn');
}

/* ---------------- Completion + ratings ---------------- */

export function recordOutcome(bookingId: string, userId: string, outcome: CompletionOutcome, note?: string): void {
  setState((s) => {
    const booking = s.bookings.find((b) => b.id === bookingId);
    if (!booking) return s;

    const confirmations = [
      ...s.confirmations.filter((c) => !(c.bookingId === bookingId && c.userId === userId)),
      {
        id: newId('cc'),
        bookingId,
        userId,
        outcome,
        note,
        confirmedAt: new Date().toISOString(),
      },
    ];
    let next: AppState = { ...s, confirmations };

    const { resolved, waitingFor } = reconcileCompletion(confirmations, bookingId);
    if (resolved) {
      next = updateBooking(next, bookingId, (b) => ({
        ...b,
        status: resolved,
        history: [
          ...b.history,
          {
            at: new Date().toISOString(),
            event:
              resolved === 'completed'
                ? 'Both parties confirmed completion'
                : resolved === 'missed'
                  ? 'Both parties reported the call did not happen'
                  : 'Routed to support review',
          },
        ],
      }));
      if (resolved === 'completed') {
        // Consume the package credit only now — the correct lifecycle point.
        if (booking.packagePurchaseId) {
          next = {
            ...next,
            purchases: next.purchases.map((p) =>
              p.id === booking.packagePurchaseId ? consumeCredit(p) : p,
            ),
          };
          const purchase = next.purchases.find((p) => p.id === booking.packagePurchaseId);
          if (purchase && purchase.callsTotal - purchase.callsUsed === 1) {
            next = notify(
              next,
              purchase.buyerId,
              'package_low',
              'Package running low',
              'Only one conversation remains in this package.',
            );
          }
        }
        for (const partyId of [booking.memberId, booking.coordinatorId].filter(Boolean) as string[]) {
          next = notify(
            next,
            partyId,
            'rating_reminder',
            'How was the conversation?',
            'Leave a rating to help others choose well.',
            bookingId,
          );
        }
      }
      if (resolved === 'needs_review') {
        for (const partyId of bookingParties(next, booking)) {
          next = notify(
            next,
            partyId,
            'safety',
            'A conversation needs review',
            'The outcomes did not match or a concern was raised. Our (simulated) support team will follow up.',
            bookingId,
          );
        }
      }
    } else if (waitingFor === 'other') {
      const otherId = userId === booking.memberId ? booking.companionId : booking.memberId;
      next = notify(
        next,
        otherId,
        'other_party_completed',
        'The other person responded',
        'Confirm your side to complete the conversation.',
        bookingId,
      );
    }
    return next;
  });
  const msg =
    outcome === 'completed'
      ? 'Outcome recorded — thank you'
      : outcome === 'did_not_happen'
        ? 'Recorded as not having happened'
        : 'Concern raised — routed to support';
  pushToast(msg, outcome === 'concern' ? 'warn' : 'ok');
}

export function submitRating(input: {
  reviewerId: string;
  revieweeId: string;
  bookingId: string;
  stars: number;
  publicComment?: string;
  privateFeedback?: string;
}): void {
  setState((s) => ({ ...s, ratings: upsertRating(s.ratings, input) }));
  pushToast('Rating saved — one rating per person, updated any time', 'ok');
}

/* ---------------- Packages ---------------- */

export function purchasePackage(offerId: string, memberId: string, buyerId: string): { ok: boolean; error?: string } {
  const s = getState();
  const offer = s.offers.find((o) => o.id === offerId);
  if (!offer || offer.kind !== 'package') return { ok: false, error: 'Package not found' };
  const fee = computeFee(offer.pricePence, false, s.config);
  setState((prev) => {
    let next: AppState = {
      ...prev,
      purchases: [
        ...prev.purchases,
        {
          id: newId('pp'),
          buyerId,
          memberId,
          companionId: offer.companionId,
          offerId: offer.id,
          callsTotal: offer.callCount,
          callsUsed: 0,
          purchasedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + offer.validityDays * 86_400_000).toISOString(),
          status: 'active',
          transactionRef: newId('SIM'),
        },
      ],
      transactions: [
        ...prev.transactions,
        {
          id: newId('txn'),
          kind: 'package',
          payerId: buyerId,
          companionId: offer.companionId,
          grossPence: fee.grossPence,
          platformFeePence: fee.platformFeePence,
          netPence: fee.netPence,
          createdAt: new Date().toISOString(),
          simulated: true,
        },
      ],
    };
    next = notify(
      next,
      offer.companionId,
      'booking_requested',
      'Package purchased (simulated)',
      `${userById(prev, buyerId)?.firstName ?? 'Someone'} bought “${offer.title}” for ${userById(prev, memberId)?.firstName ?? 'a Member'}.`,
    );
    return next;
  });
  pushToast('Package purchased (simulated) — credits added', 'ok');
  return { ok: true };
}

/* ---------------- Favourites, notifications, settings, safety ---------------- */

export function toggleFavourite(profileId: string): void {
  setState((s) => {
    const mine = s.favourites[s.session.currentUserId] ?? [];
    const next = mine.includes(profileId) ? mine.filter((id) => id !== profileId) : [...mine, profileId];
    return { ...s, favourites: { ...s.favourites, [s.session.currentUserId]: next } };
  });
}

export function markNotificationRead(id: string, read = true): void {
  setState((s) => ({
    ...s,
    notifications: s.notifications.map((n) => (n.id === id ? { ...n, read } : n)),
  }));
}

export function markAllNotificationsRead(): void {
  setState((s) => ({
    ...s,
    notifications: s.notifications.map((n) =>
      n.userId === s.session.currentUserId ? { ...n, read: true } : n,
    ),
  }));
}

export function saveSettings(settings: UserSettings): void {
  setState((s) => ({
    ...s,
    settings: [...s.settings.filter((x) => x.userId !== settings.userId), settings],
  }));
}

export function updateProfile(userId: string, patch: Partial<import('../types').User>): void {
  setState((s) => ({
    ...s,
    users: s.users.map((u) => (u.id === userId ? { ...u, ...patch } : u)),
  }));
  pushToast('Profile updated', 'ok');
}

export function blockUser(blockedId: string): void {
  setState((s) => {
    const base =
      s.settings.find((x) => x.userId === s.session.currentUserId) ??
      require_default(s.session.currentUserId);
    return {
      ...s,
      settings: [
        ...s.settings.filter((x) => x.userId !== s.session.currentUserId),
        { ...base, blockedUserIds: [...new Set([...(base.blockedUserIds ?? []), blockedId])] },
      ],
    };
  });
  pushToast('User blocked — they can no longer contact you in this prototype', 'warn');
}

// Local helper to avoid circular import with selectors.
function require_default(userId: string): UserSettings {
  return {
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
  };
}

export function reportUser(reportedUserId: string, category: string, details: string, bookingId?: string): void {
  setState((s) => ({
    ...s,
    reports: [
      ...s.reports,
      {
        id: newId('rep'),
        reporterId: s.session.currentUserId,
        reportedUserId,
        bookingId,
        category,
        details,
        status: 'open',
        createdAt: new Date().toISOString(),
      },
    ],
  }));
  pushToast('Report submitted — a (simulated) reviewer will look at it', 'warn');
}
