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
