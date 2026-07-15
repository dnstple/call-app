// @vitest-environment jsdom
/**
 * Stage 2C2 unit tests — window validation, timezone/DST handling, money in
 * minor units, fee previews, signup mapping and marketplace field mapping.
 */
import { describe, expect, it } from 'vitest';
import {
  daypartsForWindow,
  isValidTimezone,
  toHHMM,
  validateWindows,
  wallTimeToUtc,
  windowInViewerTz,
} from '../../domain/timezones';
import {
  calculateFeePreview,
  formatMinor,
  poundsToMinor,
  validateOfferInput,
} from '../../repositories/availabilityRepository';
import { noticeHours, wizardWindows } from '../../signup/completeSupabase';
import { companionRowToUser, getMarketMeta } from '../../repositories/profileRepository';
import { EMPTY_SIGNUP } from '../../signup/types';
import type { DiscoverableCompanionRow } from '../../supabase/database.types';

describe('availability window validation', () => {
  it('accepts multiple valid windows on one day', () => {
    expect(
      validateWindows([
        { day: 1, start: '09:00', end: '12:00' },
        { day: 1, start: '15:00', end: '18:00' },
      ]),
    ).toBeNull();
  });

  it('accepts adjacent windows as separate (documented behaviour)', () => {
    expect(
      validateWindows([
        { day: 1, start: '09:00', end: '12:00' },
        { day: 1, start: '12:00', end: '15:00' },
      ]),
    ).toBeNull();
  });

  it('rejects overlapping windows', () => {
    expect(
      validateWindows([
        { day: 1, start: '09:00', end: '12:00' },
        { day: 1, start: '11:30', end: '14:00' },
      ]),
    ).toMatch(/overlap/i);
    expect(
      validateWindows([
        { day: 2, start: '10:00', end: '11:00' },
        { day: 2, start: '10:00', end: '12:00' },
      ]),
    ).toMatch(/overlap/i);
  });

  it('rejects invalid ranges and days', () => {
    expect(validateWindows([{ day: 1, start: '14:00', end: '12:00' }])).toMatch(/start before/i);
    expect(validateWindows([{ day: 1, start: '10:00', end: '10:00' }])).toMatch(/start before/i);
    expect(validateWindows([{ day: 0, start: '09:00', end: '10:00' }])).toMatch(/day/i);
    expect(validateWindows([{ day: 8, start: '09:00', end: '10:00' }])).toMatch(/day/i);
  });

  it('windows on different days never clash', () => {
    expect(
      validateWindows([
        { day: 1, start: '09:00', end: '12:00' },
        { day: 2, start: '09:00', end: '12:00' },
      ]),
    ).toBeNull();
  });
});

describe('timezone handling (Intl-based, DST-safe)', () => {
  it('validates IANA names and rejects junk', () => {
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Bogus/Nowhere')).toBe(false);
    expect(isValidTimezone('GMT+whatever')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });

  it('converts London wall time across the DST boundary correctly', () => {
    // 2026-03-28 is GMT (UTC+0); 2026-03-30 is BST (UTC+1). DST change 29 March 2026.
    const beforeDst = wallTimeToUtc(2026, 3, 28, 9, 0, 'Europe/London');
    expect(beforeDst.toISOString()).toBe('2026-03-28T09:00:00.000Z');
    const afterDst = wallTimeToUtc(2026, 3, 30, 9, 0, 'Europe/London');
    expect(afterDst.toISOString()).toBe('2026-03-30T08:00:00.000Z');
  });

  it('shows a companion window in a different viewer timezone', () => {
    // London 09:00–12:00 viewed from Paris = 10:00–13:00 year-round.
    const v = windowInViewerTz(1, '09:00', '12:00', 'Europe/London', 'Europe/Paris');
    expect(v.start).toBe('10:00');
    expect(v.end).toBe('13:00');
    expect(v.sameAsLocal).toBe(false);
  });

  it('same timezone shows identical times', () => {
    const v = windowInViewerTz(3, '14:00', '17:00', 'Europe/London', 'Europe/London');
    expect(v.start).toBe('14:00');
    expect(v.end).toBe('17:00');
    expect(v.sameAsLocal).toBe(true);
  });

  it('throws on invalid timezone input', () => {
    expect(() => wallTimeToUtc(2026, 1, 1, 9, 0, 'Not/AZone')).toThrow(/Invalid timezone/);
  });

  it('classifies dayparts consistently with the database view', () => {
    expect(daypartsForWindow('09:00', '11:00')).toEqual(['morning']);
    expect(daypartsForWindow('13:00', '16:00')).toEqual(['afternoon']);
    expect(daypartsForWindow('18:00', '21:00')).toEqual(['evening']);
    expect(daypartsForWindow('09:00', '21:00')).toEqual(['morning', 'afternoon', 'evening']);
    expect(toHHMM('09:30:00')).toBe('09:30');
  });
});

describe('money in integer minor units', () => {
  it('converts pounds to minor units exactly', () => {
    expect(poundsToMinor('5')).toBe(500);
    expect(poundsToMinor('12.50')).toBe(1250);
    expect(poundsToMinor(9.99)).toBe(999);
    expect(poundsToMinor('0.1')).toBe(10); // no floating-point drift
  });

  it('formats minor units as GBP', () => {
    expect(formatMinor(500)).toContain('5.00');
    expect(formatMinor(1250)).toContain('12.50');
  });

  it('rejects invalid offer prices and durations', () => {
    expect(validateOfferInput({ durationMinutes: 30, priceMinor: 0 })).toMatch(/minimum/i);
    expect(validateOfferInput({ durationMinutes: 30, priceMinor: -500 })).toMatch(/minimum/i);
    expect(validateOfferInput({ durationMinutes: 30, priceMinor: 200000 })).toMatch(/maximum/i);
    expect(validateOfferInput({ durationMinutes: 20, priceMinor: 1000 })).toMatch(/15, 30, 45 or 60/);
    expect(validateOfferInput({ durationMinutes: 30, priceMinor: 1000 })).toBeNull();
  });
});

describe('fee previews (estimates only — payments not enabled)', () => {
  const rates = { trialPct: 0, standardPct: 2 };

  it('trial preview uses 0%', () => {
    const f = calculateFeePreview(500, 'trial', rates);
    expect(f.feeMinor).toBe(0);
    expect(f.companionMinor).toBe(500);
    expect(f.estimate).toBe(true);
  });

  it('standard preview uses 2% (the £10 example)', () => {
    const f = calculateFeePreview(1000, 'single', rates);
    expect(f.feeMinor).toBe(20); // £0.20
    expect(f.companionMinor).toBe(980); // £9.80
  });

  it('rates come from configuration, not hard-coding', () => {
    const f = calculateFeePreview(1000, 'single', { trialPct: 0, standardPct: 10 });
    expect(f.feeMinor).toBe(100);
  });
});

describe('companion signup → availability/offer mapping', () => {
  it('maps wizard days and dayparts to ISO windows', () => {
    const windows = wizardWindows({
      ...EMPTY_SIGNUP,
      days: ['Monday', 'Saturday'],
      dayparts: ['Morning', 'Evening'],
    });
    expect(windows).toContainEqual({ day: 1, start: '09:00', end: '12:00' });
    expect(windows).toContainEqual({ day: 1, start: '18:00', end: '21:00' });
    expect(windows).toContainEqual({ day: 6, start: '09:00', end: '12:00' });
    expect(validateWindows(windows)).toBeNull(); // never produces overlaps
  });

  it('flexible availability produces no fixed windows', () => {
    expect(wizardWindows({ ...EMPTY_SIGNUP, flexible: true, days: ['Monday'] })).toEqual([]);
  });

  it('parses minimum notice safely', () => {
    expect(noticeHours('24 hours')).toBe(24);
    expect(noticeHours('12 hours')).toBe(12);
    expect(noticeHours('garbage')).toBe(24);
  });
});

describe('marketplace mapping exposes real pricing fields safely', () => {
  const row: DiscoverableCompanionRow = {
    id: 'comp-x',
    first_name: 'Oliver',
    last_initial: 'R',
    headline: 'Hi',
    bio: '',
    region: 'Sheffield',
    age_band: '20s',
    languages: ['English'],
    mediums: ['phone'],
    style: 'relaxed',
    avatar_path: null,
    photo_url: null,
    joined_at: '2026-01-01T00:00:00Z',
    conversation_style: [],
    is_accepting_new_members: true,
    verification_status: 'pending_review',
    profile_completion_percentage: 70,
    timezone: 'Europe/London',
    minimum_notice_hours: 24,
    booking_horizon_days: 60,
    interest_names: ['Sport'],
    trial_price_minor: 500,
    trial_duration_minutes: 30,
    min_single_price_minor: 1000,
    single_durations: [30, 60],
    available_days: [1, 3],
    available_dayparts: ['morning', 'evening'],
  };

  it('carries genuine market fields and never mock prices', () => {
    const user = companionRowToUser(row);
    const meta = getMarketMeta(user.id)!;
    expect(meta.trialPriceMinor).toBe(500);
    expect(meta.minSinglePriceMinor).toBe(1000);
    expect(meta.availableDays).toEqual([1, 3]);
    expect(user.email).toBe(''); // still no private data
  });
});
