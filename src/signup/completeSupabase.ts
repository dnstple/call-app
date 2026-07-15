/**
 * Supabase-mode signup completion — persists the COMPLETE signup payload for
 * each role through the Stage 2C1 database functions. The owner is always
 * derived server-side from auth.uid(); passwords never pass through here.
 */
import { getSupabaseClient } from '../supabase/client';
import { mapAuthError } from '../auth/authErrors';
import type { SignupData } from './types';
import type { CreatedAccounts } from './complete';
import {
  createOffer,
  poundsToMinor,
  replaceAvailabilityRules,
  updateCompanionSchedulingSettings,
} from '../repositories/availabilityRepository';
import { browserTimezone, type WindowInput } from '../domain/timezones';

const MEDIUM_MAP: Record<string, string> = {
  'Phone call': 'phone',
  WhatsApp: 'whatsapp',
  FaceTime: 'facetime',
  Zoom: 'zoom',
  'Google Meet': 'meet',
  'Another method': 'other',
};

export function methodsToDb(labels: string[]): string[] {
  const mapped = labels.map((l) => MEDIUM_MAP[l] ?? 'other');
  return mapped.length > 0 ? [...new Set(mapped)] : ['phone'];
}

/** Interests persist through the controlled catalogue by slug. Custom
 * free-text interests are not in the catalogue and are deliberately not
 * stored in Stage 2C1 (documented limitation). */
export function interestsToSlugs(data: SignupData): string[] {
  return data.interests.map((name) =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  );
}

export function stylePrefs(data: SignupData): string[] {
  return data.personality ? [data.personality] : [];
}

/** Build the exact RPC payloads (exported for tests). */
export function buildMemberPayload(data: SignupData) {
  return {
    p_first_name: data.firstName.trim(),
    p_last_name: data.lastName.trim(),
    p_region: data.town.trim(),
    p_headline: data.headline.trim(),
    p_bio: data.bio.trim(),
    p_age_band: data.ageRange && data.ageRange !== 'Prefer not to say' ? data.ageRange : '',
    p_date_of_birth: data.dob || null,
    p_email: data.email.trim(),
    p_phone: data.phone.trim(),
    p_languages: data.languages.length > 0 ? data.languages : ['English'],
    p_methods: methodsToDb(data.mediums),
    p_duration: data.durationMins,
    p_days: data.flexible ? [] : data.days,
    p_dayparts: data.flexible ? [] : data.dayparts,
    p_style_prefs: stylePrefs(data),
    p_regular_companion:
      data.sameCompanion === 'Yes, the same person' ? true : data.sameCompanion === 'Happy to vary' ? false : null,
    p_topics_to_avoid: data.topicsAvoid.trim() ? [data.topicsAvoid.trim()] : [],
    p_interest_slugs: interestsToSlugs(data),
  };
}

export function buildCompanionPayload(data: SignupData) {
  return {
    p_first_name: data.firstName.trim(),
    p_last_name: data.lastName.trim(),
    p_region: data.town.trim(),
    p_headline: data.headline.trim(),
    p_bio: data.bio.trim(),
    p_date_of_birth: data.dob || null,
    p_email: data.email.trim(),
    p_phone: data.phone.trim(),
    p_languages: data.languages.length > 0 ? data.languages : ['English'],
    p_methods: methodsToDb(data.mediums),
    p_style: [],
    p_accepting: true,
    p_interest_slugs: interestsToSlugs(data),
  };
}

export function buildCoordinatorPayload(data: SignupData) {
  return {
    p_first_name: data.firstName.trim(),
    p_last_name: data.lastName.trim(),
    p_region: data.town.trim(),
    p_email: data.email.trim(),
    p_phone: data.phone.trim(),
    p_relationship: data.relationship || 'Trusted person',
    p_consent_confirmed: data.permKnows && data.permAgreed && data.permManage,
    p_member_first_name: data.memberFirstName.trim(),
    p_member_last_name: data.memberLastName.trim(),
    p_member_region: data.memberTown.trim(),
    p_member_age_band: data.memberAgeRange,
    p_member_dob: data.memberDob || null,
    p_member_languages: data.languages.length > 0 ? data.languages : ['English'],
    p_member_methods: methodsToDb(data.mediums),
    p_member_duration: data.durationMins,
    p_member_days: data.flexible ? [] : data.days,
    p_member_dayparts: data.flexible ? [] : data.dayparts,
    p_member_style_prefs: stylePrefs(data),
    p_member_regular:
      data.sameCompanion === 'Yes, the same person' ? true : data.sameCompanion === 'Happy to vary' ? false : null,
    p_member_topics_to_avoid: data.topicsAvoid.trim() ? [data.topicsAvoid.trim()] : [],
    p_member_interest_slugs: interestsToSlugs(data),
  };
}

export async function completeSupabaseSignup(data: SignupData): Promise<CreatedAccounts> {
  const client = getSupabaseClient();
  const role = data.role;
  if (!role) throw mapAuthError({ message: 'missing role' }, 'completeSignup');

  if (role === 'member') {
    const { data: profile, error } = await client.rpc('complete_member_signup', buildMemberPayload(data));
    if (error) throw friendly(error);
    return { primaryId: profile.id };
  }

  if (role === 'companion') {
    const { data: profile, error } = await client.rpc('complete_companion_signup', buildCompanionPayload(data));
    if (error) throw friendly(error);
    // Stage 2C2: availability, scheduling settings and offers now persist.
    // If this step fails, the profile still exists — record a recoverable
    // "finish setup" state instead of hiding the failure or blocking signup.
    try {
      await persistCompanionSetup(profile.id, data);
      clearSetupIncomplete(profile.id);
    } catch {
      markSetupIncomplete(profile.id);
    }
    return { primaryId: profile.id };
  }

  const { data: result, error } = await client.rpc('complete_coordinator_signup', buildCoordinatorPayload(data));
  if (error) throw friendly(error);
  const r = result as { member_profile_id: string; coordinator_profile_id: string };
  return { primaryId: r.coordinator_profile_id, memberId: r.member_profile_id };
}

/* ---------------- Companion setup (Stage 2C2) ---------------- */

const DAYPART_WINDOWS: Record<string, { start: string; end: string }> = {
  Morning: { start: '09:00', end: '12:00' },
  Afternoon: { start: '14:00', end: '17:00' },
  Evening: { start: '18:00', end: '21:00' },
};

const ISO_DAY: Record<string, number> = {
  Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7,
};

/** Wizard days + dayparts → recurring windows (exported for tests). */
export function wizardWindows(data: SignupData): WindowInput[] {
  if (data.flexible) return [];
  const windows: WindowInput[] = [];
  for (const day of data.days) {
    const iso = ISO_DAY[day];
    if (!iso) continue;
    const parts = data.dayparts.length > 0 ? data.dayparts : ['Morning'];
    for (const part of parts) {
      const w = DAYPART_WINDOWS[part];
      if (w) windows.push({ day: iso, start: w.start, end: w.end });
    }
  }
  return windows;
}

export function noticeHours(noticePeriod: string): number {
  const n = parseInt(noticePeriod, 10);
  return Number.isFinite(n) && n >= 0 && n <= 336 ? n : 24;
}

async function persistCompanionSetup(profileId: string, data: SignupData): Promise<void> {
  const timezone = browserTimezone();
  await replaceAvailabilityRules(profileId, timezone, wizardWindows(data));
  await updateCompanionSchedulingSettings(profileId, {
    // The wizard doesn't ask for notice; sensible default, editable later
    // in Profile → Availability & rates.
    minimumNoticeHours: 24,
    bookingHorizonDays: 60,
    acceptingNewMembers: true,
  });
  const methods = methodsToDb(data.mediums);
  const trialMinor = poundsToMinor(data.trialPrice);
  if (Number.isFinite(trialMinor) && trialMinor >= 100) {
    await createOffer(profileId, 'trial', {
      durationMinutes: 30,
      priceMinor: trialMinor,
      supportedMethods: methods,
    });
  }
  const singleMinor = poundsToMinor(data.standardPrice);
  if (Number.isFinite(singleMinor) && singleMinor >= 100) {
    await createOffer(profileId, 'single', {
      durationMinutes: 30,
      priceMinor: singleMinor,
      supportedMethods: methods,
    });
  }
}

/** Recoverable "finish setting up availability and rates" state. */
const SETUP_KEY = (profileId: string) => `companionship-setup-incomplete:${profileId}`;

export function markSetupIncomplete(profileId: string): void {
  try {
    localStorage.setItem(SETUP_KEY(profileId), '1');
  } catch { /* ignore */ }
}

export function clearSetupIncomplete(profileId: string): void {
  try {
    localStorage.removeItem(SETUP_KEY(profileId));
  } catch { /* ignore */ }
}

export function needsCompanionSetup(profileId: string): boolean {
  try {
    return localStorage.getItem(SETUP_KEY(profileId)) === '1';
  } catch {
    return false;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function friendly(error: any) {
  const mapped = mapAuthError(error, 'completeSignup');
  const msg = String(error?.message ?? '');
  if (msg.includes('already has')) mapped.message = 'This account already has that kind of profile.';
  else if (msg.includes('18 years')) mapped.message = 'Companions must be at least 18 — please check the date of birth.';
  else mapped.message = 'We couldn’t create your profile. Please try again.';
  return mapped;
}
