/**
 * Stage 3D-B1 — durable customer-payment state and idempotent recovery.
 *
 * Source-static contracts over migration 0080 and the three payment Edge
 * Functions. The FUNCTIONAL exactly-once proofs (finalise-once, duplicate
 * reconcile, amount/currency/intent/metadata mismatch, concurrency race,
 * credit release-once, expired-order containment, owner/support access) run
 * against scratch Postgres with migrations 0001–0080 applied — see the 3D-B1
 * validation report; hosted equivalents live in rls.integration.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const M80 = readFileSync(join(ROOT, 'supabase', 'migrations', '0080_durable_customer_payment_recovery.sql'), 'utf-8');
const FN = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-payments', 'index.ts'), 'utf-8');
const WH = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-webhook', 'index.ts'), 'utf-8');
const BILL = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-billing', 'index.ts'), 'utf-8');

describe('0080 durable projection schema', () => {
  it('is additive-only on payment_orders (no destructive statements)', () => {
    expect(M80).not.toMatch(/drop\s+table/i);
    expect(M80).not.toMatch(/drop\s+column/i);
    expect(M80).not.toMatch(/alter\s+column[\s\S]{0,40}type/i);
    // Only NEW constraint names are (re)created.
    const drops = M80.match(/drop constraint if exists ([a-z_]+)/g) ?? [];
    for (const d of drops) expect(d).toMatch(/provider_payment_status|local_finalisation_status|reconciliation_code/);
  });
  it('constrains the two status columns with checks (no free text)', () => {
    expect(M80).toContain("add constraint payment_orders_provider_payment_status_check");
    expect(M80).toContain("'none', 'requires_payment_method', 'requires_confirmation', 'requires_action'");
    expect(M80).toContain("add constraint payment_orders_local_finalisation_status_check");
    expect(M80).toContain("('pending', 'finalising', 'completed', 'reconciliation_required')");
    // reconciliation_required must always carry a safe code.
    expect(M80).toContain("local_finalisation_status <> 'reconciliation_required'\n         or reconciliation_code is not null");
  });
  it('backfills historical rows once and indexes the support queue', () => {
    expect(M80).toMatch(/update public\.payment_orders[\s\S]{0,1600}where local_finalisation_status = 'pending'/);
    expect(M80).toContain('create index if not exists payment_orders_pending_paid_idx');
    expect(M80).toMatch(/where \(provider_payment_status = 'succeeded'[\s\S]{0,120}reconciliation_required'/);
  });
  it('stores no secrets: no client_secret, sk_ keys or raw provider payloads', () => {
    expect(M80).not.toMatch(/client_secret/i);
    expect(M80).not.toMatch(/sk_(test|live)_/);
    expect(M80).not.toMatch(/raw_payload|stripe_error|error_payload/i);
  });
});

describe('0080 owner-safe status RPC', () => {
  it('is ownership-scoped with a neutral not_found (no existence leak)', () => {
    expect(M80).toContain('create or replace function public.get_payment_order_status(p_order uuid)');
    expect(M80).toContain('coordinator_account_id = auth.uid()');
    expect(M80).toMatch(/if auth\.uid\(\) is null then[\s\S]{0,80}'found', false/);
  });
  it('grants authenticated only; derivation helper is private', () => {
    expect(M80).toContain('revoke all on function public.get_payment_order_status(uuid) from public, anon');
    expect(M80).toContain('grant execute on function public.get_payment_order_status(uuid) to authenticated');
    expect(M80).toMatch(/revoke all on function app_private\.payment_order_customer_status[\s\S]{0,120}from public, anon, authenticated/);
  });
  it('derives every Stage 3D-C customer state from durable facts', () => {
    for (const s of ['reconciliation_required', 'completed', 'cancelled', 'failed',
      'confirmation_delayed', 'payment_received_confirming',
      'awaiting_bank_authentication', 'processing', 'awaiting_payment_method']) {
      expect(M80).toContain(`'${s}'`);
    }
  });
});

describe('0080 shared idempotent reconciliation path', () => {
  const rec = M80.slice(M80.indexOf('create or replace function app_private.reconcile_payment_order'),
    M80.indexOf('create or replace function public.support_list_pending_paid_orders'));
  it('locks the order and wraps — never replaces — the existing finaliser', () => {
    expect(rec).toContain('for update');
    expect(rec).toContain("perform app_private.finalise_paid_order(p_order, 'succeeded', p_intent)");
    // finalise_paid_order itself is untouched by 0080.
    expect(M80).not.toContain('create or replace function app_private.finalise_paid_order');
  });
  it('verifies expected intent, metadata linkage, amount and currency before finalising', () => {
    expect(rec).toContain("'intent_mismatch'");
    expect(rec).toContain("'metadata_mismatch'");
    expect(rec).toContain("'amount_mismatch'");
    expect(rec).toContain("'currency_mismatch'");
    expect(rec).toContain('p_amount_minor <> v.card_amount_minor');
    expect(rec).toContain("upper(p_currency) <> 'GBP'");
  });
  it('contains failure without guessing: finalise_error and finalise_incomplete → reconciliation_required', () => {
    expect(rec).toContain('exception when others then');
    expect(rec).toContain("'finalise_error'");
    expect(rec).toContain("'finalise_incomplete'");
  });
  it('recognises already-finalised orders idempotently for success AND failure repeats', () => {
    expect(rec).toContain("'already_finalised', true");
    expect(rec).toMatch(/v_already or v\.status in \('failed', 'expired'\)/);
  });
  it('is exposed to service_role only — the browser can never assert provider success', () => {
    expect(M80).toMatch(/revoke all on function public\.reconcile_payment_order[\s\S]{0,140}from public, anon, authenticated/);
    expect(M80).toMatch(/grant execute on function public\.reconcile_payment_order[\s\S]{0,140}to service_role/);
  });
});

describe('0080 support visibility', () => {
  it('is support-admin gated, read-only, capped and code-safe', () => {
    const sup = M80.slice(M80.indexOf('support_list_pending_paid_orders'));
    expect(sup).toContain('app_private.is_support_admin()');
    expect(sup).toMatch(/language plpgsql stable/);
    expect(sup).not.toMatch(/\bupdate\b|\binsert\b|\bdelete\b/i);
    expect(sup).toContain('limit 200');
    // Safe money fields only — never secrets, PANs or payment-method ids.
    expect(sup).not.toMatch(/client_secret|card_number|payment_method_id/i);
  });
});

describe('stripe-payments 3D-B1 contract', () => {
  it('return-URL policy fails closed — no hosted localhost fallback', () => {
    expect(FN).toContain("app_origins_unconfigured");
    expect(FN).not.toContain("?? 'http://localhost:5173'");
    expect(FN).toContain('allowed.includes(requested) ? requested : allowed[0]');
  });
  it('uses the Stage 3D-C payment-return route contract with safe ids only', () => {
    expect(FN).toContain('/#/payment/return?order=${orderId}&outcome=success');
    expect(FN).toContain('/#/payment/return?order=${orderId}&outcome=cancelled');
    expect(FN).not.toMatch(/payment=success|payment=cancelled/);
  });
  it('BOTH requires-action shapes return a hosted continuation URL', () => {
    // Returned intent shape…
    expect(FN).toContain("intent.status === 'requires_action' || intent.status === 'requires_confirmation'");
    // …and thrown authentication_required both flow through ONE session builder.
    expect(FN).toContain("stripeErr.code === 'authentication_required'");
    const first = FN.indexOf('createAuthenticationSession()');
    const second = FN.indexOf('createAuthenticationSession()', first + 1);
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    // The superseded direct intent is cancelled — one live provider object.
    expect(FN).toContain('stripe.paymentIntents.cancel(intent.id)');
  });
  it('check_payment_order: local id in, stored intent only, reconcile + owner projection out', () => {
    const chk = FN.slice(FN.indexOf("if (action === 'check_payment_order')"), FN.indexOf('// ---------- 2G3'));
    expect(chk.length).toBeGreaterThan(100);
    expect(chk).toContain("typeof body.orderId === 'string'");
    expect(chk).toContain('coordinator_account_id !== user.id');
    expect(chk).toContain('stripe_payment_intent_id');
    expect(chk).toContain('paymentIntents.retrieve');
    expect(chk).toContain("rpc('reconcile_payment_order'");
    expect(chk).toContain("rpc('get_payment_order_status'");
    // NEVER creates provider objects, never accepts a client intent id.
    expect(chk).not.toContain('paymentIntents.create');
    expect(chk).not.toContain('checkout.sessions.create');
    expect(chk).not.toMatch(/body\.(paymentIntentId|intentId|intent_id)/);
  });
  it('projection routes only through the service reconcile RPC — no direct success writes', () => {
    expect(FN).not.toMatch(/finalize_paid_order'[\s\S]{0,80}p_outcome: 'succeeded'/);
    expect(FN).not.toContain("status: 'succeeded'");
  });
});

describe('stripe-webhook 3D-B1 projection', () => {
  it('security spine unchanged: raw body, signature-first, ledger before effects', () => {
    expect(WH).toContain('await req.text()');
    expect(WH).toContain('constructEventAsync(rawBody, signature, secret)');
    const persistIdx = WH.indexOf("from('stripe_webhook_events').upsert");
    const effectIdx = WH.indexOf('switch (event.type)');
    expect(persistIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeLessThan(effectIdx);
    expect(WH).toContain('duplicate: true');
  });
  it('projects processing / succeeded / failed / canceled through the shared reconcile path', () => {
    expect(WH).toContain("case 'payment_intent.processing'");
    for (const evt of ['payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'checkout.session.completed']) {
      expect(WH).toContain(`'${evt}'`);
    }
    const recCalls = WH.match(/rpc\('reconcile_payment_order'/g) ?? [];
    expect(recCalls.length).toBeGreaterThanOrEqual(4);
    // Provider facts, not client claims: received amount + currency + metadata linkage.
    expect(WH).toContain('pi.amount_received ?? pi.amount');
    expect(WH).toContain('p_metadata_order: orderId');
    // Session success only counts when Stripe says PAID.
    expect(WH).toContain("session.payment_status === 'paid'");
  });
  it('no direct finalize call remains in payment handlers (single shared path)', () => {
    expect(WH).not.toContain("rpc('finalize_paid_order'");
  });
});

describe('stripe-billing 3D-B1 alignment', () => {
  it('complete_period fails closed on origins and uses the shared return route', () => {
    expect(BILL).toContain('app_origins_unconfigured');
    expect(BILL).not.toContain("?? 'http://localhost:5173'");
    expect(BILL).toContain('/#/payment/return?order=${order.id}&outcome=success');
    expect(BILL).not.toMatch(/billing=success|billing=cancelled/);
    expect(BILL).toContain("rpc('reconcile_payment_order'");
  });
});
