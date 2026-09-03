/**
 * Cover data path — two flows share this module:
 *   1. Companion backup-cover response (get_backup_offer / respond_backup_offer),
 *      reached from the companion's SMS link (/cover?o=&t=).
 *   2. Member cover selection (my_cover_options / member_select_cover), reached
 *      from the member's SMS link (/cover/:bookingId).
 * Server RPCs are authoritative.
 */
import { getSupabaseClient } from '../supabase/client';

/* eslint-disable @typescript-eslint/no-explicit-any */
function db(): { rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: unknown }> } {
  return getSupabaseClient() as any;
}

// ---------------------------------------------------------------------------
// 1. Companion backup-cover response (existing).
// ---------------------------------------------------------------------------
export interface BackupOfferView {
  ok: boolean;
  state: string;
  batch?: string;
  bookingId?: string;
  startsAt?: string;
  endsAt?: string;
  durationMinutes?: number;
  timezone?: string;
  isOpen?: boolean;
}

export async function getBackupOffer(offerId: string, token: string): Promise<BackupOfferView> {
  const { data, error } = await db().rpc('get_backup_offer', { p_offer: offerId, p_token: token });
  if (error || !data) return { ok: false, state: 'error' };
  const r = data as any;
  return {
    ok: !!r.ok,
    state: r.state,
    batch: r.batch,
    bookingId: r.booking_id,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    durationMinutes: r.duration_minutes,
    timezone: r.timezone,
    isOpen: r.is_open,
  };
}

export async function respondBackupOffer(offerId: string, token: string, available: boolean): Promise<{ state: string }> {
  const { data, error } = await db().rpc('respond_backup_offer', { p_offer: offerId, p_token: token, p_available: available });
  if (error || !data) return { state: 'error' };
  const r = data as any;
  return { state: r.state ?? 'error' };
}

// ---------------------------------------------------------------------------
// 2. Member cover selection (new).
// ---------------------------------------------------------------------------
export interface CoverOption {
  offer_id: string;
  companion_profile_id: string;
  first_name: string;
  last_name: string | null;
  photo_url: string | null;
  bio: string | null;
}

export interface CoverInfo {
  bookingId: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: string;
  backupState: string | null;
  originalCompanion: string | null;
  options: CoverOption[];
}

export async function getMyCoverOptions(bookingId: string): Promise<CoverInfo | null> {
  const { data, error } = await db().rpc('my_cover_options', { p_booking: bookingId });
  if (error || !data) return null;
  const r = data as any;
  return {
    bookingId: r.booking_id,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    timezone: r.timezone,
    status: r.status,
    backupState: r.backup_state ?? null,
    originalCompanion: r.original_companion ?? null,
    options: (r.options ?? []) as CoverOption[],
  };
}

export async function selectCover(bookingId: string, offerId: string): Promise<{ ok: boolean; outcome?: string }> {
  const { data, error } = await db().rpc('member_select_cover', { p_booking: bookingId, p_offer: offerId });
  if (error) return { ok: false };
  const r = (data ?? {}) as any;
  return { ok: !!r.ok, outcome: r.outcome };
}

export async function cancelMyBooking(bookingId: string, reason: string): Promise<{ ok: boolean }> {
  const { error } = await db().rpc('cancel_booking', { p_booking: bookingId, p_reason: reason });
  return { ok: !error };
}
