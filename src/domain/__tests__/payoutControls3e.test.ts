/**
 * Stage 3E-B — transfer rollout-control hardening contracts (migration 0084).
 *
 * Functional proofs (allowlist deny/allow/deactivate, daily-ceiling
 * arithmetic incl. exact boundary, production_live behaviour, audit events)
 * ran on scratch Postgres — see the Stage 3E audit §13/§14. These contracts
 * pin the migration's structure so a future edit cannot silently weaken it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const M84 = readFileSync(join(ROOT, 'supabase', 'migrations', '0084_transfer_rollout_controls_hardening.sql'), 'utf-8');

describe('0084 is additive and fail-closed', () => {
  it('contains no destructive statements', () => {
    expect(M84).not.toMatch(/drop\s+table/i);
    expect(M84).not.toMatch(/drop\s+column/i);
    expect(M84).not.toMatch(/delete\s+from/i);
    expect(M84).not.toMatch(/truncate/i);
  });
  it('daily ceiling defaults to 0 (deny) with a non-negative check', () => {
    expect(M84).toMatch(/provider_transfer_daily_ceiling_minor integer not null default 0\s*\n\s*check \(provider_transfer_daily_ceiling_minor >= 0\)/);
  });
  it('allowlist tables are RLS-forced with NO client policies', () => {
    for (const t of ['transfer_destination_allowlist', 'transfer_destination_allowlist_events']) {
      expect(M84).toContain(`alter table public.${t} enable row level security`);
      expect(M84).toContain(`alter table public.${t} force row level security`);
    }
    expect(M84).not.toMatch(/create policy[\s\S]{0,120}transfer_destination_allowlist/);
  });
});

describe('0084 support management is gated and audited', () => {
  it('mutation requires support admin, a valid acct_ id and a reason', () => {
    expect(M84).toContain("if not app_private.is_support_admin() then");
    expect(M84).toContain("p_stripe_account_id !~ '^acct_[A-Za-z0-9]+$'");
    expect(M84).toContain("raise exception 'reason_required'");
  });
  it('every change writes an immutable event row', () => {
    const fn = M84.slice(M84.indexOf('support_set_transfer_destination_allowlist'), M84.indexOf('support_list_transfer_destination_allowlist'));
    const inserts = fn.match(/insert into public\.transfer_destination_allowlist_events/g) ?? [];
    expect(inserts.length).toBeGreaterThanOrEqual(2); // insert + update branches
  });
  it('management functions are revoked from public/anon', () => {
    expect(M84).toContain('revoke all on function public.support_set_transfer_destination_allowlist(text, boolean, text)\n  from public, anon');
    expect(M84).toContain('revoke all on function public.support_list_transfer_destination_allowlist() from public, anon');
  });
});

describe('0084 guard semantics', () => {
  it('outside production_live the destination MUST be actively allowlisted (empty list = deny all)', () => {
    expect(M84).toMatch(/if v_env <> 'production_live' then[\s\S]{0,300}destination_not_allowlisted/);
    expect(M84).toContain('where a.stripe_account_id = p_destination and a.active');
  });
  it('daily aggregate counts EVERY attempt holding a provider transfer id (uncertain included)', () => {
    expect(M84).toContain('where t.stripe_transfer_id is not null');
    expect(M84).toContain("date_trunc('day', now() at time zone 'utc')");
    expect(M84).toContain('daily_ceiling_exceeded');
  });
  it('the guard function is not executable by clients', () => {
    expect(M84).toContain('revoke all on function app_private.transfer_rollout_denial(text, integer) from public, anon, authenticated');
  });
});

describe('0084 enforcement point — authorize_scoped_transfer_create', () => {
  const fn = M84.slice(M84.indexOf('create or replace function app_private.authorize_scoped_transfer_create'));
  it('keeps every 0078 precondition (lease, fresh lookup, run executing, controls, attempt state)', () => {
    for (const guard of ['invalid_lease', 'lease_expired', 'lookup_required', 'lookup_stale',
      'run_not_executing', 'control_disabled', 'attempt_state_changed']) {
      expect(fn).toContain(guard);
    }
  });
  it('runs the rollout guard AFTER locking the attempt and BEFORE any state change to provider_create_pending', () => {
    const lock = fn.indexOf('for update');
    const guard = fn.indexOf('transfer_rollout_denial');
    const pending = fn.indexOf("state = 'provider_create_pending'");
    expect(guard).toBeGreaterThan(lock);
    expect(guard).toBeLessThan(pending);
  });
  it('denial is audited once (idempotent event) and aborts with a stable code', () => {
    expect(fn).toContain("'provider_create_denied'");
    expect(fn).toContain("raise exception 'rollout_denied: %', v_denial");
  });
  it('adds provider_create_denied to the cumulative action vocabulary', () => {
    expect(M84).toMatch(/add constraint financial_operation_run_events_action_check[\s\S]{0,700}'provider_create_denied'/);
  });
  it('stays service-role only', () => {
    expect(fn).toContain('revoke all on function app_private.authorize_scoped_transfer_create(uuid, text) from public, anon, authenticated');
    expect(fn).toContain('grant execute on function app_private.authorize_scoped_transfer_create(uuid, text) to service_role');
  });
});
