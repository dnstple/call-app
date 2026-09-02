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

/* eslint-disable @typescript-eslint/no-explicit-any */
function db(): { rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: unknown }> } {
  return getSupabaseClient() as any;
}

export interface MyMembership {
  hasMembership: boolean;
  membershipId?: string;
  memberProfileId?: string;
  status?: string;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: string | null;
  hasStripeCustomer?: boolean;
  creditBalance: number;
}

/** The signed-in member's own membership + live credit balance. */
export async function getMyMembership(): Promise<MyMembership> {
  const { data, error } = await db().rpc('my_membership');
  if (error) return { hasMembership: false, creditBalance: 0 };
  const r = (data ?? {}) as any;
  return {
    hasMembership: !!r.has_membership,
    membershipId: r.membership_id,
    memberProfileId: r.member_profile_id,
    status: r.status,
    cancelAtPeriodEnd: r.cancel_at_period_end ?? false,
    currentPeriodEnd: r.current_period_end ?? null,
    hasStripeCustomer: r.has_stripe_customer ?? false,
    creditBalance: r.credit_balance ?? 0,
  };
}

export interface RetentionResult { granted: boolean; reason?: string; balance?: number }

/** Offer a one-time free credit during cancellation (only if the member has none). */
export async function grantRetentionCredit(): Promise<RetentionResult> {
  const { data, error } = await db().rpc('grant_retention_credit');
  if (error) return { granted: false, reason: 'error' };
  const r = (data ?? {}) as any;
  return { granted: !!r.granted, reason: r.reason, balance: r.balance };
}

/** Capture the cancellation reason + notes (notes must be >= 50 chars). */
export async function submitCancellationFeedback(reason: string, notes: string): Promise<{ ok: boolean; error?: string }> {
  const { error } = await db().rpc('submit_cancellation_feedback', { p_reason: reason, p_notes: notes });
  if (error) {
    const msg = String((error as { message?: string })?.message ?? '').toLowerCase();
    if (msg.includes('notes_too_short')) return { ok: false, error: 'Please add at least 50 characters.' };
    if (msg.includes('reason_required')) return { ok: false, error: 'Please choose a reason.' };
    return { ok: false, error: 'We couldn’t save that. Please try again.' };
  }
  return { ok: true };
}

/** Open Stripe's hosted billing portal (where the member actually cancels). */
export async function openBillingPortal(): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await getSupabaseClient().functions.invoke('create-billing-portal', { body: {} });
  if (error) return { ok: false, error: 'We couldn’t open the billing page. Please try again.' };
  const r = (data ?? {}) as { url?: string; error?: string; detail?: string };
  if (!r.url) return { ok: false, error: r.detail ?? 'The billing page isn’t available right now.' };
  if (typeof window !== 'undefined') window.location.assign(r.url);
  return { ok: true };
}
