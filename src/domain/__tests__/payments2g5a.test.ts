/**
 * 2G5A — recurring billing FOUNDATION contracts (migration 0039).
 *
 * Static contract tests over the additive, read-only billing-period model and
 * the coordinator-scoped preview: credit-first invariants, the 10% monthly
 * discount, calendar-safe periods, coordinator scoping, and the guarantee that
 * NO money moves and NO existing safeguard is touched.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const SQL = readFileSync(join(ROOT, 'supabase', 'migrations', '0039_recurring_billing_foundation.sql'), 'utf-8');
const REPO = readFileSync(join(ROOT, 'src', 'repositories', 'planBillingRepository.ts'), 'utf-8');
const CODE = SQL.replace(/--.*$/gm, ''); // comment-stripped, for negatives

describe('0039 billing-period model', () => {
  it('is additive: creates the period table, changes no existing table/function', () => {
    expect(SQL).toContain('create table if not exists public.plan_billing_periods');
    expect(SQL).not.toMatch(/alter table public\.(conversation_plans|package_purchases|bookings|companion_earnings)/);
    expect(SQL).not.toMatch(/drop (table|function|trigger)/i);
  });

  it('enforces credit-first + discount invariants at the schema level', () => {
    expect(SQL).toContain('check (net_minor = gross_minor - discount_minor)');
    expect(SQL).toContain('check (credit_applied_minor + card_amount_minor = net_minor)');
    expect(SQL).toContain('unique (plan_id, period_start)');
  });

  it('is coordinator-read-only: RLS select for the payer, no client write policy', () => {
    expect(SQL).toContain('alter table public.plan_billing_periods enable row level security');
    expect(SQL).toContain('for select to authenticated using (coordinator_account_id = auth.uid())');
    expect(SQL).not.toMatch(/for (insert|update|delete) to authenticated/);
  });
});

describe('0039 period preview', () => {
  const fn = SQL.slice(SQL.indexOf('function public.preview_plan_billing_period'));

  it('is coordinator-scoped with a neutral error', () => {
    expect(fn).toContain('v_plan.created_by_account_id <> auth.uid()');
    expect(fn).toContain("raise exception 'not_found: plan'");
  });

  it('prices from real occurrences with a 10% monthly discount', () => {
    expect(fn).toContain('from public.plan_schedule_slots s');
    expect(fn).toContain('extract(isodow from d.day)::int = s.iso_day');
    expect(fn).toContain('v_gross := v_occ * v_per');
    expect(fn).toContain('v_discount := (v_gross * 10) / 100');
    expect(fn).toContain('v_net := v_gross - v_discount');
  });

  it('applies account credit BEFORE card (credit-first)', () => {
    expect(fn).toContain('v_credit_applied := least(v_credit, v_net)');
    expect(fn).toContain("'card_amount_minor', v_net - v_credit_applied");
    // Only non-expired credit counts.
    expect(fn).toContain("(expires_at is null or expires_at > now())");
  });

  it('uses calendar-safe monthly bounds', () => {
    expect(SQL).toContain('function app_private.monthly_period_end(p_start date)');
    expect(SQL).toContain("(p_start + interval '1 month')::date");
    expect(fn).toContain('app_private.monthly_period_end(p_period_start)');
  });

  it('moves NO money and touches no completed safeguard', () => {
    // The preview never writes, never issues credit, never creates an order.
    expect(fn).not.toMatch(/insert\s+into/i);
    expect(fn).not.toMatch(/update\s+public\./i);
    expect(fn).not.toMatch(/issue_account_credit|make_earning_payable|create_paid_request|finalize_paid_order/i);
    expect(CODE).not.toMatch(/stripe|payment_intent|transfer/i);
    expect(fn).toContain("'estimate', true");
  });

  it('is authenticated-only (internally coordinator-scoped)', () => {
    expect(SQL).toContain('revoke all on function public.preview_plan_billing_period(uuid, date) from public, anon');
    expect(SQL).toContain('grant execute on function public.preview_plan_billing_period(uuid, date) to authenticated');
  });
});

describe('repository sends only safe inputs; never prices client-side', () => {
  it('preview passes only plan id + period start', () => {
    expect(REPO).toContain("rpc('preview_plan_billing_period'");
    expect(REPO).toContain('p_plan: planId');
    expect(REPO).toContain('p_period_start: periodStart');
    expect(REPO).not.toMatch(/p_gross|p_price|p_discount|p_credit|p_amount/);
  });

  it('periods are read through RLS (coordinator reads own), never a privileged join', () => {
    expect(REPO).toContain("from('plan_billing_periods')");
    expect(REPO).not.toMatch(/service_role|admin/i);
  });
});
