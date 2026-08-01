/**
 * 2G1 — billing foundation (Stripe TEST MODE).
 *
 * The browser only ever reads status and calls the Edge Function; every
 * Stripe object and every financial record is created server-side. Mock
 * mode reports a neutral unconfigured state.
 */
import { getSupabaseClient } from '../supabase/client';
import { isSupabaseMode } from '../config/dataMode';
import { RepoError } from './profileRepository';

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
export async function createSetupSession(returnPath?: string): Promise<string | null> {
  // returnPath is an optional in-app resume target (Block 9). The Edge function
  // strictly allowlists it to a companion profile path; anything else falls
  // back to the default Settings return, so this is safe to pass through.
  const { data, error } = await getSupabaseClient().functions.invoke('stripe-payments', {
    body: { action: 'create_setup_session', origin: window.location.origin, returnPath: returnPath ?? '' },
  });
  if (error || !data) return null;
  return (data as { url?: string }).url ?? null;
}

/* ---------------- 2G2: paid requests ---------------- */

export interface PaidRequestQuote {
  type: 'trial' | 'one_off';
  subtotalMinor: number;
  serviceFeeMinor: number;
  trialFeeWaived: boolean;
  creditAppliedMinor: number;
  cardAmountMinor: number;
  totalMinor: number;
  durationMinutes: number;
}

export async function quotePaidRequest(
  memberProfileId: string, companionProfileId: string, offerId: string,
): Promise<PaidRequestQuote> {
  const { data, error } = await getSupabaseClient().functions.invoke('stripe-payments', {
    body: { action: 'quote_paid_request', memberProfileId, companionProfileId, offerId },
  });
  const q = (data as { quote?: Record<string, unknown>; error?: string; detail?: string }) ?? {};
  if (error || q.error || !q.quote) {
    throw new Error(String(q.detail ?? 'We couldn’t price this conversation just now.'));
  }
  const r = q.quote;
  return {
    type: r.type as 'trial' | 'one_off',
    subtotalMinor: Number(r.subtotal_minor),
    serviceFeeMinor: Number(r.service_fee_minor),
    trialFeeWaived: Boolean(r.trial_fee_waived),
    creditAppliedMinor: Number(r.credit_applied_minor),
    cardAmountMinor: Number(r.card_amount_minor),
    totalMinor: Number(r.total_minor),
    durationMinutes: Number(r.duration_minutes),
  };
}

export interface PaidRequestResult {
  orderId: string;
  state: string; // succeeded | processing | requires_action | payment_method_required | failed
  url?: string;  // hosted authentication, when required
  fundedByCreditOnly?: boolean;
}

export async function createPaidRequest(input: {
  memberProfileId: string; companionProfileId: string; offerId: string;
  startsAt: string; idempotencyKey: string;
}): Promise<PaidRequestResult> {
  const { data, error } = await getSupabaseClient().functions.invoke('stripe-payments', {
    body: {
      action: 'create_paid_request',
      memberProfileId: input.memberProfileId,
      companionProfileId: input.companionProfileId,
      offerId: input.offerId,
      startsAt: input.startsAt,
      idempotencyKey: input.idempotencyKey,
      origin: window.location.origin,
    },
  });
  const r = (data as PaidRequestResult & { error?: string; detail?: string }) ?? { orderId: '', state: 'failed' };
  if (error || r.error) {
    const detail = String(r.detail ?? r.error ?? '');
    // The "one trial per Companion" rule — a trial order already exists for this
    // Member↔Companion pair (a started-but-abandoned trial also counts).
    if (/one_trial_per_pair/i.test(detail)) {
      throw new RepoError(
        'You’ve already started or used your trial with this Companion. You can book a standard conversation instead.',
        'conflict',
      );
    }
    // Never surface raw database errors (constraints, duplicate keys) to users.
    if (/duplicate key|violates|constraint|null value|invalid input/i.test(detail)) {
      throw new RepoError('We couldn’t complete that booking. Please try again.', 'validation');
    }
    throw new RepoError(detail || 'We couldn’t take your payment. Please try again.', 'validation');
  }
  return r;
}

/** Safe payment-order state (RLS: the coordinator's own orders only). */
export async function getPaymentOrderState(orderId: string): Promise<string | null> {
  const { data, error } = await getSupabaseClient().functions.invoke('stripe-payments', {
    body: { action: 'payment_state', orderId },
  });
  if (error || !data) return null;
  return ((data as { order?: { status?: string } }).order?.status) ?? null;
}

/* -------- Stage 3D-C: durable owner-safe status + recovery check -------- */

/** Owner-safe durable projection from 0080's get_payment_order_status RPC. */
export interface PaymentOrderStatusProjection {
  found: boolean;
  orderId?: string;
  customerStatus?: string;
  orderStatus?: string;
  providerStatus?: string;
  bookingId?: string | null;
  orderType?: string;
  totalMinor?: number;
  cardAmountMinor?: number;
  currency?: string;
  finalisedAt?: string | null;
}

function mapStatusRow(row: Record<string, unknown> | null): PaymentOrderStatusProjection {
  if (!row || row.found !== true) return { found: false };
  return {
    found: true,
    orderId: String(row.order_id ?? ''),
    customerStatus: String(row.customer_status ?? ''),
    orderStatus: String(row.order_status ?? ''),
    providerStatus: String(row.provider_status ?? ''),
    bookingId: (row.booking_id as string | null) ?? null,
    orderType: String(row.order_type ?? ''),
    totalMinor: Number(row.total_minor ?? 0),
    cardAmountMinor: Number(row.card_amount_minor ?? 0),
    currency: String(row.currency ?? 'GBP'),
    finalisedAt: (row.finalised_at as string | null) ?? null,
  };
}

// 0080 RPCs postdate the generated database types (which are intentionally
// NOT regenerated in this stage) — same untyped-rpc pattern as the financial
// operations repository.
type UntypedRpc = {
  rpc: (fn: string, args?: Record<string, unknown>) =>
    PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/** Durable customer status (webhook-authoritative projection; read-only). */
export async function getPaymentOrderStatus(orderId: string): Promise<PaymentOrderStatusProjection> {
  if (!isSupabaseMode()) return { found: false };
  const { data, error } = await (getSupabaseClient() as unknown as UntypedRpc)
    .rpc('get_payment_order_status', { p_order: orderId });
  if (error || !data) return { found: false };
  return mapStatusRow(data as Record<string, unknown>);
}

/**
 * "Check payment status": the server re-reads the PaymentIntent ALREADY
 * stored for this order and reconciles idempotently. Only the local order id
 * is ever sent — never a PaymentIntent id, never an amount — and the server
 * never creates or charges anything on this path.
 */
export async function checkPaymentOrder(orderId: string): Promise<PaymentOrderStatusProjection> {
  if (!isSupabaseMode()) return { found: false };
  const { data, error } = await getSupabaseClient().functions.invoke('stripe-payments', {
    body: { action: 'check_payment_order', orderId },
  });
  if (error || !data) return { found: false };
  const status = (data as { status?: Record<string, unknown> }).status ?? null;
  return mapStatusRow(status);
}

/* ---------------- 2G3: Companion Connect status ---------------- */

export interface ConnectStatus {
  hasAccount: boolean;
  detailsSubmitted?: boolean;
  payoutsEnabled?: boolean;
  transfersCapability?: string;
  requirementsDue?: string[];
  requirementsPastDue?: string[];
  disabledReason?: string | null;
  ready?: boolean;
}

export async function getConnectStatus(refresh = false): Promise<ConnectStatus> {
  if (!isSupabaseMode()) return { hasAccount: false };
  const { data, error } = await getSupabaseClient().functions.invoke('stripe-payments', {
    body: { action: refresh ? 'refresh_connect_status' : 'get_connect_status' },
  });
  if (error || !data) return { hasAccount: false };
  return ((data as { status?: ConnectStatus }).status) ?? { hasAccount: false };
}

export async function createConnectOnboardingLink(): Promise<string | null> {
  const { data, error } = await getSupabaseClient().functions.invoke('stripe-payments', {
    body: { action: 'create_connect_onboarding_link', origin: window.location.origin },
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
