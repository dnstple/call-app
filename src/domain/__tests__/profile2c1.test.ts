// @vitest-environment jsdom
/**
 * Stage 2C1 unit tests — payload builders, public mapping safety, avatar
 * validation and optimistic favourites rollback.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildCompanionPayload,
  buildCoordinatorPayload,
  buildMemberPayload,
  interestsToSlugs,
  methodsToDb,
} from '../../signup/completeSupabase';
import {
  companionRowToUser,
  sanitisePublicPatch,
  validateAvatarFile,
} from '../../repositories/profileRepository';
import {
  ensureFavouritesLoaded,
  isFavouriteId,
  persistence,
  resetFavourites,
  toggleFavouriteSupabase,
} from '../../state/favourites';
import { EMPTY_SIGNUP, type SignupData } from '../../signup/types';
import type { DiscoverableCompanionRow } from '../../supabase/database.types';

const base: SignupData = {
  ...EMPTY_SIGNUP,
  firstName: ' Dorothy ',
  lastName: 'Fletcher',
  town: 'Harrogate',
  interests: ['Gardening', 'Films and television', 'Faith and community'],
  mediums: ['Phone call', 'WhatsApp'],
  durationMins: 45,
  days: ['Tuesday'],
  dayparts: ['Morning'],
  sameCompanion: 'Yes, the same person',
  topicsAvoid: 'Politics',
};

describe('signup payload builders', () => {
  it('maps member data to the database input', () => {
    const p = buildMemberPayload({ ...base, role: 'member', ageRange: '80s' });
    expect(p.p_first_name).toBe('Dorothy');
    expect(p.p_age_band).toBe('80s');
    expect(p.p_methods).toEqual(['in_app']); // every conversation happens in the app
    expect(p.p_duration).toBe(45);
    expect(p.p_regular_companion).toBe(true);
    expect(p.p_topics_to_avoid).toEqual(['Politics']);
    expect(p.p_interest_slugs).toContain('films-and-television');
    expect(p.p_interest_slugs).toContain('faith-and-community');
  });

  it('flexible availability clears days and dayparts', () => {
    const p = buildMemberPayload({ ...base, role: 'member', flexible: true });
    expect(p.p_days).toEqual([]);
    expect(p.p_dayparts).toEqual([]);
  });

  it('maps companion data including DOB', () => {
    const p = buildCompanionPayload({ ...base, role: 'companion', dob: '1996-04-12', headline: 'Hi', bio: 'Bio' });
    expect(p.p_date_of_birth).toBe('1996-04-12');
    expect(p.p_accepting).toBe(true);
    expect(p.p_interest_slugs).toHaveLength(3);
  });

  it('maps coordinator + managed member data', () => {
    const p = buildCoordinatorPayload({
      ...base,
      role: 'coordinator',
      memberFirstName: 'Mum',
      memberAgeRange: '80s',
      relationship: 'Child',
      permKnows: true,
      permAgreed: true,
      permManage: true,
    });
    expect(p.p_consent_confirmed).toBe(true);
    expect(p.p_member_first_name).toBe('Mum');
    expect(p.p_member_age_band).toBe('80s');
    expect(p.p_member_interest_slugs).toContain('gardening');
  });

  it('interest slugs are catalogue-normalised', () => {
    expect(interestsToSlugs({ ...EMPTY_SIGNUP, interests: ['Local news', 'Current affairs'] })).toEqual([
      'local-news',
      'current-affairs',
    ]);
    expect(methodsToDb(['FaceTime', 'Another method'])).toEqual(['in_app']); // legacy labels collapse to in_app
  });
});

describe('public companion mapping omits private fields', () => {
  const row: DiscoverableCompanionRow = {
    id: 'p1',
    first_name: 'Oliver',
    last_initial: 'R',
    headline: 'Cricket fan',
    bio: 'Hello',
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
    trial_price_minor: null,
    trial_duration_minutes: null,
    min_single_price_minor: null,
    single_durations: [],
    available_days: [],
    available_dayparts: [],
  };

  it('exposes only safe fields', () => {
    const u = companionRowToUser(row);
    expect(u.email).toBe('');
    expect(u.phone).toBe('');
    expect(u.lastName).toBe('R'); // initial only
    expect(u.verification).toBe('pending'); // never verified without a process
    expect(u.interests).toEqual(['Sport']);
  });
});

describe('public patch sanitiser', () => {
  it('drops protected fields from update requests', () => {
    const safe = sanitisePublicPatch({
      headline: 'New',
      verification: 'verified',
      profile_status: 'active',
      role: 'companion',
      visibility: 'public',
      avatar_path: 'x/evil.png',
    });
    expect(safe).toEqual({ headline: 'New' });
  });
});

describe('avatar validation', () => {
  it('rejects invalid MIME types', () => {
    expect(validateAvatarFile({ size: 1000, type: 'image/gif' })).toMatch(/JPEG, PNG or WebP/);
    expect(validateAvatarFile({ size: 1000, type: 'application/pdf' })).not.toBeNull();
  });
  it('rejects oversized files', () => {
    expect(validateAvatarFile({ size: 5 * 1024 * 1024, type: 'image/png' })).toMatch(/under 4 MB/);
  });
  it('accepts a valid image', () => {
    expect(validateAvatarFile({ size: 500_000, type: 'image/jpeg' })).toBeNull();
  });
});

describe('favourites store (optimistic with rollback)', () => {
  const original = { ...persistence };
  beforeEach(() => {
    resetFavourites();
    persistence.load = original.load;
    persistence.add = original.add;
    persistence.remove = original.remove;
  });

  it('loads favourites for the current account', async () => {
    persistence.load = async () => ['a', 'b'];
    await ensureFavouritesLoaded();
    expect(isFavouriteId('a')).toBe(true);
    expect(isFavouriteId('c')).toBe(false);
  });

  it('add persists optimistically', async () => {
    persistence.load = async () => [];
    let saved: string | null = null;
    persistence.add = async (id) => {
      saved = id;
    };
    await ensureFavouritesLoaded();
    await toggleFavouriteSupabase('x');
    expect(isFavouriteId('x')).toBe(true);
    expect(saved).toBe('x');
  });

  it('rolls back when persistence fails', async () => {
    persistence.load = async () => [];
    persistence.add = async () => {
      throw new Error('nope');
    };
    await ensureFavouritesLoaded();
    await toggleFavouriteSupabase('x');
    expect(isFavouriteId('x')).toBe(false); // rolled back
  });

  it('remove rolls back on failure', async () => {
    persistence.load = async () => ['x'];
    persistence.remove = async () => {
      throw new Error('nope');
    };
    await ensureFavouritesLoaded();
    await toggleFavouriteSupabase('x');
    expect(isFavouriteId('x')).toBe(true); // rolled back to favourited
  });
});
