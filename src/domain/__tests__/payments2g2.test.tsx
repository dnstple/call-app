// @vitest-environment jsdom
/**
 * 2G2 — paid trial and one-off request contracts (0031 + functions).
 * Live money behaviour is exercised against the hosted project and
 * Stripe sandbox; these tests pin the server-side rules statically.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const SQL = readFileSync(join(ROOT, 'supabase', 'migrations', '0031_paid_requests.sql'), 'utf-8');
const FN = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-payments', 'index.ts'), 'utf-8');
const WH = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-webhook', 'index.ts'), 'utf-8');

describe('0031 paid-request contract', () => {
  it('5+6+13. prices, commission and fee are server-derived and snapshotted', () => {
    expect(SQL).toContain('from public.conversation_offers');
    expect(SQL).toContain('app_private.active_commission');
    expect(SQL).toContain('app_private.active_service_fee');
    // Nothing browser-supplied: the RPC signature carries NO price args.
    expect(SQL).toContain('create_paid_request(\n  p_member uuid, p_companion uuid, p_offer uuid,\n  p_starts_at timestamptz, p_idempotency text\n)');
    expect(SQL).not.toMatch(/p_price|p_amount|p_fee|p_commission/);
  });

  it('7+8+9+10. trial rules: one per pair forever; five fee-free per MEMBER', () => {
    expect(SQL).toContain('payment_orders_one_trial_per_pair');
    expect(SQL).toMatch(/where order_type = 'trial' and status not in \('failed', 'expired'\)/);
    expect(SQL).toContain('member_trial_count(p_member) < 5');
    expect(SQL).toContain('v_fee := 0');
    // Allowance counts by MEMBER (independent per managed Member).
    expect(SQL).toContain('where member_profile_id = p_member');
    expect(SQL).toContain('already had a trial with this Companion');
  });

  it('11+12. trial commission 0%, one-off 5% — from config, never hardcoded here', () => {
    expect(SQL).toContain('function app_private.active_commission(p_type text)');
    expect(SQL).not.toMatch(/rate_pct := 5|:= 0\.05/);
  });

  it('14+15+16+17. credit-first funding, FIFO reservation, no zero-value intents', () => {
    expect(SQL).toContain("'spend-' || v_order.id::text"); // idempotent reservation
    expect(SQL).toContain('if v_order.card_amount_minor = 0 then');
    expect(SQL).toContain("perform app_private.finalise_paid_order(v_order.id, 'succeeded', null)");
    expect(FN).toContain('fundedByCreditOnly: true');
    // The credit-only path returns BEFORE any Stripe call in the function.
    const createBlock = FN.slice(FN.indexOf("action === 'create_paid_request'"));
    expect(createBlock.indexOf('fundedByCreditOnly')).toBeLessThan(createBlock.indexOf('paymentIntents.create'));
  });

  it('18+19+20. concurrency: locked credit spend, slot-hold index, idempotent create', () => {
    expect(SQL).toContain('payment_orders_slot_hold');
    expect(SQL).toMatch(/on public\.payment_orders \(companion_profile_id, starts_at\)/);
    expect(SQL).toContain('where idempotency_key = p_idempotency');
    expect(FN).toContain('idempotencyKey: `order-${order.order_id}`');
  });

  it('21+22. failure and the 30-minute expiry release credit and slot exactly once', () => {
    expect(SQL).toContain("now() + interval '30 minutes'");
    expect(SQL).toContain("'release-' || v_order.id::text");
    expect(SQL).toContain('expire_stale_payment_orders');
    expect(SQL).toContain('for update skip locked');
    expect(SQL).toMatch(/grant execute on function public\.expire_stale_payment_orders\(\) to service_role/);
  });

  it('23+24+26. the funded booking exists ONLY after finalisation — webhook-driven', () => {
    // The booking INSERT lives inside the finalisation function…
    const fin = SQL.slice(
      SQL.indexOf('create or replace function app_private.finalise_paid_order'),
      SQL.indexOf('create or replace function public.expire_stale_payment_orders'));
    expect(fin).toContain('insert into public.bookings');
    expect(fin).toContain('for update');
    expect(fin).toContain("if v_order.status not in ('pending', 'requires_action', 'processing') then return");
    // …and only webhooks/service role may call it.
    expect(SQL).toContain('grant execute on function public.finalize_paid_order(uuid, text, text) to service_role');
    expect(SQL).toMatch(/revoke all on function public\.finalize_paid_order[\s\S]{0,40}from public, anon, authenticated/);
    expect(WH).toContain("rpc('finalize_paid_order'");
    // The browser-facing function NEVER finalises success itself.
    expect(FN).not.toMatch(/finalize_paid_order'[\s\S]{0,80}p_outcome: 'succeeded'/);
  });

  it('25. webhook replay safety: event-id dedupe + status-guarded finalisation', () => {
    expect(WH).toContain('duplicate: true');
    expect(SQL).toContain('where idempotency_key = p_idempotency'); // replayed create returns the order
  });

  it('28+29+30. decline/cancel-before-response → FULL total credited once, no card refund', () => {
    expect(SQL).toContain("new.status = 'declined' and old.status = 'requested'");
    expect(SQL).toContain("new.status = 'cancelled' and old.status = 'requested'");
    expect(SQL).toContain('v_order.total_minor'); // conversation value + service fee
    expect(SQL).toContain("'closure-' || v_order.id::text"); // exactly once
    expect(SQL).not.toMatch(/refunds?\.create|stripe.*refund/i);
    expect(SQL).toContain("set status = 'credited'");
  });

  it('requires_action cards get a HOSTED confirmation path (no frontend SDK)', () => {
    expect(FN).toContain("stripeErr.code === 'authentication_required'");
    expect(FN).toContain("mode: 'payment'");
    expect(FN).toContain('payment_intent_data: { metadata: { payment_order_id: order.order_id } }');
    expect(FN).toContain('allowed.includes(requested) ? requested : allowed[0]');
  });

  it('32+34. metadata carries internal UUIDs only; no secrets or member details', () => {
    expect(FN).toContain('metadata: { payment_order_id: order.order_id, account_id: user.id }');
    expect(FN).not.toMatch(/member_first_name|member_name/);
    expect(FN).toContain("off_session: true");
    expect(FN).toContain('confirm: true');
  });

  it('31+33. payment orders stay coordinator-scoped (0030 RLS untouched)', () => {
    expect(SQL).not.toMatch(/create policy/i); // no new client surface at all
    expect(SQL).not.toMatch(/drop policy/i);
  });

  it('reschedule rule documented: same duration + snapshotted price only', () => {
    expect(SQL).toContain('REQUIRE the same duration');
    expect(SQL).toContain('price-changing proposals are blocked');
  });
});
