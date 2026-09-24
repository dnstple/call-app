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

/**
 * Signup "still have more questions?" capture — email + mobile, stored via the
 * capture_signup_lead RPC. The person can then continue their sign-up.
 */
export async function captureSignupLead(
  email: string,
  phone: string,
  role: LeadRole = 'member',
): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const client = getSupabaseClient() as unknown as {
    rpc: (fn: string, p: Record<string, unknown>) => Promise<{ error: { message?: string } | null }>;
  };
  const { error } = await client.rpc('capture_signup_lead', {
    p_email: email, p_phone: phone || null, p_role: role, p_source: 'signup_help',
  });
  if (error) {
    if (/invalid_email/i.test(error.message ?? '')) {
      return { ok: false, error: 'Please enter a valid email address.' };
    }
    return { ok: false, error: 'Something went wrong — please try again.' };
  }
  return { ok: true };
}
