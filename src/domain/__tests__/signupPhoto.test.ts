/**
 * Block 2 — the profile photo chosen in the wizard is persisted as the new
 * profile's avatar on Supabase signup completion (previously dropped).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const uploadAvatar = vi.fn();
const rpc = vi.fn();

vi.mock('../../supabase/client', () => ({ getSupabaseClient: () => ({ rpc }) }));
vi.mock('../../repositories/profileRepository', () => ({ uploadAvatar: (...a: unknown[]) => uploadAvatar(...a) }));
vi.mock('../../repositories/availabilityRepository', () => ({
  createOffer: vi.fn(),
  poundsToMinor: (p: string) => Math.round(Number(p) * 100),
  replaceAvailabilityRules: vi.fn(),
  updateCompanionSchedulingSettings: vi.fn(),
}));

import { completeSupabaseSignup, dataUrlToFile } from '../../signup/completeSupabase';
import type { SignupData } from '../../signup/types';

// 1x1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

beforeEach(() => { uploadAvatar.mockReset().mockResolvedValue('path/x.png'); rpc.mockReset(); });
afterEach(() => vi.clearAllMocks());

describe('dataUrlToFile', () => {
  it('decodes a base64 image data URL into a typed File', () => {
    const f = dataUrlToFile(PNG);
    expect(f).toBeInstanceOf(File);
    expect(f!.type).toBe('image/png');
    expect(f!.name.endsWith('.png')).toBe(true);
    expect(f!.size).toBeGreaterThan(0);
  });

  it('returns null for non-image or malformed input', () => {
    expect(dataUrlToFile('')).toBeNull();
    expect(dataUrlToFile('not-a-data-url')).toBeNull();
    expect(dataUrlToFile('data:text/plain;base64,aGVsbG8=')).toBeNull();
  });
});

describe('completeSupabaseSignup avatar persistence', () => {
  // Minimal but complete-enough member data for buildMemberPayload.
  const member = (photo?: string): SignupData => ({
    role: 'member', firstName: 'A', lastName: 'B', town: 'Leeds', headline: 'h',
    bio: 'b', ageRange: '', dob: '', email: 'a@example.test', phone: '', languages: [],
    mediums: [], durationMins: 30, flexible: true, days: [], dayparts: [], personality: '',
    sameCompanion: '', topicsAvoid: '', interests: [], photoDataUrl: photo ?? '',
  } as unknown as SignupData);

  it('uploads the chosen photo to the new profile', async () => {
    rpc.mockResolvedValue({ data: { id: 'm1' }, error: null });
    await completeSupabaseSignup(member(PNG));
    expect(uploadAvatar).toHaveBeenCalledTimes(1);
    const [profileId, file] = uploadAvatar.mock.calls[0];
    expect(profileId).toBe('m1');
    expect(file).toBeInstanceOf(File);
  });

  it('does not upload when no photo was chosen', async () => {
    rpc.mockResolvedValue({ data: { id: 'm1' }, error: null });
    await completeSupabaseSignup(member());
    expect(uploadAvatar).not.toHaveBeenCalled();
  });

  it('never blocks signup if the avatar upload fails', async () => {
    rpc.mockResolvedValue({ data: { id: 'm1' }, error: null });
    uploadAvatar.mockRejectedValue(new Error('storage down'));
    const result = await completeSupabaseSignup(member(PNG));
    expect(result.primaryId).toBe('m1');
  });
});
