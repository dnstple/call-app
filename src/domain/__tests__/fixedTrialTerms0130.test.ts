import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const sql = readFileSync(
  resolve(__dirname, '../../../supabase/migrations/0130_fixed_trial_terms.sql'),
  'utf8',
);

describe('fixed trial terms (0130)', () => {
  it('normalises existing trials to 30 min / £5', () => {
    expect(sql).toMatch(/update public\.conversation_offers\s*set price_minor = 500, duration_minutes = 30\s*where offer_type = 'trial'/);
  });

  it('forces trial price and duration via a before trigger', () => {
    expect(sql).toMatch(/create or replace function app_private\.enforce_trial_offer_terms/);
    expect(sql).toMatch(/new\.price_minor := 500;/);
    expect(sql).toMatch(/new\.duration_minutes := 30;/);
    expect(sql).toMatch(/before insert or update on public\.conversation_offers/);
  });

  it('only affects trial offers', () => {
    expect(sql).toMatch(/if new\.offer_type = 'trial' then/);
  });
});
