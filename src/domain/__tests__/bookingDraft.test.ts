// @vitest-environment jsdom
/**
 * Block 9 — durable booking-draft store: owner-binding, expiry, terminal
 * clearing, and rejection of malformed/foreign drafts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOKING_DRAFT_KEY,
  clearBookingDraft,
  hasResumableBookingDraft,
  loadBookingDraft,
  saveBookingDraft,
} from '../../payments/bookingDraft';

const A = '00000000-0000-4000-8000-0000000000a1'; // account A
const B = '00000000-0000-4000-8000-0000000000b2'; // account B
const C = '00000000-0000-4000-8000-0000000000c3'; // companion
const M = '00000000-0000-4000-8000-0000000000d4'; // member
const O = '00000000-0000-4000-8000-0000000000e5'; // offer

const good = { accountId: A, companionId: C, memberId: M, offerId: O, offerType: 'single', startsAt: '2099-01-01T10:00:00.000Z' };

beforeEach(() => { localStorage.clear(); vi.useRealTimers(); });
afterEach(() => { localStorage.clear(); vi.useRealTimers(); });

describe('bookingDraft', () => {
  it('round-trips a draft for its owner', () => {
    saveBookingDraft(good);
    const d = loadBookingDraft(A);
    expect(d).toMatchObject({ companionId: C, memberId: M, offerId: O, offerType: 'single', startsAt: good.startsAt });
    expect(hasResumableBookingDraft(A, C)).toBe(true);
  });

  it('is owner-bound: a different account never sees the draft', () => {
    saveBookingDraft(good);
    expect(loadBookingDraft(B)).toBeNull();
    expect(hasResumableBookingDraft(B, C)).toBe(false);
    // But the draft is not destroyed by a foreign read — the owner still has it.
    expect(loadBookingDraft(A)).not.toBeNull();
  });

  it('only resumes for the matching companion', () => {
    saveBookingDraft(good);
    expect(hasResumableBookingDraft(A, '00000000-0000-4000-8000-0000000000ff')).toBe(false);
  });

  it('expires after the draft window and clears itself', () => {
    saveBookingDraft(good);
    // 31 minutes later (window is 30).
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    expect(loadBookingDraft(A)).toBeNull();
    expect(localStorage.getItem(BOOKING_DRAFT_KEY)).toBeNull();
  });

  it('clear() makes the draft terminal (cannot be replayed)', () => {
    saveBookingDraft(good);
    clearBookingDraft();
    expect(loadBookingDraft(A)).toBeNull();
  });

  it('rejects and discards a malformed draft', () => {
    localStorage.setItem(BOOKING_DRAFT_KEY, JSON.stringify({ v: 1, accountId: A, companionId: 'nope' }));
    expect(loadBookingDraft(A)).toBeNull();
    expect(localStorage.getItem(BOOKING_DRAFT_KEY)).toBeNull();
  });

  it('refuses to save an incomplete draft', () => {
    saveBookingDraft({ ...good, offerId: 'not-a-uuid' });
    expect(localStorage.getItem(BOOKING_DRAFT_KEY)).toBeNull();
  });
});
