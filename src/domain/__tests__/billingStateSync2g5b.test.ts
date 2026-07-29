/**
 * 2G5B state-sync contracts (0043). One transactional RPC is the single
 * authority for every plan_period terminal/intermediate transition; the
 * stripe-billing Edge Function never terminalises an order while leaving its
 * period behind; the renewal engine treats payment_failed as terminal; and the
 * migration repairs pre-existing inconsistent rows.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const SQL = readFileSync(join(ROOT, 'supabase', 'migrations', '0043_plan_billing_state_sync.sql'), 'utf-8');
const DRIFT = readFileSync(join(ROOT, 'supabase', 'migrations', '0045_plan_billing_drift_rpc.sql'), 'utf-8');
const BILLING = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-billing', 'index.ts'), 'utf-8');
const WEBHOOK = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-webhook', 'index.ts'), 'utf-8');

function fn(name: string): string {
  const start = SQL.indexOf(`create or replace function ${name}`);
  const end = SQL.indexOf('\n$$;', start);
  return SQL.slice(start, end);
}

describe('0043 settle_plan_billing_order — single authority state map', () => {
  const f = fn('app_private.settle_plan_billing_order');
  it('is idempotent: terminal orders are a no-op (no double release/grant)', () => {
    expect(f).toContain("if v_order.status not in ('pending', 'requires_action', 'processing') then return");
  });
  it('success → order succeeded + period paid + grant occurrences once', () => {
    expect(f).toContain("update public.payment_orders");
    expect(f).toContain("status = 'succeeded'");
    expect(f).toContain("set status = 'paid'");
    expect(f).toContain("'plan-billing:' || p_order::text"); // grant guard key
    expect(f).toContain("allowance_credits_granted = occurrences_count");
  });
  it('processing → order processing + period processing together', () => {
    expect(f).toMatch(/p_outcome = 'processing'[\s\S]*status = 'processing'[\s\S]*status = 'processing'/);
  });
  it('authentication/missing-method → requires_action + action_required, credit RETAINED', () => {
    expect(f).toContain("p_outcome in ('authentication_required', 'payment_method_missing', 'stripe_customer_missing')");
    expect(f).toContain("set status = 'requires_action'");
    expect(f).toContain("set status = 'action_required'");
    // The recoverable branch must NOT release credit (no issue_account_credit inside it).
    const recover = f.slice(f.indexOf("p_outcome in ('authentication_required'"), f.indexOf("-- ---------------- TRANSIENT"));
    expect(recover).not.toContain('issue_account_credit');
  });
  it('transient provider_error resets to the retryable pair (never terminal-with-pending)', () => {
    const t = f.slice(f.indexOf("p_outcome = 'provider_error'"), f.indexOf('-- ---------------- TERMINAL'));
    expect(t).toContain("set status = 'pending'");
    expect(t).toContain("set status = 'payment_pending'");
    expect(t).not.toContain('issue_account_credit'); // credit retained for retry
  });
  it('terminal failure → failed + payment_failed, releases credit once, no grant', () => {
    const term = f.slice(f.indexOf('-- ---------------- TERMINAL'));
    expect(term).toContain("status = case when p_outcome = 'expired' then 'expired' else 'failed' end");
    expect(term).toContain("set status = 'payment_failed'");
    expect(term).toContain("'release-' || v_order.id::text"); // idempotent single release
    expect(term).toContain("'plan_billing_failed'");
    expect(term).not.toContain("entry_type, quantity"); // never grants allowance on failure
  });
  it('keeps the safe failure codes and stores no raw Stripe object', () => {
    for (const code of ['card_declined', 'payment_cancelled', 'authentication_required',
                        'payment_method_missing', 'stripe_customer_missing', 'provider_error']) {
      expect(f).toContain(`'${code}'`);
    }
  });
});

describe('0043 finalise_paid_order delegates plan_period to the authority', () => {
  const f = fn('app_private.finalise_paid_order');
  it('routes plan_period orders through settle_plan_billing_order', () => {
    expect(f).toContain("if v_order.order_type = 'plan_period' then");
    expect(f).toContain('perform app_private.settle_plan_billing_order(p_order, p_outcome, p_intent, null)');
  });
  it('leaves the trial/one-off funded-booking path intact', () => {
    expect(f).toContain('insert into public.bookings');
    expect(f).toContain("'release-' || v_order.id::text");
  });
});

describe('0043 renewal treats payment_failed as terminal', () => {
  it('renew_plan_billing_period and process_plan_renewals both skip payment_failed', () => {
    expect(fn('public.renew_plan_billing_period')).toContain(
      "('paid', 'processing', 'payment_pending', 'action_required', 'payment_failed', 'closed')");
    expect(fn('public.process_plan_renewals')).toContain("'payment_failed', 'closed'");
  });
});

describe('0043 repairs existing inconsistent rows', () => {
  it('backfills failed/requires_action/processing/succeeded periods to match the order', () => {
    expect(SQL).toContain("po.status = 'failed'");
    expect(SQL).toContain("set status = 'payment_failed'");
    expect(SQL).toContain("po.status = 'requires_action'");
    expect(SQL).toContain("po.status = 'succeeded'");
  });
});

describe('stripe-billing routes ALL state through settle_plan_billing', () => {
  it('charge_due makes no direct payment_orders/plan_billing_periods writes', () => {
    const chunk = BILLING.slice(BILLING.indexOf("action === 'charge_due'"), BILLING.indexOf("action === 'complete_period'"));
    expect(chunk).not.toContain("from('payment_orders').update");
    expect(chunk).not.toContain("from('plan_billing_periods').update");
    expect(chunk).not.toContain('finalize_paid_order');
    expect(chunk).toContain('settle(order.id'); // all transitions via the single-authority helper
    // …and that helper is the settle_plan_billing RPC.
    expect(BILLING).toContain("rpc('settle_plan_billing', { p_order: order, p_outcome: outcome");
  });
  it('maps only safe codes and never persists a raw Stripe error', () => {
    expect(BILLING).toContain("settle(order.id, 'stripe_customer_missing')");
    expect(BILLING).toContain("settle(order.id, 'payment_method_missing')");
    expect(BILLING).toContain("settle(order.id, 'authentication_required')");
    expect(BILLING).toContain("settle(order.id, 'card_declined')");
    expect(BILLING).toContain("settle(order.id, 'provider_error')");
    expect(BILLING).not.toMatch(/failure_reason:\s*JSON\.stringify/);
  });
});

describe('0045 public reconciliation wrapper — service-role only', () => {
  it('exposes public.plan_billing_state_drift returning integer, delegating to the private fn', () => {
    expect(DRIFT).toContain('create or replace function public.plan_billing_state_drift()');
    expect(DRIFT).toContain('returns integer');
    expect(DRIFT).toContain('security definer');
    expect(DRIFT).toContain("set search_path = ''");
    expect(DRIFT).toContain('select app_private.plan_billing_state_drift();');
  });
  it('is denied to public/anon/authenticated and granted only to service_role', () => {
    expect(DRIFT).toContain('revoke all on function public.plan_billing_state_drift() from public, anon, authenticated');
    expect(DRIFT).toContain('grant execute on function public.plan_billing_state_drift() to service_role');
    expect(DRIFT).not.toMatch(/grant execute[^;]*\b(anon|authenticated)\b/);
  });
  it('keeps the internal function private (no PostgREST exposure of app_private)', () => {
    expect(DRIFT).not.toMatch(/create or replace function app_private\./);
    expect(DRIFT).toContain("select pg_notify('pgrst', 'reload schema')");
  });
});

describe('cancellation still maps to the safe payment_cancelled code (relocated by 3D-B1)', () => {
  it('webhook forwards the distinct canceled provider status through the reconcile path', () => {
    expect(WEBHOOK).toContain("event.type === 'payment_intent.canceled' ? 'canceled' : 'failed'");
    expect(WEBHOOK).toContain("rpc('reconcile_payment_order'");
  });
  it('0080 reconcile translates canceled → payment_cancelled for the SAME 0043 authority', () => {
    const M80 = readFileSync(join(ROOT, 'supabase', 'migrations', '0080_durable_customer_payment_recovery.sql'), 'utf-8');
    expect(M80).toContain("case when v_status = 'canceled' then 'payment_cancelled' else 'failed' end");
  });
});
