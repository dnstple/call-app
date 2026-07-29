/**
 * 2G5B — recurring-billing charge engine contracts (migration 0040).
 *
 * Static contract tests: billed plans draw down the funded allowance (no
 * self-grant); allowance is granted only on confirmed finalisation and never
 * fewer than the occurrence count; credit-first; idempotent per (plan,period);
 * service-role only; the trial/one-off booking path is preserved; no transfers.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const SQL = readFileSync(join(ROOT, 'supabase', 'migrations', '0040_recurring_billing_engine.sql'), 'utf-8');
const FN = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-billing', 'index.ts'), 'utf-8');
const REPO = readFileSync(join(ROOT, 'src', 'repositories', 'planBillingRepository.ts'), 'utf-8');
const CODE = SQL.replace(/--.*$/gm, '');

describe('0040 additive marker + statuses', () => {
  it('adds billing_enabled (default false) and the new period states', () => {
    expect(SQL).toContain('add column if not exists billing_enabled boolean not null default false');
    expect(SQL).toContain("'payment_pending', 'processing', 'paid', 'payment_failed'");
    expect(SQL).toContain("'action_required'");
    expect(SQL).toContain('add column if not exists allowance_purchase_id');
  });
});

describe('0040 billed generation gate (extend_plan_bookings)', () => {
  const fn = SQL.slice(
    SQL.indexOf('create or replace function public.extend_plan_bookings'),
    SQL.indexOf('create or replace function app_private.finalise_paid_order'));

  it('billed plans refuse to book unfunded occurrences (retriable skip)', () => {
    expect(fn).toContain('if v.billing_enabled');
    expect(fn).toContain('app_private.plan_allowance_remaining(v.allowance_purchase_id) < 1');
    expect(fn).toContain("errcode = 'P2E42'");
    expect(fn).toContain("'skipped_unfunded'");
    expect(SQL).toContain("'skipped_by_request', 'skipped_unfunded'"); // added to the outcome CHECK
  });

  it('billed plans reserve WITHOUT self-granting; unbilled plans self-grant unchanged', () => {
    expect(fn).toContain('if not v.billing_enabled then');
    // The grant is inside the not-billed branch; the reserve is unconditional.
    const grantIdx = fn.indexOf("'grant', 1");
    const notBilledIdx = fn.indexOf('if not v.billing_enabled then');
    expect(notBilledIdx).toBeLessThan(grantIdx);
    expect(fn).toContain("'reserve', 1");
  });

  it('allowance-remaining matches the deployed balance formula', () => {
    expect(SQL).toContain('function app_private.plan_allowance_remaining(p_purchase uuid)');
    expect(SQL).toContain("filter (where entry_type in ('grant', 'adjustment'))");
    expect(SQL).toContain("filter (where entry_type = 'reserve')");
    expect(SQL).toContain("filter (where entry_type = 'consume')");
  });
});

describe('0040 finalisation branch (allowance top-up)', () => {
  const fn = SQL.slice(
    SQL.indexOf('create or replace function app_private.finalise_paid_order'),
    SQL.indexOf('create or replace function public.renew_plan_billing_period'));

  it('plan_period success grants EXACTLY the occurrence count, once', () => {
    expect(fn).toContain("if v_order.order_type = 'plan_period' then");
    expect(fn).toContain("'grant', v_bp.occurrences_count");
    expect(fn).toContain("reason = 'plan-billing:' || p_order::text"); // idempotency guard
    expect(fn).toContain("status = 'paid', allowance_credits_granted = occurrences_count");
    expect(fn).toContain("'plan_billed', 'Plan payment received'");
  });

  it('allowance is granted ONLY on success (never before finalisation)', () => {
    // The grant sits strictly inside the succeeded branch.
    const successIdx = fn.indexOf("if p_outcome = 'succeeded' then");
    const grantIdx = fn.indexOf('insert into public.package_credit_ledger');
    expect(successIdx).toBeGreaterThan(-1);
    expect(grantIdx).toBeGreaterThan(successIdx);
    expect(fn).toContain("'plan_billing_failed'"); // failure notifies, releases credit
    expect(fn).toContain("'release-' || v_order.id::text");
  });

  it('the trial/one-off booking path is preserved', () => {
    expect(fn).toContain('insert into public.bookings');
    expect(fn).toContain("v_order.order_type = 'trial'");
  });
});

describe('0040 renewal engine', () => {
  const fn = SQL.slice(
    SQL.indexOf('create or replace function public.renew_plan_billing_period'),
    SQL.indexOf('create or replace function public.process_plan_renewals'));

  it('is idempotent per (plan, period) and service-role only', () => {
    expect(fn).toContain('for update'); // locks plan + period rows
    expect(fn).toContain("('paid', 'processing', 'payment_pending', 'action_required', 'closed')");
    expect(fn).toContain("'repeat', true");
    expect(fn).toContain("'plan-bill-' || p_plan::text || '-' || p_period_start::text");
    expect(SQL).toContain('grant execute on function public.renew_plan_billing_period(uuid, date) to service_role');
    expect(SQL).not.toMatch(/grant execute on function public\.renew_plan_billing_period\([^)]*\) to (authenticated|anon)/);
  });

  it('applies credit FIRST and finalises with no Stripe when card is zero', () => {
    expect(fn).toContain('spend_account_credit');
    expect(fn).toContain('least(v_credit, v_net)');
    expect(fn).toContain('if v_card = 0 then');
    expect(fn).toContain("perform app_private.finalise_paid_order(v_order_id, 'succeeded', null)");
  });

  it('never trusts client amounts; prices from occurrences × price − 10%', () => {
    expect(fn).toContain('v_gross := v_occ * v_per');
    expect(fn).toContain('v_discount := (v_gross * 10) / 100');
    expect(fn).not.toMatch(/p_amount|p_gross|p_card|p_credit/);
  });

  it('handles zero-occurrence periods safely (closed, no order)', () => {
    expect(fn).toContain('if v_net = 0 then');
    expect(fn).toContain("'closed'");
  });
});

describe('0040 orchestrator + schedule', () => {
  it('bills the current month once, one worker per plan (SKIP LOCKED), service-only', () => {
    const fn = SQL.slice(SQL.indexOf('create or replace function public.process_plan_renewals'));
    expect(fn).toContain("date_trunc('month', now())::date");
    expect(fn).toContain('for update of p skip locked');
    expect(fn).toContain("bp.status in ('paid', 'processing', 'payment_pending', 'action_required', 'closed')");
    expect(SQL).toContain('grant execute on function public.process_plan_renewals() to service_role');
  });

  it('registers pg_cron guarded + idempotently', () => {
    expect(SQL).toContain("select 1 from pg_available_extensions where name = 'pg_cron'");
    expect(SQL).toContain("'process-plan-renewals'");
    expect(SQL).toContain('exception when others then');
  });

  it('creates no Stripe transfer/payout anywhere in the migration', () => {
    expect(CODE).not.toMatch(/transfers?\s*\.\s*create|payout/i);
  });
});

describe('stripe-billing edge function + repository', () => {
  it('charges off-session; service action is secret-gated; no client amount', () => {
    expect(FN).toContain('off_session: true');
    expect(FN).toContain('confirm: true');
    expect(FN).toContain("x-billing-secret");
    expect(FN).toContain("order.card_amount_minor"); // amount comes from the server order
    expect(FN).toContain("authentication_required");
    expect(FN).toContain("finalize_paid_order"); // decline releases via finalisation
    expect(FN).toContain('sk_test_'); // test-mode only guard
  });

  it('repository completes an action-required period via the hosted flow, sending no amount', () => {
    expect(REPO).toContain("functions.invoke('stripe-billing'");
    expect(REPO).toContain("action: 'complete_period'");
    expect(REPO).toContain('order_id: orderId');
    // The invoke body carries only the order id + origin — no monetary value.
    const invoke = REPO.slice(REPO.indexOf("functions.invoke('stripe-billing'"), REPO.indexOf('if (error) throw mapError(error);\n  const d ='));
    expect(invoke).not.toMatch(/amount|minor|price/i);
  });
});
