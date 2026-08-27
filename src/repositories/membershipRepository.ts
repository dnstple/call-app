/**
 * Membership checkout (restructure Phase 3). Starts the £25 starter week via the
 * create-membership-checkout Edge Function and returns the Stripe Checkout URL.
 * The recurring subscription (begins 7 days later) is created by the membership
 * webhook after the starter payment succeeds.
 */
import { getSupabaseClient } from '../supabase/client';

export interface CheckoutResult {
  ok: boolean;
  url?: string;
  error?: string;
}

export async function startMembershipCheckout(memberProfileId: string): Promise<CheckoutResult> {
  const origin = typeof window !== 'undefined' ? window.location.origin : undefined;
  const { data, error } = await getSupabaseClient().functions.invoke('create-membership-checkout', {
    body: { member_profile_id: memberProfileId, origin },
  });
  if (error) return { ok: false, error: 'We couldn’t start checkout. Please try again.' };
  const r = (data ?? {}) as { ok?: boolean; url?: string; error?: string; detail?: string };
  if (!r.ok || !r.url) return { ok: false, error: r.detail ?? r.error ?? 'Checkout could not be started.' };
  return { ok: true, url: r.url };
}

/** Convenience: start checkout and redirect the browser to Stripe. */
export async function beginMembership(memberProfileId: string): Promise<CheckoutResult> {
  const r = await startMembershipCheckout(memberProfileId);
  if (r.ok && r.url && typeof window !== 'undefined') window.location.assign(r.url);
  return r;
}
