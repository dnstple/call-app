/**
 * Supabase repository — Stage 2A foundation.
 *
 * Implements connectivity plus first reads (platform config, profiles).
 * Everything else throws NotImplementedError until Stage 2B migrates it.
 * Row Level Security is enabled on every table; until auth arrives in
 * Stage 3 the anon key can only see what explicit policies allow.
 */
import { getSupabaseClient, isSupabaseConfigured } from '../supabase/client';
import type { PlatformConfig, User } from '../types';
import { NotImplementedError, type DataRepository, type RepositoryPing } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapProfileRow(row: any): User {
  return {
    id: row.id,
    role: row.role,
    firstName: row.first_name ?? '',
    lastName: row.last_name ?? '',
    email: row.email ?? '',
    phone: row.phone ?? '',
    ageBand: row.age_band ?? '',
    region: row.region ?? '',
    headline: row.headline ?? '',
    bio: row.bio ?? '',
    interests: row.interests ?? [],
    languages: row.languages ?? [],
    style: row.style ?? 'relaxed',
    mediums: row.mediums ?? ['phone'],
    avatarColor: row.avatar_color ?? '#c8643d',
    photoUrl: row.photo_url ?? undefined,
    verification: row.verification ?? 'not_verified',
    accessibilityNeeds: row.accessibility_needs ?? undefined,
    preferredTimes: row.preferred_times ?? undefined,
    boundaries: row.boundaries ?? undefined,
    responseRatePct: row.response_rate_pct ?? undefined,
    completionReliabilityPct: row.completion_reliability_pct ?? undefined,
    joinedAt: row.joined_at ?? new Date().toISOString(),
  };
}

export const supabaseRepository: DataRepository = {
  mode: 'supabase',

  async ping(): Promise<RepositoryPing> {
    if (!isSupabaseConfigured()) {
      return {
        ok: false,
        message:
          'Supabase environment variables are not set. Copy .env.example to .env, add your project URL and anon key, then restart the dev server.',
      };
    }
    try {
      const { error } = await getSupabaseClient()
        .from('platform_config')
        .select('id', { head: true, count: 'exact' });
      if (error) {
        return {
          ok: false,
          message: `Connected to Supabase, but the query failed: ${error.message}. Have you run supabase/migrations/0001_initial_schema.sql?`,
        };
      }
      return { ok: true, message: 'Connected to Supabase and the schema responded. Foundation is ready for Stage 2B.' };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Could not reach Supabase.' };
    }
  },

  async fetchPlatformConfig(): Promise<PlatformConfig> {
    const { data, error } = await getSupabaseClient().from('platform_config').select('*').limit(1).single();
    if (error) throw new Error(`Could not load platform config: ${error.message}`);
    return {
      standardCommissionPct: Number(data.standard_commission_pct),
      trialCommissionPct: Number(data.trial_commission_pct),
      recommendedTrialPence: data.recommended_trial_pence,
      trialDurationMins: data.trial_duration_mins,
      completionReminderHours: data.completion_reminder_hours,
      currency: 'GBP',
    };
  },

  async fetchUsers(): Promise<User[]> {
    const { data, error } = await getSupabaseClient().from('profiles').select('*');
    if (error) throw new Error(`Could not load profiles: ${error.message}`);
    return (data ?? []).map(mapProfileRow);
  },

  async fetchRelationships() {
    throw new NotImplementedError('Reading relationships');
  },
  async fetchAvailabilityRules() {
    throw new NotImplementedError('Reading availability');
  },
  async fetchOffers() {
    throw new NotImplementedError('Reading offers');
  },
  async fetchPurchases() {
    throw new NotImplementedError('Reading purchases');
  },
  async fetchBookings() {
    throw new NotImplementedError('Reading bookings');
  },
  async fetchConfirmations() {
    throw new NotImplementedError('Reading completion confirmations');
  },
  async fetchRatings() {
    throw new NotImplementedError('Reading ratings');
  },
  async fetchNotifications() {
    throw new NotImplementedError('Reading notifications');
  },
  async fetchReports() {
    throw new NotImplementedError('Reading reports');
  },
  async fetchTransactions() {
    throw new NotImplementedError('Reading transactions');
  },
};
