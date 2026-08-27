import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const B = readFileSync('supabase/migrations/0162_credit_booking_and_fallback.sql', 'utf8');
const P = readFileSync('supabase/migrations/0163_credit_booking_completion_payout.sql', 'utf8');

describe('credit booking + fallback (0162, Phase 4)', () => {
  it('creates an instant 45-min booked call that consumes a credit', () => {
    expect(B).toContain('function public.create_credit_booking');
    expect(B).toContain("'booked', 45");
    expect(B).toContain("p_starts_at - interval '20 minutes'");   // confirmation deadline
    expect(B).toContain('public.consume_call_credit(p_member_profile, v_booking)');
  });

  it('adds new statuses and makes offer_id optional', () => {
    expect(B).toContain("'booked','companion_confirmed','admin_fallback','completed'");
    expect(B).toContain('alter column offer_id drop not null');
  });

  it('sweeps unconfirmed-at-deadline and confirmed-no-show to admin fallback', () => {
    expect(B).toContain("status = 'booked' and confirmation_deadline_at <= now()");
    expect(B).toContain("status = 'companion_confirmed' and starts_at + interval '2 minutes' <= now()");
    expect(B).toContain('companion_joined_at is null');
    expect(B).toContain("cron.schedule('sweep-booking-fallbacks', '*/2 * * * *'");
  });

  it('admin fallback accept is first-writer-wins and support gated', () => {
    expect(B).toContain('function public.admin_accept_fallback');
    expect(B).toContain('handled_by_admin_id is null');
    expect(B).toContain('is_support_admin()');
  });
});

describe('credit booking completion + payout (0163, Phase 5)', () => {
  it('makes payment_order_id optional for credit earnings', () => {
    expect(P).toContain('alter column payment_order_id drop not null');
  });

  it('pays £8.33 minus modelled Stripe fee minus 15% commission', () => {
    expect(P).toContain('credit_allocation_minor    integer not null default 833');
    expect(P).toContain('commission_rate_pct        numeric(5,2) not null default 15.00');
    expect(P).toContain('cfg.credit_allocation_minor - cfg.stripe_fee_minor_per_credit');
    expect(P).toContain('v_basis * cfg.commission_rate_pct / 100.0');
  });

  it('pays nothing when an admin handled the call, and is idempotent', () => {
    expect(P).toContain("b.status = 'admin_fallback' or b.handled_by_admin_id is not null");
    expect(P).toContain('select 1 from public.companion_earnings where booking_id = p_booking');
    expect(P).toContain("'payable', 'not_ready'");
  });
});
