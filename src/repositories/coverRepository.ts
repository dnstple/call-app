/**
 * Member cover-selection data path. Backs the /cover/:bookingId page where a
 * member picks a replacement companion (from those who accepted the admin's
 * invite), reschedules, or cancels. Server RPCs (0203) are authoritative.
 */
import { getSupabaseClient } from '../supabase/client';

/* eslint-disable @typescript-eslint/no-explicit-any */
function db(): { rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: unknown }> } {
  return getSupabaseClient() as any;
}

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
