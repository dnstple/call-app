import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const sql = readFileSync(
  resolve(__dirname, '../../../supabase/migrations/0131_remove_paid_acceptance_gate.sql'),
  'utf8',
);

describe('remove paid-acceptance gate (0131)', () => {
  it('drops the blocking trigger and its function', () => {
    expect(sql).toMatch(/drop trigger if exists bookings_paid_acceptance_gate on public\.bookings/);
    expect(sql).toMatch(/drop function if exists app_private\.gate_paid_acceptance\(\)/);
  });
});
