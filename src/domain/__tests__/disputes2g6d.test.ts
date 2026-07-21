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
const M57 = readFileSync(join(ROOT, 'supabase', 'migrations', '0057_payment_disputes_hosted_fixes.sql'), 'utf-8');
const M58 = readFileSync(join(ROOT, 'supabase', 'migrations', '0058_payment_dispute_reconciliation_fix.sql'), 'utf-8');
const HOOK = readFileSync(join(ROOT, 'supabase', 'functions', 'stripe-webhook', 'index.ts'), 'utf-8');
function fn(name: string): string {
  const s = M.indexOf(`create or replace function ${name}`);
  return M.slice(s, M.indexOf('\n$$;', s));
}
function fn57(name: string): string {
  const s = M57.indexOf(`create or replace function ${name}`);
  return M57.slice(s, M57.indexOf('\n$$;', s));
}
function fn58(name: string): string {
  const s = M58.indexOf(`create or replace function ${name}`);
  return M58.slice(s, M58.indexOf('\n$$;', s));
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

describe('0057 hosted corrective migration (additive, create-or-replace only)', () => {
  it('is redefine-only: no schema/index/table DDL, no historical-row mutation', () => {
    // Only function redefinitions + the PostgREST reload; the immutable index and
    // constraints from 0056 are left exactly as applied hosted.
    expect(M57).not.toMatch(/create\s+(unique\s+)?index/i);
    expect(M57).not.toMatch(/alter\s+table/i);
    expect(M57).not.toMatch(/drop\s+/i);
    expect(M57).not.toMatch(/create\s+table/i);
    expect(M57).not.toMatch(/\bdelete\s+from\b/i);
    expect(M57).not.toMatch(/\btruncate\b/i);
    expect(M57).toContain("select pg_notify('pgrst', 'reload schema')");
  });

  it('Failure 1 fix: funds_withdrawn ON CONFLICT now matches the PARTIAL index exactly', () => {
    const fw = fn57('public.record_dispute_funds_withdrawn');
    // The 0056 target lacked the index predicate → 42P10. 0057 adds it verbatim so
    // ON CONFLICT infers settlement_adjustments_one_per_dispute_earning.
    expect(fw).toContain('on conflict (dispute_id, companion_earning_id) where dispute_id is not null do nothing');
    // The partial index this matches is still the one from 0056 (unchanged here).
    expect(M).toContain('on public.settlement_adjustments (dispute_id, companion_earning_id) where dispute_id is not null');
    // Idempotency preserved: still one adjustment per (dispute, earning), still gated on transfer.
    expect(fw).toContain('if not v_transferred then continue; end if;');
    expect(fw).toContain("'dispute_after_transfer'");
    // No duplicate exposure: a no-op conflict re-reads the existing adjustment id.
    expect(fw).toContain('if v_adj is null then');
    expect(fw).toContain('where dispute_id = v_d.id and companion_earning_id = r.earning_id');
    // Still additive to the refund-XOR source model (never writes both ids).
    expect(fw).toContain('select null, v_d.id, r.earning_id');
  });

  it('Failure 3 fix: internal_state is advanced from provider_status ONLY once mapped', () => {
    const up = fn57('public.record_dispute_upsert');
    // Row is inserted 'unresolved'; state is NOT advanced pre-map.
    expect(up).toContain("'unresolved', p_evidence_due)");
    // Map first, then a single gated advance requiring a mapped order.
    const mapIdx = up.indexOf('perform app_private.map_and_hold_dispute');
    const advIdx = up.indexOf('internal_state = app_private.dispute_internal_state(provider_status)');
    expect(mapIdx).toBeGreaterThan(-1);
    expect(advIdx).toBeGreaterThan(mapIdx); // advance happens AFTER mapping
    expect(up).toContain('where id = v_id and payment_order_id is not null');
    expect(up).toContain("and internal_state not in ('won', 'lost', 'closed_warning')"); // never regress terminal
    // There is no unconditional pre-map state write left behind.
    expect(up.slice(0, mapIdx)).not.toContain('dispute_internal_state');
  });

  it('reconcile advances state after a successful late mapping; unmapped stays unresolved', () => {
    const rc = fn57('public.reconcile_unresolved_dispute');
    expect(rc).toContain('perform app_private.map_and_hold_dispute(v_d.id)');
    const mapIdx = rc.indexOf('perform app_private.map_and_hold_dispute');
    const advIdx = rc.indexOf('internal_state = app_private.dispute_internal_state(provider_status)');
    expect(advIdx).toBeGreaterThan(mapIdx);
    expect(rc).toContain('where id = v_d.id and payment_order_id is not null');
    expect(rc).toContain("and internal_state not in ('won', 'lost', 'closed_warning')");
    // Only ever acts on a still-unmapped dispute (idempotent no-op once mapped).
    expect(rc).toContain('or v_d.payment_order_id is not null then return');
  });

  it('every redefined RPC keeps service-role-only exposure', () => {
    expect(M57).toContain('revoke all on function public.record_dispute_funds_withdrawn(text) from public, anon, authenticated');
    expect(M57).toContain('grant execute on function public.record_dispute_funds_withdrawn(text) to service_role');
    expect(M57).toContain('revoke all on function public.record_dispute_upsert(text, text, text, integer, text, text, text, timestamptz) from public, anon, authenticated');
    expect(M57).toContain('grant execute on function public.record_dispute_upsert(text, text, text, integer, text, text, text, timestamptz) to service_role');
    expect(M57).toContain('revoke all on function public.reconcile_unresolved_dispute(text, text, text) from public, anon, authenticated');
    expect(M57).toContain('grant execute on function public.reconcile_unresolved_dispute(text, text, text) to service_role');
  });
});

describe('0058 reconciliation fix (additive; supersedes reconcile only)', () => {
  it('is additive: drops+recreates only the function, no table/index/row mutation', () => {
    // The only DROP permitted is the function itself (return type changes void->text).
    expect(M58).toContain('drop function if exists public.reconcile_unresolved_dispute(text, text, text)');
    expect(M58).not.toMatch(/drop\s+(table|index|constraint|column|type|trigger|policy)/i);
    expect(M58).not.toMatch(/alter\s+table/i);
    expect(M58).not.toMatch(/create\s+(unique\s+)?index/i);
    expect(M58).not.toMatch(/create\s+table/i);
    expect(M58).not.toMatch(/\bdelete\s+from\b/i);
    expect(M58).not.toMatch(/\btruncate\b/i);
    expect(M58).toContain("select pg_notify('pgrst', 'reload schema')");
  });

  it('root-cause fix: prefers the SUPPLIED identifiers over the stale stored ones', () => {
    const rc = fn58('public.reconcile_unresolved_dispute');
    // The corrected identifier supplied at reconcile time wins; stored value is the fallback.
    expect(rc).toContain('stripe_payment_intent_id = coalesce(p_payment_intent, stripe_payment_intent_id)');
    expect(rc).toContain('stripe_charge_id = coalesce(p_charge, stripe_charge_id)');
    // It must NOT keep the old value first (the 0057 bug).
    expect(rc).not.toContain('coalesce(stripe_payment_intent_id, p_payment_intent)');
  });

  it('locks, maps via the deterministic helper, then RE-SELECTS before deciding', () => {
    const rc = fn58('public.reconcile_unresolved_dispute');
    expect(rc).toContain('where stripe_dispute_id = p_stripe_dispute_id for update'); // row lock
    const mapIdx = rc.indexOf('perform app_private.map_and_hold_dispute(v_d.id)');
    const reselIdx = rc.indexOf('select payment_order_id into v_order from public.payment_disputes where id = v_d.id');
    expect(mapIdx).toBeGreaterThan(-1);
    expect(reselIdx).toBeGreaterThan(mapIdx); // re-read AFTER the helper writes, not the stale local row
    // internal_state advances only after a confirmed map, never regressing a terminal.
    const advIdx = rc.indexOf('internal_state = app_private.dispute_internal_state(provider_status)');
    expect(advIdx).toBeGreaterThan(reselIdx);
    expect(rc).toContain("and internal_state not in ('won', 'lost', 'closed_warning')");
  });

  it('returns a clear result and is idempotent on an already-mapped dispute', () => {
    const rc = fn58('public.reconcile_unresolved_dispute');
    expect(rc).toContain('returns text');
    expect(rc).toContain("if v_d.payment_order_id is not null then return 'already_mapped'");
    expect(rc).toContain("return 'still_unresolved'");
    expect(rc).toContain("return 'mapped'");
  });

  it('accepts only Stripe identifiers — never client order ids or amounts', () => {
    const rc = fn58('public.reconcile_unresolved_dispute');
    // Signature is exactly the three text identifiers; no order id / amount params.
    expect(M58).toContain('reconcile_unresolved_dispute(\n  p_stripe_dispute_id text, p_payment_intent text, p_charge text\n)');
    expect(rc).not.toMatch(/p_order|p_amount|p_allocated|p_remedy/);
    // Mapping/allocation is delegated to the trusted helper, which derives amounts itself.
    expect(rc).toContain('perform app_private.map_and_hold_dispute(v_d.id)');
  });

  it('stays service-role only', () => {
    expect(M58).toContain('revoke all on function public.reconcile_unresolved_dispute(text, text, text) from public, anon, authenticated');
    expect(M58).toContain('grant execute on function public.reconcile_unresolved_dispute(text, text, text) to service_role');
  });
});
