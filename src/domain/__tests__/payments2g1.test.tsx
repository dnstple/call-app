// @vitest-environment jsdom
/**
 * 2G1 — Stripe test-mode foundation contracts.
 *
 * The 0030 SQL contract carries the financial security assertions
 * (integer minor units, GBP-only, append-only ledger, server-only write
 * paths, snapshot columns, idempotency); the Edge Function sources carry
 * the secret-handling and webhook rules. Live money flows are QA'd
 * against Stripe test mode after deployment — nothing here pretends
 * otherwise.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const SQL = readFileSync(join(ROOT, 'supabase', 'migrations', '0030_stripe_foundation.sql'), 'utf-8');
const PAYMENTS_FN = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-payments', 'index.ts'), 'utf-8');
const WEBHOOK_FN = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-webhook', 'index.ts'), 'utf-8');
const REPO = readFileSync(join(ROOT, 'src', 'repositories', 'billingRepository.ts'), 'utf-8');

describe('0030 money + configuration contract', () => {
  it('1+2. integer minor units and GBP are structural', () => {
    expect(SQL).toMatch(/subtotal_minor integer not null/);
    expect(SQL).toMatch(/amount_minor integer not null/);
    expect(SQL).not.toMatch(/_minor (numeric|real|double|float)/); // money never floats
    expect((SQL.match(/check \(currency = 'GBP'\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('4+5. commission and fee are snapshotted onto every order', () => {
    expect(SQL).toContain('commission_rate_pct numeric(5,2) not null');
    expect(SQL).toContain('service_fee_minor integer not null');
    // Arithmetic is enforced by the database, not trusted from anywhere.
    expect(SQL).toContain('check (total_minor = subtotal_minor - discount_minor + service_fee_minor)');
    expect(SQL).toContain('check (credit_applied_minor + card_amount_minor = total_minor)');
  });

  it('6. the service fee ships as a DISABLED zero-value engine', () => {
    expect(SQL).toContain("select 'GBP', 0, 0, false");
    expect(SQL).toContain('enabled boolean not null default false');
    expect(SQL).toMatch(/fixed_minor integer not null default 0/);
    // Engine supports fixed/percent/min/max/activation without amounts baked in.
    for (const col of ['percent_rate', 'min_minor', 'max_minor', 'active_from']) {
      expect(SQL).toContain(col);
    }
  });

  it('commission seeds: trial 0%, one-off 5%, plan 5% — configurable rows, not constants', () => {
    expect(SQL).toContain("('trial', 0.00), ('one_off', 5.00), ('plan', 5.00)");
    expect(SQL).toContain('active_from timestamptz not null');
  });

  it('3+84. browsers cannot write any financial table', () => {
    // Only SELECT policies exist; not one insert/update/delete policy.
    expect(SQL).not.toMatch(/create policy .* for (insert|update|delete)/i);
    expect(SQL).toMatch(/alter table public\.payment_orders enable row level security/);
    expect(SQL).toMatch(/alter table public\.credit_ledger enable row level security/);
    expect(SQL).toMatch(/alter table public\.stripe_webhook_events enable row level security/);
    // Webhook events have NO client policies at all.
    expect(SQL).not.toMatch(/create policy .* on public\.stripe_webhook_events/);
  });

  it('9+12+13+16+17. credit: coordinator-owned, FIFO by expiry, locked, 12-month expiry', () => {
    expect(SQL).toContain('coordinator_account_id = auth.uid()');
    expect(SQL).toContain('order by expires_at asc, issued_at asc');
    expect(SQL).toContain('for update');
    expect(SQL).toContain("now() + interval '12 months'");
    expect(SQL).toContain('expires_at > now()');
  });

  it('18+29. issue/spend are idempotent and service-role-only', () => {
    expect(SQL).toContain('on conflict (idempotency_key) do nothing');
    expect(SQL).toContain('idempotency_key text not null unique');
    for (const fn of ['issue_account_credit', 'spend_account_credit']) {
      expect(SQL).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\)\\s+from public, anon, authenticated`));
      expect(SQL).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s+to service_role`));
    }
  });

  it('the ledger is append-only with full spend allocations', () => {
    expect(SQL).toContain('credit_spend_allocations');
    expect(SQL).toContain('remaining_minor integer check (remaining_minor >= 0)');
    expect(SQL).not.toMatch(/create policy .* on public\.credit_ledger[\s\S]{0,80}for update/i);
  });

  it('simulated history stays provider-separated from Stripe', () => {
    expect(SQL).toContain("provider in ('stripe_test', 'simulation')");
    expect(SQL).toContain("default 'stripe_test'");
  });
});

describe('Edge Function contracts', () => {
  it('77+78. test-mode only; secrets from Function env, never the browser', () => {
    expect(PAYMENTS_FN).toContain("startsWith('sk_test_')");
    expect(WEBHOOK_FN).toContain("startsWith('sk_test_')");
    expect(PAYMENTS_FN).toContain("Deno.env.get('STRIPE_SECRET_KEY')");
    expect(WEBHOOK_FN).toContain("Deno.env.get('STRIPE_WEBHOOK_SECRET')");
    // The frontend repository never touches Stripe SDKs or secrets.
    expect(REPO).not.toMatch(/sk_test|sk_live|STRIPE_SECRET|service_role/i);
  });

  it('79. webhook signatures verify against the RAW body, id persisted BEFORE effects', () => {
    expect(WEBHOOK_FN).toContain('await req.text()');
    // Dual-destination secrets: each attempt still verifies the RAW body.
    expect(WEBHOOK_FN).toContain('constructEventAsync(rawBody, signature, secret)');
    const persistIdx = WEBHOOK_FN.indexOf("from('stripe_webhook_events').insert");
    const effectIdx = WEBHOOK_FN.indexOf('switch (event.type)');
    expect(persistIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeLessThan(effectIdx);
    expect(WEBHOOK_FN).toContain('duplicate: true');
  });

  it('27+32. payment success comes ONLY from webhooks; metadata uses internal UUIDs', () => {
    expect(WEBHOOK_FN).toContain("case 'payment_intent.succeeded'");
    expect(WEBHOOK_FN).toContain('payment_order_id');
    expect(WEBHOOK_FN).toContain("toUpperCase() === 'GBP'");
    // The browser-facing function has no way to mark an order succeeded.
    expect(PAYMENTS_FN).not.toContain("status: 'succeeded'");
    // No Member details in Stripe metadata — internal ids only.
    expect(PAYMENTS_FN).toContain('metadata: { account_id: user!.id }');
    expect(PAYMENTS_FN).not.toMatch(/first_name|member_name|email:.*member/i);
  });

  it('every Stripe object creation carries an idempotency key', () => {
    expect(PAYMENTS_FN).toContain('idempotencyKey: `customer-');
    expect(PAYMENTS_FN).toContain('idempotencyKey: `setup-');
  });

  it('webhook handles exactly the 2G1-relevant events', () => {
    for (const evt of [
      'setup_intent.succeeded', 'checkout.session.completed',
      'payment_intent.succeeded', 'payment_intent.payment_failed',
      'payment_intent.canceled', 'account.updated',
    ]) {
      expect(WEBHOOK_FN).toContain(`'${evt}'`);
    }
    // No speculative handlers for events this phase doesn't use.
    expect(WEBHOOK_FN).not.toContain('invoice.paid');
    expect(WEBHOOK_FN).not.toContain('transfer.created');
  });
});
