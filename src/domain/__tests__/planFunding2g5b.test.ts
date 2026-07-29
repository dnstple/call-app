/**
 * 2G5B correction — explicit funding mode (0042). A newly requested plan is
 * 'recurring' and never self-grants; acceptance generates nothing for it; the
 * funding gate precedes the availability check; and legacy self-granting is
 * reachable only for explicitly-marked 'simulated' plans.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const SQL = readFileSync(join(ROOT, 'supabase', 'migrations', '0042_plan_funding_mode.sql'), 'utf-8');

function fn(name: string): string {
  const start = SQL.indexOf(`create or replace function public.${name}`);
  const end = SQL.indexOf('\n$$;', start);
  return SQL.slice(start, end);
}

describe('0042 funding_mode column', () => {
  it('adds an explicit, checked funding mode defaulting to legacy simulated', () => {
    expect(SQL).toContain("add column if not exists funding_mode text not null default 'simulated'");
    expect(SQL).toContain("check (funding_mode in ('simulated', 'recurring'))");
  });
});

describe('0042 create_conversation_plan', () => {
  const f = fn('create_conversation_plan');
  it('creates new plans as recurring (never self-granting)', () => {
    expect(f).toContain('request_message, funding_mode');
    expect(f).toContain("nullif(trim(coalesce(p_message, '')), ''), 'recurring'");
  });
});

describe('0042 accept_plan', () => {
  const f = fn('accept_plan');
  it('generates nothing for a recurring plan — extend runs only for legacy simulated', () => {
    // The ONLY call to extend_plan_bookings is inside the simulated branch.
    expect(f).toContain("if v.funding_mode = 'simulated' then");
    const guardIdx = f.indexOf("if v.funding_mode = 'simulated' then");
    const extendIdx = f.indexOf('public.extend_plan_bookings(p_plan)');
    expect(extendIdx).toBeGreaterThan(guardIdx);
    expect(f.match(/extend_plan_bookings/g) ?? []).toHaveLength(1);
    // Recurring acceptance returns a no-generation result.
    expect(f).toContain("'generated', 0, 'skipped', 0, 'preview', v_preview");
  });
  it('still validates the companion, requested-gate, conflict and notifies', () => {
    expect(f).toContain('app_private.can_edit_profile(v.companion_profile_id)');
    expect(f).toContain("'recurring_conflict:");
    expect(f).toContain("'plan-accepted:' || p_plan::text");
    expect(f).toContain("if v.status = 'active' then"); // idempotent
  });
});

describe('0042 extend_plan_bookings', () => {
  const f = fn('extend_plan_bookings');
  it('gates on funded allowance for recurring plans BEFORE the availability check', () => {
    const fundIdx = f.indexOf("v.funding_mode = 'recurring'");
    const availIdx = f.indexOf('slot_within_availability');
    expect(fundIdx).toBeGreaterThan(-1);
    expect(availIdx).toBeGreaterThan(fundIdx); // unfunded ⇒ only skipped_unfunded
    expect(f).toContain("errcode = 'P2E42'");
  });
  it('self-grants ONLY for legacy simulated plans', () => {
    expect(f).toContain("if v.funding_mode = 'simulated' then");
    // The grant ledger insert is inside that branch; reserve is unconditional.
    const grantIdx = f.indexOf("'grant', 1, auth.uid(), 'Weekly plan allowance'");
    const simIdx = f.indexOf("if v.funding_mode = 'simulated' then\n                insert");
    expect(simIdx).toBeGreaterThan(-1);
    expect(grantIdx).toBeGreaterThan(simIdx);
  });
});

describe('0042 billing is recurring-only', () => {
  it('activate_plan_billing and process_plan_renewals apply only to recurring plans', () => {
    expect(fn('activate_plan_billing')).toContain("if v.funding_mode <> 'recurring' then");
    expect(fn('process_plan_renewals')).toContain("p.funding_mode = 'recurring'");
  });
});
