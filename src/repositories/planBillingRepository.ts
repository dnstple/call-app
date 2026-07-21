/**
 * Recurring-billing reads (Phase 2G5A, Supabase mode only).
 *
 * READ-ONLY: this stage previews an upcoming monthly billing period for a
 * conversation plan (occurrences × price − 10% monthly discount, with account
 * credit applied BEFORE any card amount) and lists persisted billing periods.
 * All figures are server-derived through the coordinator-scoped
 * preview_plan_billing_period RPC — the browser never prices anything and
 * never moves money. No mock data. The charge engine arrives in 2G5B.
 */
import { getSupabaseClient } from '../supabase/client';
import { RepoError, type RepoErrorKind } from './profileRepository';

export class PlanBillingError extends RepoError {
  constructor(message: string, kind: RepoErrorKind = 'database') {
    super(message, kind);
    this.name = 'PlanBillingError';
  }
}

function mapError(e: unknown): PlanBillingError {
  const msg = String((e as { message?: string })?.message ?? '').toLowerCase();
  if (msg.includes('not_found')) {
    return new PlanBillingError('This plan’s billing isn’t available to you.', 'not_found');
  }
  if (msg.includes('failed to fetch') || msg.includes('network')) {
    return new PlanBillingError('We couldn’t reach the server. Please try again.', 'network');
  }
  return new PlanBillingError('We couldn’t load the billing estimate.');
}

export interface PlanBillingPreview {
  planId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  frequencyPerWeek: number;
  perConversationMinor: number;
  occurrences: number;
  grossMinor: number;
  discountPct: number;
  discountMinor: number;
  netMinor: number;
  creditAvailableMinor: number;
  creditAppliedMinor: number;
  cardAmountMinor: number;
  estimate: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toPreview(r: any): PlanBillingPreview {
  return {
    planId: r.plan_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    currency: r.currency ?? 'GBP',
    frequencyPerWeek: r.frequency_per_week,
    perConversationMinor: r.per_conversation_minor,
    occurrences: r.occurrences,
    grossMinor: r.gross_minor,
    discountPct: r.discount_pct,
    discountMinor: r.discount_minor,
    netMinor: r.net_minor,
    creditAvailableMinor: r.credit_available_minor,
    creditAppliedMinor: r.credit_applied_minor,
    cardAmountMinor: r.card_amount_minor,
    estimate: Boolean(r.estimate),
  };
}

/** ISO date (YYYY-MM-DD) for the first day of the current month, UTC-safe. */
export function currentMonthStart(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/**
 * Coordinator-consented billing activation. Enables monthly billing ONLY for
 * an accepted (active) plan whose payer has a usable saved payment method —
 * acceptance alone never starts charging. Server-enforced + idempotent; the
 * browser sends only the plan id.
 */
export async function activatePlanBilling(planId: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('activate_plan_billing', { p_plan: planId });
  if (error) {
    const msg = String(error.message ?? '').toLowerCase();
    if (msg.includes('payment_method_required')) {
      throw new PlanBillingError('Add a payment method before enabling billing.', 'validation');
    }
    if (msg.includes('plan_not_active')) {
      throw new PlanBillingError('The plan must be accepted before billing can start.', 'validation');
    }
    throw mapError(error);
  }
}

/** Coordinator-scoped, server-priced preview of an upcoming billing period. */
export async function getPlanBillingPreview(
  planId: string,
  periodStart: string,
): Promise<PlanBillingPreview> {
  const { data, error } = await getSupabaseClient().rpc('preview_plan_billing_period', {
    p_plan: planId,
    p_period_start: periodStart,
  });
  if (error) throw mapError(error);
  if (!data) throw new PlanBillingError('No billing estimate is available.', 'not_found');
  return toPreview(data);
}

export interface PlanBillingPeriod {
  id: string;
  planId: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  occurrencesCount: number;
  currency: string;
  grossMinor: number;
  discountMinor: number;
  netMinor: number;
  creditAppliedMinor: number;
  cardAmountMinor: number;
  paymentOrderId: string | null;
  createdAt: string;
}

/** Persisted billing periods for a plan (coordinator reads own via RLS). */
export async function getPlanBillingPeriods(planId: string): Promise<PlanBillingPeriod[]> {
  const { data, error } = await getSupabaseClient()
    .from('plan_billing_periods')
    .select('*')
    .eq('plan_id', planId)
    .order('period_start', { ascending: false });
  if (error) throw mapError(error);
  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    planId: r.plan_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    status: r.status,
    occurrencesCount: r.occurrences_count,
    currency: r.currency ?? 'GBP',
    grossMinor: r.gross_minor,
    discountMinor: r.discount_minor,
    netMinor: r.net_minor,
    creditAppliedMinor: r.credit_applied_minor,
    cardAmountMinor: r.card_amount_minor,
    paymentOrderId: r.payment_order_id ?? null,
    createdAt: r.created_at,
  }));
}

/**
 * Finish an 'action_required' billing period via a Stripe-hosted Checkout for
 * the exact card remainder (auth-required or missing card). The server derives
 * the amount from the order — the browser supplies nothing monetary. The
 * existing webhook finalises success and tops up the allowance.
 */
export async function completePlanBillingPeriod(orderId: string): Promise<{ url: string }> {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const { data, error } = await getSupabaseClient().functions.invoke('stripe-billing', {
    body: { action: 'complete_period', order_id: orderId, origin },
  });
  if (error) throw mapError(error);
  const d = data as { ok?: boolean; url?: string } | null;
  if (!d?.url) throw new PlanBillingError('We couldn’t start the payment. Please try again.');
  return { url: d.url };
}
