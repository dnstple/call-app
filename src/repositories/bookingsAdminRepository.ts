/**
 * Support-admin read model for the internal Bookings console. Calls the
 * server-side admin_list_bookings RPC (0156), which enforces support-admin
 * access itself. Read-only.
 */
import { getSupabaseClient } from '../supabase/client';

export interface AdminBookingRow {
  id: string;
  member_name: string | null;
  companion_name: string | null;
  is_trial: boolean;
  offer_type: string | null;      // 'trial' | 'single' | null
  kind: string;                   // 'Trial' | 'Paid'
  duration_minutes: number;
  communication_method: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  status: string;
  currency: string;
  price_minor: number;
  platform_fee_minor: number;
  companion_amount_minor: number;
  created_at: string;
}

export interface AdminBookingsResult {
  rows: AdminBookingRow[];
  count: number;
  currency: string;
}

export interface FallbackCall {
  id: string;
  starts_at: string;
  admin_fallback_at: string | null;
  handled_by_admin_id: string | null;
  member_name: string | null;
  companion_name: string | null;
}

/** Calls that transferred to admin fallback and await someone to accept them. */
export async function getFallbackQueue(): Promise<FallbackCall[]> {
  const client = getSupabaseClient() as unknown as {
    rpc: (fn: string) => Promise<{ data: unknown; error: unknown }>;
  };
  const { data, error } = await client.rpc('admin_fallback_queue');
  if (error || !data) return [];
  return (data as FallbackCall[]) ?? [];
}

/** Accept a fallback call (first available admin wins). */
export async function acceptFallback(bookingId: string): Promise<{ ok: boolean; already: boolean }> {
  const client = getSupabaseClient() as unknown as {
    rpc: (fn: string, p: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  };
  const { data, error } = await client.rpc('admin_accept_fallback', { p_booking: bookingId });
  if (error) return { ok: false, already: false };
  const r = (data ?? {}) as { ok?: boolean; already?: boolean };
  return { ok: Boolean(r.ok), already: Boolean(r.already) };
}

export async function adminListBookings(limit = 500): Promise<AdminBookingsResult> {
  const client = getSupabaseClient() as unknown as {
    rpc: (fn: string, params?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  };
  const { data, error } = await client.rpc('admin_list_bookings', { p_limit: limit });
  if (error || !data) return { rows: [], count: 0, currency: 'GBP' };
  const d = data as Partial<AdminBookingsResult>;
  return {
    rows: Array.isArray(d.rows) ? (d.rows as AdminBookingRow[]) : [],
    count: Number(d.count ?? 0),
    currency: d.currency ?? 'GBP',
  };
}
