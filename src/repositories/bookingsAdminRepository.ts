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
