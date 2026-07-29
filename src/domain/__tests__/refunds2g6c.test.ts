/**
 * 2G6C contracts — refunds, credit restoration & post-transfer adjustments
 * (0052/0053 + stripe-refunds + webhook). Proves the refund/adjustment ledgers,
 * credit-first allocation, occurrence cap, service-role-only + support-gated
 * RPCs, deterministic idempotency, fixture-scopeable claim, pinned edge imports,
 * server-only amounts, and idempotent refund webhooks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const M52 = readFileSync(join(ROOT, 'supabase', 'migrations', '0052_payment_refunds.sql'), 'utf-8');
const M53R = readFileSync(join(ROOT, 'supabase', 'migrations', '0053_refund_reason_audit.sql'), 'utf-8');
const M53 = readFileSync(join(ROOT, 'supabase', 'migrations', '0054_payment_refund_schedule.sql'), 'utf-8');
const M55 = readFileSync(join(ROOT, 'supabase', 'migrations', '0055_refund_adjustment_on_success.sql'), 'utf-8');
function m55fn(name: string): string {
  const s = M55.indexOf(`create or replace function ${name}`);
  return M55.slice(s, M55.indexOf('\n$$;', s));
}
const EDGE = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-refunds', 'index.ts'), 'utf-8');
const HOOK = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-webhook', 'index.ts'), 'utf-8');

function fn(name: string): string {
  const s = M52.indexOf(`create or replace function ${name}`);
  return M52.slice(s, M52.indexOf('\n$$;', s));
}

describe('0052 refund + adjustment ledgers', () => {
  it('payment_refunds: strict state machine, remedy invariant, unique idempotency + stripe refund id', () => {
    expect(M52).toContain('create table if not exists public.payment_refunds');
    expect(M52).toContain("state text not null default 'requested' check (state in\n    ('requested', 'processing', 'succeeded', 'failed_retryable', 'failed_permanent', 'cancelled'))");
    expect(M52).toContain('check (remedy_minor = credit_restore_minor + card_refund_minor)');
    expect(M52).toContain('idempotency_key text not null unique');
    expect(M52).toContain('stripe_refund_id text unique');
    expect(M52).toContain('alter table public.payment_refunds enable row level security');
    expect(M52).not.toMatch(/create policy[^\n]*payment_refunds/);
  });
  it('settlement_adjustments records post-transfer exposure separately from transfers', () => {
    expect(M52).toContain('create table if not exists public.settlement_adjustments');
    expect(M52).toContain("adjustment_type text not null default 'customer_refund_after_transfer'");
    expect(M52).toContain("recovery_strategy text not null default 'platform_absorbed'");
    expect(M52).toContain('unique (refund_id, companion_earning_id)');
    expect(M52).toContain('alter table public.settlement_adjustments enable row level security');
    // The historical transfer table is never mutated by the adjustment path.
    expect(fn('public.request_payment_refund')).not.toContain('update public.companion_transfer_attempts');
  });
  it('adds a distinct payment_restoration credit source', () => {
    expect(M52).toContain("'payment_restoration'");
  });
});

describe('0052 request_payment_refund (support-only, server-derived)', () => {
  const f = fn('public.request_payment_refund');
  it('is support-gated and idempotent by key', () => {
    expect(f).toContain('if not app_private.is_support_admin()');
    expect(f).toContain('where idempotency_key = p_idempotency');
    expect(M52).toContain('revoke all on function public.request_payment_refund(text, uuid, integer, text, text) from public, anon');
  });
  it('allocates credit-first, derives amounts, caps by occurrence payer_charge, restores credit idempotently', () => {
    expect(f).toContain('v_credit := least(p_remedy_minor, v_credit_restorable)');
    expect(f).toContain('v_card := p_remedy_minor - v_credit');
    expect(f).toContain('coalesce(v_earning.payer_charge_minor, v_order.total_minor)'); // occurrence cap
    expect(f).toContain("'payment_restoration', v_refund.id");
    expect(f).toContain("'refund-credit-' || v_refund.id::text"); // deterministic ledger key
    expect(f).toContain('app_private.order_refundable_balance(v_order.id)');
    // Never both credit AND card for the same value.
    expect(f).toContain("case when v_card = 0 then 'succeeded' else 'requested' end");
  });
  it('records a post-transfer settlement adjustment, never reversing the transfer', () => {
    expect(f).toContain('insert into public.settlement_adjustments');
    expect(f).toContain("ta.state = 'succeeded'"); // transferred check
  });
});

describe('0052 worker + finalisers', () => {
  it('claim is service-role-only, fixture-scopeable, SKIP LOCKED with a stable key', () => {
    const f = fn('public.claim_payment_refunds');
    expect(f).toContain('for update of rf skip locked');
    expect(f).toContain('p_ids is null or rf.id = any(p_ids)'); // hosted-test scoping
    expect(f).toContain("stripe_idempotency_key := 'refund-' || r.id::text");
    expect(M52).toContain('revoke all on function public.claim_payment_refunds(integer, uuid[]) from public, anon, authenticated');
    expect(M52).toContain('grant execute on function public.claim_payment_refunds(integer, uuid[]) to service_role');
  });
  it('success stores the refund id once, is idempotent, never un-succeeds on failure', () => {
    const s = fn('public.finalize_refund_succeeded');
    expect(s).toContain("if v_rf.id is null or v_rf.state = 'succeeded' then return");
    expect(s).toContain('stripe_refund_id = coalesce(stripe_refund_id, p_stripe_refund_id)');
    for (const g of ['finalize_refund_failed_retryable', 'finalize_refund_failed_permanent']) {
      expect(fn(`public.${g}`)).toContain("if v_rf.id is null or v_rf.state = 'succeeded' then return");
    }
  });
  it('every worker RPC is service-role only; support overview is support-gated', () => {
    for (const n of ['recover_stale_refunds(integer)', 'finalize_refund_succeeded(uuid, text, text)',
                     'finalize_refund_failed_retryable(uuid, text, text)', 'finalize_refund_failed_permanent(uuid, text, text)',
                     'finalize_refund_cancelled(uuid, text)', 'refund_id_for_stripe(text)']) {
      expect(M52).toContain(`revoke all on function public.${n} from public, anon, authenticated`);
      expect(M52).toContain(`grant execute on function public.${n} to service_role`);
    }
    expect(fn('public.support_refund_overview')).toContain('if not app_private.is_support_admin()');
  });
});

describe('stripe-refunds Edge Function', () => {
  it('uses pinned npm: imports and the internal secret gate', () => {
    expect(EDGE).toContain("import Stripe from 'npm:stripe@17'");
    expect(EDGE).toContain("import { createClient } from 'npm:@supabase/supabase-js@2'");
    expect(EDGE).not.toContain('esm.sh');
    expect(EDGE).toContain("Deno.env.get('BILLING_CRON_SECRET')");
    expect(EDGE).toContain("return json({ error: 'unauthorised' }, 401)");
  });
  it('refunds against the PaymentIntent with server-only amount + stable key; no client allocation', () => {
    expect(EDGE).toContain('payment_intent: it.payment_intent_id');
    expect(EDGE).toContain('amount: it.amount_minor');
    expect(EDGE).toContain('idempotencyKey: it.stripe_idempotency_key');
    expect(EDGE).not.toMatch(/amount:\s*body\./);
    expect(EDGE).toContain("rpc('recover_stale_refunds'");
    expect(EDGE).toContain("rpc('claim_payment_refunds'");
    expect(EDGE).toContain('for (const it of items)'); // per-item isolation
  });
});

describe('stripe-webhook refund events are idempotent + metadata-resolved', () => {
  it('handles refund.created/updated via metadata or refund id, reusing event-id idempotency', () => {
    expect(HOOK).toContain("case 'refund.created':");
    expect(HOOK).toContain("case 'refund.updated':");
    expect(HOOK).toContain('rf.metadata?.payment_refund_id');
    expect(HOOK).toContain("rpc('refund_id_for_stripe'");
    expect(HOOK).toContain("rpc('finalize_refund_succeeded'");
    // Money authority is internal, not the webhook amount.
    expect(HOOK).not.toMatch(/finalize_refund_succeeded[^)]*amount/);
  });
});

describe('0055 settlement adjustment on success + missing-PaymentIntent guard', () => {
  it('records the adjustment ONLY on actual success (helper), never eagerly in the request card path', () => {
    const req = m55fn('public.request_payment_refund');
    // The request no longer inserts settlement_adjustments directly.
    expect(req).not.toContain('insert into public.settlement_adjustments');
    // Only the terminally-succeeded (zero-card) branch records it, via the helper.
    expect(req).toMatch(/if v_card = 0 then[\s\S]*maybe_record_settlement_adjustment\(v_refund\.id\)/);
    // Card success records it in the finalise path.
    expect(m55fn('public.finalize_refund_succeeded')).toContain('perform app_private.maybe_record_settlement_adjustment(p_refund)');
  });
  it('the helper is private, transferred-only and idempotent (one per refund+earning)', () => {
    const h = m55fn('app_private.maybe_record_settlement_adjustment');
    expect(h).toContain("ta.state = 'succeeded'");
    expect(h).toContain("v_e.transfer_state = 'transferred'");
    expect(h).toContain('on conflict (refund_id, companion_earning_id) do nothing');
    expect(M55).toContain('revoke all on function app_private.maybe_record_settlement_adjustment(uuid) from public, anon, authenticated');
  });
  it('a card portion with no PaymentIntent is a clear missing_payment_identifier failure', () => {
    const req = m55fn('public.request_payment_refund');
    expect(req).toContain('if v_card > 0 and v_order.stripe_payment_intent_id is null then');
    expect(req).toContain("raise exception 'missing_payment_identifier");
    // order_refundable_balance is unchanged — it reports DB card allocation, not
    // provider refundability, so it is never silently reduced for a missing PI.
    const orb = M52.slice(M52.indexOf('create or replace function app_private.order_refundable_balance'), M52.indexOf('revoke all on function app_private.order_refundable_balance'));
    expect(orb).not.toContain('stripe_payment_intent_id');
  });
});

describe('0053 refund reason audit', () => {
  const rf = (() => {
    const s = M53R.indexOf('create or replace function public.request_payment_refund');
    return M53R.slice(s, M53R.indexOf('\n$$;', s));
  })();
  it('adds a required, length-bounded reason column (backfilled, not null)', () => {
    expect(M53R).toContain('add column if not exists reason text');
    expect(M53R).toContain('alter column reason set not null');
    expect(M53R).toContain('check (char_length(reason) between 1 and 500)');
    expect(M53R).toContain("update public.payment_refunds set reason = 'Migrated: reason not recorded' where reason is null");
  });
  it('request_payment_refund trims, requires, bounds and persists the reason', () => {
    expect(rf).toContain("v_reason := left(trim(coalesce(p_reason, '')), 500)");
    expect(rf).toContain("raise exception 'reason_required");
    expect(rf).toContain('idempotency_key,\n     state, requested_by, reason)'); // stored column
    expect(rf).toContain("case when v_card = 0 then 'succeeded' else 'requested' end, auth.uid(), v_reason)");
  });
  it('never sends the reason to Stripe metadata or customer notifications', () => {
    // The card-refund worker never sees the reason (claim payload omits it).
    expect(EDGE).not.toMatch(/\breason\b/);
    // The notify_account calls in request_payment_refund carry fixed copy only.
    const notifies = rf.match(/notify_account\([\s\S]*?\);/g) ?? [];
    for (const n of notifies) {
      expect(n).not.toContain('v_reason');
      expect(n).not.toContain('p_reason');
    }
  });
  it('exposes the reason only through the support-only overview', () => {
    expect(M53R).toContain("'reason', reason"); // in support_refund_overview recent list
    expect(M53R).toContain('if not app_private.is_support_admin() then raise exception');
    expect(M53R).toContain('revoke all on function public.support_refund_overview() from public, anon');
    // payment_refunds stays RLS-locked with no client policy (0052) — reason is never client-readable.
    expect(M52).not.toMatch(/create policy[^\n]*payment_refunds/);
  });
});

describe('0054 refund cron (held until manual validation)', () => {
  it('reads URL + secret only from Vault, is private, idempotent at 06:30', () => {
    expect(M53).toContain("from vault.decrypted_secrets where name = 'billing_project_url'");
    expect(M53).toContain("v_url || '/functions/v1/stripe-refunds'");
    expect(M53).toContain("cron.schedule('settle-payment-refunds', '30 6 * * *'");
    expect(M53).toContain('cron.unschedule(jobid)');
    expect(M53).toContain('revoke all on function app_private.invoke_payment_refunds() from public, anon, authenticated');
    expect(M53).not.toMatch(/sk_(test|live)_|whsec_/);
  });
});
