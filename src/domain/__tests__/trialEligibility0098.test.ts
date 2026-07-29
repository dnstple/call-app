/**
 * Block 10 — trial eligibility is decided by trial BOOKINGS, not pending
 * payment orders (migration 0098).
 *
 * Contract-level assertions on the migration text (the functional behaviour is
 * proven separately against a real Postgres): eligibility no longer keys off
 * payment_orders, the booking-based predicate uses the correct consuming
 * statuses, and quote_paid_request routes through it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const M = readFileSync(
  join(ROOT, 'supabase', 'migrations', '0098_trial_eligibility_by_booking.sql'),
  'utf-8',
);

describe('migration 0098 — trial eligibility by booking', () => {
  it('adds a booking-based consumption predicate', () => {
    expect(M).toMatch(/function app_private\.member_companion_trial_consumed\(/);
    expect(M).toMatch(/from public\.bookings/i);
    // Consuming statuses: paid-awaiting, accepted, negotiating, done, awaiting-review.
    expect(M).toMatch(/'requested',\s*'confirmed',\s*'change_proposed',\s*'completed',\s*'needs_review'/);
  });

  it('quote_paid_request uses the booking predicate, not payment_orders', () => {
    expect(M).toMatch(/if app_private\.member_companion_trial_consumed\(p_member, p_companion\) then/);
    // The old payment_orders-based eligibility check must be gone from the quote.
    expect(M).not.toMatch(/from public\.payment_orders\s+where member_profile_id = p_member and companion_profile_id = p_companion/i);
  });

  it('member-wide trial count (fee waiver) is also booking-based', () => {
    const countFn = M.slice(M.indexOf('function app_private.member_trial_count'));
    expect(countFn).toMatch(/from public\.bookings/i);
    expect(countFn).not.toMatch(/from public\.payment_orders/i);
  });

  it('is additive only — no destructive statements, and reloads PostgREST', () => {
    expect(M).not.toMatch(/drop table|drop column|delete from|truncate|alter table .* drop/i);
    expect(M).toMatch(/pg_notify\('pgrst', 'reload schema'\)/);
  });
});
