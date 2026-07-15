import { describe, expect, it } from 'vitest';
import { computeFee } from '../commission';

const config = { standardCommissionPct: 2, trialCommissionPct: 0 };

describe('commission calculation', () => {
  it('applies 0% to trials', () => {
    const fee = computeFee(500, true, config);
    expect(fee.platformFeePence).toBe(0);
    expect(fee.netPence).toBe(500);
    expect(fee.commissionPct).toBe(0);
  });

  it('applies 2% to standard transactions', () => {
    const fee = computeFee(10_000, false, config);
    expect(fee.platformFeePence).toBe(200);
    expect(fee.netPence).toBe(9_800);
  });

  it('rounds to the nearest penny', () => {
    const fee = computeFee(1_234, false, config);
    expect(fee.platformFeePence).toBe(25); // 24.68 → 25
    expect(fee.netPence).toBe(1_209);
  });

  it('is configurable, not hard-coded', () => {
    const fee = computeFee(10_000, false, { standardCommissionPct: 10, trialCommissionPct: 5 });
    expect(fee.platformFeePence).toBe(1_000);
    const trial = computeFee(10_000, true, { standardCommissionPct: 10, trialCommissionPct: 5 });
    expect(trial.platformFeePence).toBe(500);
  });

  it('rejects negative amounts', () => {
    expect(() => computeFee(-1, false, config)).toThrow();
  });
});
