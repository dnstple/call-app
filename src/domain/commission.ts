import type { PlatformConfig } from '../types';

export interface FeeBreakdown {
  grossPence: number;
  platformFeePence: number;
  netPence: number;
  commissionPct: number;
}

/**
 * Commission is a configurable platform setting — never hard-code the percentage.
 * Trials: config.trialCommissionPct (0% by default).
 * Everything else: config.standardCommissionPct (2% by default).
 * Payment-processing fees are out of scope for Stage 1.
 */
export function computeFee(
  grossPence: number,
  isTrial: boolean,
  config: Pick<PlatformConfig, 'standardCommissionPct' | 'trialCommissionPct'>,
): FeeBreakdown {
  if (grossPence < 0) throw new Error('Amount cannot be negative');
  const pct = isTrial ? config.trialCommissionPct : config.standardCommissionPct;
  const platformFeePence = Math.round((grossPence * pct) / 100);
  return {
    grossPence,
    platformFeePence,
    netPence: grossPence - platformFeePence,
    commissionPct: pct,
  };
}

export function formatPence(pence: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100);
}

/* ============================================================================
 * Authoritative commission model (integer pence).
 *
 * The customer pays exactly the Companion's price (no added service/processing
 * fee). Stripe's ACTUAL processing fee is deducted, then Apricoti takes its
 * commission from what remains; the Companion receives the rest.
 *
 *   net_after_stripe = gross - stripe_fee
 *   commission_bps   = trial ? 0 : 1000            (10% standard, 0% trial)
 *   commission       = round(net_after_stripe * bps / 10000)   (half away from 0)
 *   companion        = net_after_stripe - commission           (remainder → Companion)
 *
 * Invariant (always exact): gross = stripe_fee + commission + companion.
 *
 * This mirrors the server-authoritative app_private.compute_commission SQL. It
 * is used for UI *estimates* (before the real Stripe fee is known) and tests;
 * money is NEVER finalised from a frontend figure.
 * ==========================================================================*/
export const STANDARD_COMMISSION_BPS = 1000;
export const TRIAL_COMMISSION_BPS = 0;

export function commissionRateBps(isTrial: boolean): number {
  return isTrial ? TRIAL_COMMISSION_BPS : STANDARD_COMMISSION_BPS;
}

export interface CommissionBreakdown {
  grossPence: number;
  stripeFeePence: number;
  netAfterStripePence: number;
  commissionRateBps: number;
  commissionPence: number;
  companionEarningsPence: number;
}

/** Round half away from zero, matching Postgres round(numeric). */
function roundHalfAwayFromZero(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

export function computeCommission(
  grossPence: number,
  stripeFeePence: number,
  isTrial: boolean,
): CommissionBreakdown {
  if (!Number.isInteger(grossPence) || grossPence < 0) throw new Error('grossPence must be a non-negative integer');
  if (!Number.isInteger(stripeFeePence) || stripeFeePence < 0) throw new Error('stripeFeePence must be a non-negative integer');
  if (stripeFeePence > grossPence) throw new Error('stripeFeePence cannot exceed grossPence');
  const bps = commissionRateBps(isTrial);
  const netAfterStripePence = grossPence - stripeFeePence;
  const commissionPence = roundHalfAwayFromZero((netAfterStripePence * bps) / 10000);
  const companionEarningsPence = netAfterStripePence - commissionPence; // remainder → Companion
  return {
    grossPence,
    stripeFeePence,
    netAfterStripePence,
    commissionRateBps: bps,
    commissionPence,
    companionEarningsPence,
  };
}
