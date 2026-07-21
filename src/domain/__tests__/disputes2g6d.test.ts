/**
 * 2G6D contracts — Stripe disputes & chargebacks (0056 + stripe-webhook).
 * Proves the dispute/allocation ledgers, future-tolerant raw status, separated
 * dispute-status vs fund-movement, service-role-only RPCs, support-gated
 * overview, refund/transfer holds, adjustment-only-on-withdrawal-after-transfer,
 * retriable webhook events, and no evidence submission.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const M = readFileSync(join(ROOT, 'supabase', 'migrations', '0056_payment_disputes.sql'), 'utf-8');
const HOOK = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-webhook', 'index.ts'), 'utf-8');
function fn(name: string): string {
  const s = M.indexOf(`create or replace function ${name}`);
  return M.slice(s, M.indexOf('\n$$;', s));
}

describe('0056 dispute + allocation ledgers', () => {
  it('payment_disputes: unique Stripe id, FUTURE-TOLERANT raw status, checked internal state, RLS-private', () => {
    expect(M).toContain('create table if not exists public.payment_disputes');
    expect(M).toContain('stripe_dispute_id text not null unique');
    expect(M).toContain('provider_status text,                       -- RAW Stripe status; intentionally uncheck-constrained');
    expect(M).toContain("internal_state text not null default 'unresolved'\n    check (internal_state in ('unresolved', 'open', 'under_review', 'won', 'lost', 'closed_warning'))");
    expect(M).toContain('funds_withdrawn boolean not null default false');
    expect(M).toContain('funds_reinstated boolean not null default false');
    expect(M).toContain('alter table public.payment_disputes enable row level security');
    expect(M).not.toMatch(/create policy[^\n]*payment_disputes/);
  });
  it('payment_dispute_earnings allocates per earning with a hold + one adjustment link', () => {
    expect(M).toContain('create table if not exists public.payment_dispute_earnings');
    expect(M).toContain('allocated_minor integer not null check (allocated_minor >= 0)');
    expect(M).toContain("hold_state text not null default 'held' check (hold_state in ('held', 'released'))");
    expect(M).toContain('exposure_adjustment_id uuid references public.settlement_adjustments(id)');
    expect(M).toContain('unique (dispute_id, earning_id)');
    expect(M).not.toMatch(/create policy[^\n]*payment_dispute_earnings/);
  });
  it('settlement_adjustments is extended additively (refund_id nullable, dispute_id, type)', () => {
    expect(M).toContain('alter table public.settlement_adjustments alter column refund_id drop not null');
    expect(M).toContain('add column if not exists dispute_id uuid references public.payment_disputes(id)');
    expect(M).toContain("check (adjustment_type in ('customer_refund_after_transfer', 'dispute_after_transfer'))");
    // Exactly one source: neither both-null nor both-populated.
    expect(M).toContain('check (num_nonnulls(refund_id, dispute_id) = 1)');
    expect(M).toContain('settlement_adjustments_one_per_dispute_earning');
  });
});

describe('0056 dispute reconciliation is separated + service-role only', () => {
  it('dispute creation records + holds but creates NO settlement adjustment', () => {
    const up = fn('public.record_dispute_upsert');
    expect(up).toContain('perform app_private.map_and_hold_dispute'); // holds
    expect(up).not.toContain('insert into public.settlement_adjustments'); // never an adjustment on creation
    expect(fn('app_private.map_and_hold_dispute')).not.toContain('insert into public.settlement_adjustments');
  });
  it('a platform-loss adjustment is created ONLY on funds withdrawn AND only after transfer', () => {
    const fw = fn('public.record_dispute_funds_withdrawn');
    expect(fw).toContain("e.transfer_state = 'transferred'");
    expect(fw).toContain("ta.state = 'succeeded'");
    expect(fw).toContain("adjustment_type"); // inserts dispute_after_transfer
    expect(fw).toContain('if not v_transferred then continue; end if;'); // no adjustment before transfer
    expect(fw).toContain('on conflict (dispute_id, companion_earning_id) do nothing'); // exactly once
  });
  it('reinstatement RESOLVES (never deletes) the adjustment and releases holds', () => {
    const fr = fn('public.record_dispute_funds_reinstated');
    expect(fr).toContain("set state = 'resolved'");
    expect(fr).not.toContain('delete from public.settlement_adjustments');
    expect(fr).toContain("set hold_state = 'released'");
  });
  it('a close never moves a terminal outcome backwards; won/warning release holds, lost keeps them', () => {
    const cl = fn('public.record_dispute_closed');
    expect(cl).toContain("if v_d.internal_state in ('won', 'lost', 'closed_warning') then return");
    expect(cl).toContain("if v_state in ('won', 'closed_warning') then");
    expect(cl).toContain("set hold_state = 'released'");
  });
  it('the order is restored out of disputed only when no OTHER dispute is active', () => {
    const rst = fn('app_private.restore_order_after_dispute');
    expect(rst).toContain('d.payment_order_id = p_order and d.id <> p_exclude_dispute'); // excludes only the cleared one
    expect(rst).toContain("d.internal_state in ('open', 'under_review')");
    expect(rst).toContain('(d.funds_withdrawn and not d.funds_reinstated)'); // an unresolved withdrawal keeps it disputed
    expect(rst).toContain("o.status = 'disputed'"); // only touches a disputed order
    // Restore is invoked on a favourable close and on reinstatement.
    expect(fn('public.record_dispute_closed')).toContain('perform app_private.restore_order_after_dispute(v_d.payment_order_id, v_d.id)');
    expect(fn('public.record_dispute_funds_reinstated')).toContain('perform app_private.restore_order_after_dispute(v_d.payment_order_id, v_d.id)');
  });
  it('unmapped disputes are retained; reconcile maps later; unknown status stays recordable', () => {
    expect(fn('app_private.map_and_hold_dispute')).toContain('if v_order.id is null then return'); // stays unresolved
    expect(fn('public.reconcile_unresolved_dispute')).toContain('perform app_private.map_and_hold_dispute');
    expect(fn('app_private.dispute_internal_state')).toContain("else 'open'"); // unknown → recordable
  });
  it('every dispute RPC is service-role only; overview is support-gated', () => {
    for (const n of ['record_dispute_upsert(text, text, text, integer, text, text, text, timestamptz)',
                     'record_dispute_closed(text, text, text)', 'record_dispute_funds_withdrawn(text)',
                     'record_dispute_funds_reinstated(text)', 'reconcile_unresolved_dispute(text, text, text)']) {
      expect(M).toContain(`revoke all on function public.${n} from public, anon, authenticated`);
      expect(M).toContain(`grant execute on function public.${n} to service_role`);
    }
    expect(fn('public.support_dispute_overview')).toContain('if not app_private.is_support_admin()');
  });
  it('there is NO evidence submission anywhere', () => {
    expect(M.toLowerCase()).not.toContain('evidence_submit');
    expect(HOOK).not.toMatch(/disputes\.update|submitEvidence|evidence:/);
  });
});

describe('0056 refund + transfer holds', () => {
  it('a new card refund is blocked on an active disputed order; claiming excludes it', () => {
    expect(fn('public.request_payment_refund')).toContain("raise exception 'order_disputed");
    expect(fn('public.claim_payment_refunds')).toMatch(/payment_disputes d[\s\S]*d\.internal_state in \('open', 'under_review', 'lost'\)/);
  });
  it('the transfer claim excludes earnings under an active dispute hold', () => {
    expect(fn('public.claim_plan_transfers')).toMatch(/payment_dispute_earnings pde[\s\S]*pde\.hold_state = 'held'[\s\S]*d\.internal_state in \('unresolved', 'open', 'under_review', 'lost'\)/);
  });
});

describe('stripe-webhook dispute events + retriable model', () => {
  it('handles every dispute event and never submits evidence', () => {
    for (const ev of ['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed',
                      'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated']) {
      expect(HOOK).toContain(`case '${ev}':`);
    }
    expect(HOOK).toContain("rpc('record_dispute_upsert'");
    expect(HOOK).toContain("rpc('record_dispute_funds_withdrawn'");
    expect(HOOK).toContain('d.payment_intent'); // maps via PaymentIntent, charge fallback in SQL
  });
  it('an event is only marked processed AFTER side effects succeed; failures are retriable (500)', () => {
    expect(M).toContain("add column if not exists status text not null default 'received'");
    expect(HOOK).toContain("status: 'processed', processed_at: new Date().toISOString()");
    expect(HOOK).toContain("status: 'failed', processed_at: null");
    expect(HOOK).toContain('status: ok ? 200 : 500');
  });
  it('event claiming is atomic (single-winner) and recoverable (stale re-claim)', () => {
    const cw = fn('public.claim_webhook_event');
    expect(cw).toContain('where id = p_id for update');            // serialises concurrent deliveries
    expect(cw).toContain("if v.status = 'processed' then return false"); // idempotent skip
    expect(cw).toContain("v.status = 'processing'\n     and v.received_at > now() - make_interval"); // active vs stale
    expect(M).toContain('revoke all on function public.claim_webhook_event(text, integer) from public, anon, authenticated');
    expect(M).toContain('grant execute on function public.claim_webhook_event(text, integer) to service_role');
    // The webhook claims via the RPC and only processes when it wins.
    expect(HOOK).toContain("rpc('claim_webhook_event', { p_id: event.id, p_stale_minutes: 5 })");
    expect(HOOK).toContain('claim.data !== true');
  });
});
