/**
 * Availability, scheduling settings and conversation offers (Supabase mode).
 * Stage 2C2 — prices persist; NO bookings, purchases or payments happen.
 * Money is integer minor units (GBP pence). Empty lists are valid results.
 */
import { getSupabaseClient } from '../supabase/client';
import type {
  AvailabilityExceptionRow,
  AvailabilityRuleRow,
  CompanionProfileRow,
  ConversationOfferRow,
} from '../supabase/database.types';
import { RepoError } from './profileRepository';
import { toHHMM, type WindowInput } from '../domain/timezones';

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapError(e: any, fallback = 'Something went wrong. Please try again.'): RepoError {
  const msg = String(e?.message ?? '').toLowerCase();
  if (import.meta.env?.DEV) console.warn('[availability]', e?.code ?? '', e?.message ?? '');
  if (msg.includes('one_active_trial_per_companion')) {
    return new RepoError('You already have an active trial offer — edit it instead.', 'conflict');
  }
  if (msg.includes('one_active_single_per_duration')) {
    return new RepoError('You already have an active offer for that duration.', 'conflict');
  }
  if (msg.includes('overlap')) {
    return new RepoError('Availability windows on the same day must not overlap.', 'validation');
  }
  if (msg.includes('price_minor') || msg.includes('duration_minutes')) {
    return new RepoError('Please choose a valid price and duration.', 'validation');
  }
  if (msg.includes('time zone') || msg.includes('timezone')) {
    return new RepoError('That timezone isn’t recognised.', 'validation');
  }
  if (msg.includes('row-level security') || msg.includes('cannot edit') || msg.includes('permission')) {
    return new RepoError('You don’t have permission to do that.', 'unauthorised');
  }
  if (msg.includes('must start before')) {
    return new RepoError('Each window must start before it ends.', 'validation');
  }
  return new RepoError(fallback, 'database');
}

/* ---------------- Money & fees ---------------- */

export function poundsToMinor(pounds: string | number): number {
  const value = typeof pounds === 'string' ? Number(pounds) : pounds;
  if (!Number.isFinite(value)) return NaN;
  return Math.round(value * 100);
}

export function formatMinor(minor: number, currency = 'GBP'): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100);
}

export const OFFER_DURATIONS = [15, 30, 45, 60];
export const OFFER_PRICE_MIN_MINOR = 100; // £1
export const OFFER_PRICE_MAX_MINOR = 100000; // £1000

export function validateOfferInput(input: { durationMinutes: number; priceMinor: number }): string | null {
  if (!OFFER_DURATIONS.includes(input.durationMinutes)) return 'Please choose 15, 30, 45 or 60 minutes.';
  if (!Number.isInteger(input.priceMinor) || Number.isNaN(input.priceMinor)) return 'Please enter a valid price.';
  if (input.priceMinor < OFFER_PRICE_MIN_MINOR) return 'The minimum price is £1.';
  if (input.priceMinor > OFFER_PRICE_MAX_MINOR) return 'The maximum price is £1,000.';
  return null;
}

export interface FeePreview {
  priceMinor: number;
  feeMinor: number;
  companionMinor: number;
  ratePct: number;
  estimate: true;
}

/**
 * Estimated fee preview from platform configuration (trial 0%, standard 2%).
 * Payments are NOT enabled yet — this is a display estimate only.
 */
export function calculateFeePreview(
  priceMinor: number,
  offerType: 'trial' | 'single',
  rates: { trialPct: number; standardPct: number },
): FeePreview {
  const ratePct = offerType === 'trial' ? rates.trialPct : rates.standardPct;
  const feeMinor = Math.round((priceMinor * ratePct) / 100);
  return { priceMinor, feeMinor, companionMinor: priceMinor - feeMinor, ratePct, estimate: true };
}

export async function getPublicCommissionSettings(): Promise<{ trialPct: number; standardPct: number }> {
  const { data, error } = await getSupabaseClient()
    .from('platform_config')
    .select('standard_commission_pct, trial_commission_pct')
    .limit(1)
    .single();
  if (error) throw mapError(error);
  return { trialPct: Number(data.trial_commission_pct), standardPct: Number(data.standard_commission_pct) };
}

/* ---------------- Scheduling settings ---------------- */

export interface SchedulingSettings {
  timezone: string;
  minimumNoticeHours: number;
  bookingHorizonDays: number;
  acceptingNewMembers: boolean;
}

export async function getCompanionSchedulingSettings(profileId: string): Promise<SchedulingSettings | null> {
  const { data, error } = await getSupabaseClient()
    .from('companion_profiles')
    .select('timezone, minimum_notice_hours, booking_horizon_days, is_accepting_new_members')
    .eq('profile_id', profileId)
    .maybeSingle();
  if (error) throw mapError(error);
  if (!data) return null;
  return {
    timezone: data.timezone,
    minimumNoticeHours: data.minimum_notice_hours,
    bookingHorizonDays: data.booking_horizon_days,
    acceptingNewMembers: data.is_accepting_new_members,
  };
}

export async function updateCompanionSchedulingSettings(
  profileId: string,
  input: Partial<SchedulingSettings>,
): Promise<void> {
  const patch: Partial<CompanionProfileRow> = {};
  if (input.timezone !== undefined) patch.timezone = input.timezone;
  if (input.minimumNoticeHours !== undefined) patch.minimum_notice_hours = input.minimumNoticeHours;
  if (input.bookingHorizonDays !== undefined) patch.booking_horizon_days = input.bookingHorizonDays;
  if (input.acceptingNewMembers !== undefined) patch.is_accepting_new_members = input.acceptingNewMembers;
  const { error } = await getSupabaseClient()
    .from('companion_profiles')
    .update(patch)
    .eq('profile_id', profileId);
  if (error) throw mapError(error);
}

/* ---------------- Availability rules ---------------- */

export interface AvailabilityWindow {
  day: number; // ISO 1–7
  start: string; // "HH:MM"
  end: string;
}

export function ruleRowToWindow(row: AvailabilityRuleRow): AvailabilityWindow {
  return { day: row.day_of_week, start: toHHMM(row.start_local_time), end: toHHMM(row.end_local_time) };
}

export async function getAvailabilityRules(profileId: string): Promise<AvailabilityRuleRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('availability_rules')
    .select('*')
    .eq('companion_profile_id', profileId)
    .order('day_of_week')
    .order('start_local_time');
  if (error) throw mapError(error);
  return data ?? [];
}

/** Atomic replacement via the validated database operation. */
export async function replaceAvailabilityRules(
  profileId: string,
  timezone: string,
  windows: WindowInput[],
): Promise<AvailabilityRuleRow[]> {
  const { data, error } = await getSupabaseClient().rpc('replace_companion_availability', {
    p_profile: profileId,
    p_timezone: timezone,
    p_rules: windows,
  });
  if (error) throw mapError(error, 'We couldn’t save your availability.');
  return (data ?? []) as AvailabilityRuleRow[];
}

/* ---------------- Availability exceptions (private) ---------------- */

export async function getAvailabilityExceptions(profileId: string): Promise<AvailabilityExceptionRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('availability_exceptions')
    .select('*')
    .eq('companion_profile_id', profileId)
    .order('starts_at');
  if (error) throw mapError(error);
  return data ?? [];
}

export async function addAvailabilityException(
  profileId: string,
  input: { startsAt: string; endsAt: string; type: 'unavailable' | 'additionally_available'; note?: string },
): Promise<void> {
  if (new Date(input.startsAt) >= new Date(input.endsAt)) {
    throw new RepoError('The start must be before the end.', 'validation');
  }
  const { error } = await getSupabaseClient().from('availability_exceptions').insert({
    companion_profile_id: profileId,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    exception_type: input.type,
    note: input.note ?? null,
  });
  if (error) throw mapError(error);
}

export async function removeAvailabilityException(id: string): Promise<void> {
  const { error } = await getSupabaseClient().from('availability_exceptions').delete().eq('id', id);
  if (error) throw mapError(error);
}

/* ---------------- Conversation offers ---------------- */

export async function getConversationOffers(profileId: string): Promise<ConversationOfferRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('conversation_offers')
    .select('*')
    .eq('companion_profile_id', profileId)
    .order('sort_order')
    .order('duration_minutes');
  if (error) throw mapError(error);
  return data ?? [];
}

/** Public read: active offers only (RLS also enforces discoverability). */
export async function getPublicConversationOffers(profileId: string): Promise<ConversationOfferRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('conversation_offers')
    .select('id, companion_profile_id, offer_type, title, duration_minutes, price_minor, currency, supported_methods, active, sort_order, created_at, updated_at')
    .eq('companion_profile_id', profileId)
    .eq('active', true)
    .order('offer_type')
    .order('duration_minutes');
  if (error) throw mapError(error);
  return (data ?? []) as ConversationOfferRow[];
}

export interface OfferInput {
  durationMinutes: number;
  priceMinor: number;
  supportedMethods: string[];
  title?: string;
}

export async function createOffer(
  profileId: string,
  offerType: 'trial' | 'single',
  input: OfferInput,
): Promise<ConversationOfferRow> {
  const problem = validateOfferInput(input);
  if (problem) throw new RepoError(problem, 'validation');
  const { data, error } = await getSupabaseClient()
    .from('conversation_offers')
    .insert({
      companion_profile_id: profileId,
      offer_type: offerType,
      title: input.title ?? (offerType === 'trial' ? 'Trial conversation' : `${input.durationMinutes}-minute conversation`),
      duration_minutes: input.durationMinutes,
      price_minor: input.priceMinor,
      supported_methods: input.supportedMethods,
      active: true,
    })
    .select('*')
    .single();
  if (error) throw mapError(error);
  return data;
}

export async function updateOffer(
  offerId: string,
  patch: Partial<Pick<ConversationOfferRow, 'price_minor' | 'duration_minutes' | 'supported_methods' | 'title' | 'active'>>,
): Promise<void> {
  if (patch.price_minor !== undefined || patch.duration_minutes !== undefined) {
    const problem = validateOfferInput({
      durationMinutes: patch.duration_minutes ?? 30,
      priceMinor: patch.price_minor ?? OFFER_PRICE_MIN_MINOR,
    });
    if (problem) throw new RepoError(problem, 'validation');
  }
  const { data, error } = await getSupabaseClient()
    .from('conversation_offers')
    .update(patch)
    .eq('id', offerId)
    .select('id');
  if (error) throw mapError(error);
  if ((data ?? []).length === 0) throw new RepoError('You don’t have permission to edit this offer.', 'unauthorised');
}

/** Offers are archived, never destroyed. */
export async function archiveOffer(offerId: string): Promise<void> {
  await updateOffer(offerId, { active: false });
}
