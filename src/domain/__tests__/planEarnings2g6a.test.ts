/**
 * 2G6A contracts — recurring-plan companion earnings (0046). A plan occurrence
 * earns only when its calendar-month billing period is 'paid'; the amount comes
 * from the booking snapshot; issue resolution is occurrence-scoped; simulated /
 * unpaid occurrences never earn; the machinery stays private and server-driven.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const SQL = readFileSync(join(ROOT, 'supabase', 'migrations', '0046_recurring_plan_earnings.sql'), 'utf-8');

function fn(name: string): string {
  const start = SQL.indexOf(`create or replace function ${name}`);
  const end = SQL.indexOf('\n$$;', start);
  return SQL.slice(start, end);
}

describe('0046 snapshot columns + backfill', () => {
  it('adds nullable plan/period/payer-charge snapshot columns to companion_earnings', () => {
    expect(SQL).toContain('add column if not exists plan_id uuid references public.conversation_plans(id)');
    expect(SQL).toContain('add column if not exists plan_billing_period_id uuid references public.plan_billing_periods(id)');
    expect(SQL).toContain('add column if not exists payer_charge_minor integer');
  });
  it('backfills payer_charge_minor for existing directly-funded earnings from the order total', () => {
    expect(SQL).toContain('set payer_charge_minor = po.total_minor');
    expect(SQL).toContain('and e.payer_charge_minor is null');
  });
});

describe('0046 ensure_companion_earning', () => {
  const f = fn('app_private.ensure_companion_earning');
  it('keeps the directly-funded (one-off/trial) order path', () => {
    expect(f).toContain("where booking_id = p_booking and provider = 'stripe_test' and status = 'succeeded'");
    expect(f).toContain('v_order.subtotal_minor - v_order.discount_minor - v_order.commission_minor');
  });
  it('adds a recurring-plan path gated on a PAID covering billing period', () => {
    expect(f).toContain("v_b.booking_source <> 'package_credit'");
    expect(f).toContain("v_plan.funding_mode <> 'recurring'"); // simulated plans never earn
    expect(f).toContain("where plan_id = v_b.plan_id and status = 'paid'");
    expect(f).toContain("period_start = date_trunc('month', (v_b.starts_at at time zone v_b.timezone))::date");
    expect(f).toContain("v_order.status <> 'succeeded'"); // funding order must have succeeded
  });
  it('snapshots the amount from the BOOKING, never a client value', () => {
    expect(f).toContain('v_net        := v_b.companion_amount_minor');
    expect(f).toContain('v_basis      := v_b.price_minor');
    expect(f).toContain('v_charge     := round(v_period.net_minor::numeric / v_period.occurrences_count)::integer');
  });
  it('is idempotent by booking and private', () => {
    expect(f).toContain('on conflict (booking_id) do nothing');
    expect(SQL).toContain('revoke all on function app_private.ensure_companion_earning(uuid) from public, anon, authenticated');
  });
});

describe('0046 resolve_conversation_issue is occurrence-scoped', () => {
  const f = fn('public.resolve_conversation_issue');
  it('caps customer credit / partial by the per-occurrence payer_charge (order total for one-offs)', () => {
    expect(f).toContain('v_charge := coalesce(v_e.payer_charge_minor, v_order.total_minor)');
    expect(f).toContain('p_companion_minor := 0; p_credit_minor := v_charge;');
    expect(f).toContain('p_credit_minor > v_charge');
    expect(f).toContain('(p_companion_minor + p_credit_minor) > v_charge');
  });
  it('still gates on support admin and preserves the four outcomes', () => {
    expect(f).toContain('if not app_private.is_support_admin()');
    for (const o of ['companion_payable_full', 'customer_credit_full', 'partial_resolution', 'issue_dismissed_release']) {
      expect(f).toContain(`'${o}'`);
    }
  });
});

describe('0046 resolve_unconfirmed_attendance covers plan occurrences', () => {
  const f = fn('public.resolve_unconfirmed_attendance');
  it('broadens eligibility to recurring-plan bookings with a paid period', () => {
    expect(f).toContain("p.funding_mode = 'recurring'");
    expect(f).toContain("bp.status = 'paid'");
    expect(f).toContain("period_start = date_trunc('month', (b.starts_at at time zone b.timezone))::date");
  });
  it('stays service-role only', () => {
    expect(SQL).toContain('revoke all on function public.resolve_unconfirmed_attendance() from public, anon, authenticated');
    expect(SQL).toContain('grant execute on function public.resolve_unconfirmed_attendance() to service_role');
  });
});
