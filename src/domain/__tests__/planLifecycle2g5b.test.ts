/**
 * 2G5B lifecycle fix — plan acceptance + billing activation contracts (0041).
 * Idempotent companion accept/decline with coordinator notifications, and a
 * coordinator-consented activation that never enables billing on acceptance
 * alone or without a usable payment method.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const SQL = readFileSync(join(ROOT, 'supabase', 'migrations', '0041_plan_acceptance_billing_activation.sql'), 'utf-8');
const REPO = readFileSync(join(ROOT, 'src', 'repositories', 'planBillingRepository.ts'), 'utf-8');
const HOME = readFileSync(join(ROOT, 'src', 'pages', 'Home.tsx'), 'utf-8');
const DETAIL = readFileSync(join(ROOT, 'src', 'pages', 'PlanDetail.tsx'), 'utf-8');

describe('0041 accept_plan', () => {
  const fn = SQL.slice(SQL.indexOf('create or replace function public.accept_plan'),
    SQL.indexOf('create or replace function public.decline_plan'));
  it('stays companion-only, requested-gated, with the recurring-conflict guard', () => {
    expect(fn).toContain('app_private.can_edit_profile(v.companion_profile_id)');
    expect(fn).toContain("raise exception 'plan_not_active");
    expect(fn).toContain("'recurring_conflict:");
  });
  it('is idempotent and notifies the coordinator — but never enables billing', () => {
    expect(fn).toContain("if v.status = 'active' then");
    expect(fn).toContain("'repeat', true");
    expect(fn).toContain("'plan_accepted', 'Plan accepted'");
    expect(fn).toContain("'plan-accepted:' || p_plan::text");
    expect(fn).not.toContain('billing_enabled = true'); // acceptance never charges
  });
});

describe('0041 decline_plan', () => {
  const fn = SQL.slice(SQL.indexOf('create or replace function public.decline_plan'),
    SQL.indexOf('create or replace function public.activate_plan_billing'));
  it('is companion-only, idempotent, and notifies the coordinator', () => {
    expect(fn).toContain('app_private.can_edit_profile(v.companion_profile_id)');
    expect(fn).toContain("if v.status = 'declined' then");
    expect(fn).toContain("'plan_declined', 'Plan not taken up'");
    expect(fn).toContain("'plan-declined:' || p_plan::text");
  });
});

describe('0041 activate_plan_billing', () => {
  const fn = SQL.slice(SQL.indexOf('create or replace function public.activate_plan_billing'));
  it('is coordinator-scoped with neutral not-found', () => {
    expect(fn).toContain('v.created_by_account_id <> auth.uid()');
    expect(fn).toContain("raise exception 'not_found: plan'");
  });
  it('requires an accepted plan AND a usable payment method; is idempotent', () => {
    expect(fn).toContain("if v.status <> 'active' then");
    expect(fn).toContain('payment_method_ready = true');
    expect(fn).toContain("raise exception 'payment_method_required");
    expect(fn).toContain("if v.billing_enabled then");
    expect(fn).toContain('update public.conversation_plans set billing_enabled = true');
  });
  it('is authenticated (internally gated) — never anon', () => {
    expect(SQL).toContain('revoke all on function public.activate_plan_billing(uuid) from public, anon');
    expect(SQL).toContain('grant execute on function public.activate_plan_billing(uuid) to authenticated');
  });
});

describe('frontend wiring', () => {
  it('the companion plan-request surface is gated on the REAL account role', () => {
    expect(HOME).toContain("accountRole === 'companion' && <CompanionPlanRequests />");
    expect(HOME).toContain('useAccountRole');
  });
  it('the repository activation sends only the plan id and maps the payment-method error', () => {
    expect(REPO).toContain("rpc('activate_plan_billing', { p_plan: planId })");
    expect(REPO).toContain('payment_method_required');
    expect(REPO).not.toMatch(/p_amount|billing_enabled: true/);
  });
  it('the plan detail no longer claims weekly renewal / no-payment, and shows the activation step', () => {
    expect(DETAIL).not.toContain('renew weekly');
    expect(DETAIL).not.toContain('no payment is currently taken');
    expect(DETAIL).toContain('PlanBillingActivationCard');
    expect(DETAIL).toContain('10% monthly-plan discount');
    expect(DETAIL).toContain('Accepted · billing setup required');
  });
});
