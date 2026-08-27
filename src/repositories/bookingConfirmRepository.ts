/**
 * Companion call confirmation + join marking (restructure Phase 4). A booked call
 * must be confirmed by the companion at least 20 minutes before it starts, or it
 * transfers to an admin. Joining the call marks attendance so the no-show sweep
 * can tell a confirmed-but-absent companion apart.
 */
import { getSupabaseClient } from '../supabase/client';

function rpcClient() {
  return getSupabaseClient() as unknown as {
    rpc: (fn: string, p: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  };
}

export async function confirmBooking(bookingId: string): Promise<{ ok: boolean; error?: string }> {
  const { error } = await rpcClient().rpc('companion_confirm_booking', { p_booking: bookingId });
  if (error) return { ok: false, error: 'We couldn’t confirm this call. Please try again.' };
  return { ok: true };
}

export async function markCompanionJoined(bookingId: string): Promise<void> {
  try { await rpcClient().rpc('mark_companion_joined', { p_booking: bookingId }); } catch { /* non-critical */ }
}
