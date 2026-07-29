/**
 * 2G5B charge_due scheduler contracts (0044). The daily job reads the project
 * URL and cron secret ONLY from Supabase Vault, hardcodes no secret, keeps the
 * helper private, installs idempotently at 06:10 UTC, and posts exactly
 * {"action":"charge_due"}.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const SQL = readFileSync(join(ROOT, 'supabase', 'migrations', '0044_plan_billing_charge_schedule.sql'), 'utf-8');

describe('0044 charge_due scheduler', () => {
  it('reads URL and secret ONLY from Vault', () => {
    expect(SQL).toContain("from vault.decrypted_secrets where name = 'billing_project_url'");
    expect(SQL).toContain("from vault.decrypted_secrets where name = 'billing_cron_secret'");
  });
  it('contains no literal secret or service-role key', () => {
    expect(SQL).not.toMatch(/sk_(test|live)_/);
    expect(SQL).not.toMatch(/service_role/);
    expect(SQL).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // no JWT-shaped literal
    expect(SQL).not.toMatch(/whsec_/);
  });
  it('posts to the Edge Function with the vault secret header and exact body', () => {
    expect(SQL).toContain("v_url || '/functions/v1/stripe-billing'");
    expect(SQL).toContain("'x-billing-secret', v_secret");
    expect(SQL).toContain("jsonb_build_object('action', 'charge_due')");
    expect(SQL).toContain('timeout_milliseconds :=');
  });
  it('keeps the helper private (revoked from every client role)', () => {
    expect(SQL).toContain('create or replace function app_private.invoke_plan_billing_charge_due()');
    expect(SQL).toContain('revoke all on function app_private.invoke_plan_billing_charge_due() from public, anon, authenticated');
  });
  it('installs idempotently: reuse-by-name, no duplicates, 06:10 UTC', () => {
    expect(SQL).toContain("from cron.job where jobname = 'charge-due-plan-periods'");
    expect(SQL).toContain('cron.unschedule(jobid)');
    expect(SQL).toContain("cron.schedule('charge-due-plan-periods', '10 6 * * *'");
  });
  it('skips cleanly (no partial job) when Vault entries are absent', () => {
    expect(SQL).toContain('NOT scheduled');
    expect(SQL).toMatch(/if v_url is null or v_secret is null then[\s\S]*return;/);
  });
  it('never returns/logs the decrypted secret', () => {
    // The only NOTICEs must not interpolate v_secret.
    const notices = SQL.match(/raise notice[^;]*/g) ?? [];
    for (const n of notices) expect(n).not.toContain('v_secret');
  });
});
