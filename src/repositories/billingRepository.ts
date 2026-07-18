/**
 * 2G1 — billing foundation (Stripe TEST MODE).
 *
 * The browser only ever reads status and calls the Edge Function; every
 * Stripe object and every financial record is created server-side. Mock
 * mode reports a neutral unconfigured state.
 */
import { getSupabaseClient } from '../supabase/client';
import { isSupabaseMode } from '../config/dataMode';

export interface SavedCardSummary {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

export interface BillingStatus {
  configured: boolean;
  hasCustomer: boolean;
  paymentMethodReady: boolean;
  /** Safe summary only — never full card details. */
  card: SavedCardSummary | null;
  testMode: boolean;
}

export interface CreditSummary {
  availableMinor: number;
  expiringNextMinor: number;
  expiringNextAt: string | null;
  currency: 'GBP';
}

export async function getBillingStatus(): Promise<BillingStatus> {
  if (!isSupabaseMode()) {
    return { configured: false, hasCustomer: false, paymentMethodReady: false, card: null, testMode: true };
  }
  const { data, error } = await getSupabaseClient().functions.invoke('stripe-payments', {
    body: { action: 'billing_status' },
  });
  if (error || !data || (data as { error?: string }).error) {
    return { configured: false, hasCustomer: false, paymentMethodReady: false, card: null, testMode: true };
  }
  const r = data as { hasCustomer: boolean; paymentMethodReady: boolean; card: SavedCardSummary | null };
  return {
    configured: true,
    hasCustomer: r.hasCustomer,
    paymentMethodReady: r.paymentMethodReady,
    card: r.card ?? null,
    testMode: true,
  };
}

/** Stripe-HOSTED setup-mode Checkout: returns the redirect URL. The
 * webhook — never the redirect — confirms the card was saved. */
export async function createSetupSession(): Promise<string | null> {
  const { data, error } = await getSupabaseClient().functions.invoke('stripe-payments', {
    body: { action: 'create_setup_session', origin: window.location.origin },
  });
  if (error || !data) return null;
  return (data as { url?: string }).url ?? null;
}

export async function removePaymentMethod(): Promise<boolean> {
  const { data, error } = await getSupabaseClient().functions.invoke('stripe-payments', {
    body: { action: 'remove_payment_method' },
  });
  return !error && Boolean((data as { ok?: boolean })?.ok);
}

export async function createSetupIntent(): Promise<string | null> {
  const { data, error } = await getSupabaseClient().functions.invoke('stripe-payments', {
    body: { action: 'create_setup_intent' },
  });
  if (error || !data) return null;
  return (data as { clientSecret?: string }).clientSecret ?? null;
}

export async function getCreditSummary(): Promise<CreditSummary> {
  if (!isSupabaseMode()) {
    return { availableMinor: 0, expiringNextMinor: 0, expiringNextAt: null, currency: 'GBP' };
  }
  const { data, error } = await getSupabaseClient().rpc('get_credit_summary', {});
  if (error || !data) {
    return { availableMinor: 0, expiringNextMinor: 0, expiringNextAt: null, currency: 'GBP' };
  }
  const r = data as Record<string, unknown>;
  return {
    availableMinor: Number(r.available_minor ?? 0),
    expiringNextMinor: Number(r.expiring_next_minor ?? 0),
    expiringNextAt: (r.expiring_next_at as string | null) ?? null,
    currency: 'GBP',
  };
}
