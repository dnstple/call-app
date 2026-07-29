/**
 * Block 9 — durable booking draft (payment-method-first booking).
 *
 * When a member starts a paid booking but has no saved card, we send them to
 * Stripe's hosted setup page. That is a full-page redirect, so the wizard's
 * in-memory selections would be lost. This persists ONLY the safe *selections*
 * (which companion, which member, which offer, what time) so the exact wizard
 * can be reopened on return.
 *
 * Deliberately NOT stored: prices, fees, eligibility, payment-method ids, or
 * any completion/authority state. Every one of those is re-derived and
 * re-validated server-side when the real order is finally created — the draft
 * is a convenience for the UI, never a source of truth.
 *
 * Safety properties:
 *  - Owner-bound: a draft is only returned to the same authenticated account
 *    that saved it (accountId match), so a shared browser never leaks one
 *    person's draft to another.
 *  - Expiring: drafts older than the order window are discarded.
 *  - Terminal: cleared the moment a booking is actually placed, so a stale
 *    draft can never be replayed.
 *  - It creates no orders and reserves nothing; duplicate-order protection
 *    lives entirely in the server-side idempotency key at order creation.
 */

export interface BookingDraft {
  v: 1;
  /** The authenticated account that owns this draft (owner-binding). */
  accountId: string;
  companionId: string;
  memberId: string;
  offerId: string;
  offerType: string;
  /** Chosen slot start (UTC ISO). Availability is re-validated server-side. */
  startsAt: string;
  createdAt: string;
}

export const BOOKING_DRAFT_KEY = 'callapp.booking.draft.v1';

// Paid-request orders expire server-side after 30 minutes; a draft is only a
// UI convenience, so a matching 30-minute window keeps it from ever outliving
// the pricing/eligibility it was based on.
export const BOOKING_DRAFT_MAX_AGE_MS = 30 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null; // private mode / disabled — degrade gracefully (no draft)
  }
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function saveBookingDraft(input: {
  accountId: string;
  companionId: string;
  memberId: string;
  offerId: string;
  offerType: string;
  startsAt: string;
}): void {
  const s = storage();
  if (!s) return;
  // Never persist a partial/invalid draft — a broken one must not resurface.
  if (!isId(input.accountId) || !isId(input.companionId) || !isId(input.memberId) || !isId(input.offerId)) return;
  if (typeof input.startsAt !== 'string' || Number.isNaN(Date.parse(input.startsAt))) return;
  const draft: BookingDraft = {
    v: 1,
    accountId: input.accountId,
    companionId: input.companionId,
    memberId: input.memberId,
    offerId: input.offerId,
    offerType: String(input.offerType || 'single'),
    startsAt: input.startsAt,
    createdAt: new Date().toISOString(),
  };
  try {
    s.setItem(BOOKING_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* quota/full — the booking simply won't auto-resume; no harm done */
  }
}

/**
 * Return the saved draft ONLY if it belongs to `accountId` and is still fresh.
 * A malformed, foreign-owned, or expired draft is discarded and null returned,
 * so a stale or someone-else's draft can never drive a booking.
 */
export function loadBookingDraft(accountId: string): BookingDraft | null {
  const s = storage();
  if (!s || !isId(accountId)) return null;
  const raw = s.getItem(BOOKING_DRAFT_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<BookingDraft>;
    if (
      p.v !== 1 ||
      !isId(p.accountId) || !isId(p.companionId) || !isId(p.memberId) || !isId(p.offerId) ||
      typeof p.startsAt !== 'string' || typeof p.createdAt !== 'string'
    ) {
      clearBookingDraft();
      return null;
    }
    // Owner-binding: never hand a draft to a different account.
    if (p.accountId !== accountId) return null;
    const age = Date.now() - Date.parse(p.createdAt);
    if (!Number.isFinite(age) || age < 0 || age > BOOKING_DRAFT_MAX_AGE_MS) {
      clearBookingDraft();
      return null;
    }
    return p as BookingDraft;
  } catch {
    clearBookingDraft();
    return null;
  }
}

/** True when the current account has a fresh draft for a specific companion. */
export function hasResumableBookingDraft(accountId: string, companionId: string): boolean {
  const d = loadBookingDraft(accountId);
  return !!d && d.companionId === companionId;
}

export function clearBookingDraft(): void {
  const s = storage();
  try {
    s?.removeItem(BOOKING_DRAFT_KEY);
  } catch {
    /* ignore */
  }
}
