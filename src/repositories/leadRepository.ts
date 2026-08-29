/**
 * Public landing-page lead capture. Signed-out visitors leave an email and the
 * account type they're interested in; the server-side capture_landing_lead RPC
 * (SECURITY DEFINER) validates and stores it. The browser never reads the table.
 */
import { getSupabaseClient, isSupabaseConfigured } from '../supabase/client';

export type LeadRole = 'member' | 'companion' | 'coordinator';

export async function captureLandingLead(
  email: string,
  role: LeadRole,
): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured()) {
    // Local/preview (no backend): accept optimistically so the UI can be tried.
    return { ok: true };
  }
  const client = getSupabaseClient() as unknown as {
    rpc: (fn: string, p: Record<string, unknown>) => Promise<{ error: { message?: string } | null }>;
  };
  const { error } = await client.rpc('capture_landing_lead', { p_email: email, p_role: role });
  if (error) {
    if (/invalid_email/i.test(error.message ?? '')) {
      return { ok: false, error: 'Please enter a valid email address.' };
    }
    return { ok: false, error: 'Something went wrong — please try again.' };
  }
  return { ok: true };
}
