/**
 * 2G6E-A contracts — dispute support operations & manual evidence workflow (0059).
 * Structural proofs that the support surfaces are additive, support-gated,
 * append-only where required, idempotent, privacy-preserving, and that the
 * read-only evidence packet never leaks message bodies, private review text,
 * support notes, or earnings/commission/transfer amounts. No evidence is ever
 * submitted to Stripe and no existing 2G6D financial behaviour is altered.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const M = readFileSync(join(ROOT, 'supabase', 'migrations', '0059_dispute_support_operations.sql'), 'utf-8');
function fn(name: string): string {
  const s = M.indexOf(`create or replace function ${name}`);
  if (s < 0) throw new Error(`function not found: ${name}`);
  return M.slice(s, M.indexOf('\n$$;', s));
}
// Every privileged RPC declared in 0059.
const RPCS: Array<[string, string]> = [
  ['public.support_dispute_detail', '(uuid)'],
  ['public.support_assign_dispute', '(uuid, uuid)'],
  ['public.support_set_dispute_workflow', '(uuid, text)'],
  ['public.support_add_dispute_note', '(uuid, text)'],
  ['public.support_record_manual_evidence', '(uuid, text, text[], text)'],
  ['public.support_dispute_evidence_packet', '(uuid)'],
  ['public.support_acknowledge_adjustment', '(uuid)'],
  ['public.support_resolve_adjustment', '(uuid, text)'],
  ['public.support_unresolved_disputes', '()'],
  ['public.support_reconcile_dispute', '(text, text, text)'],
];

describe('0059 is additive and does not touch existing 2G6D financial behaviour', () => {
  it('adds only new tables/columns/functions; never drops or rewrites dispute money paths', () => {
    expect(M).not.toMatch(/drop\s+(table|column|constraint|index|function\s+public\.record_dispute|function\s+public\.map_and_hold)/i);
    expect(M).not.toMatch(/\btruncate\b/i);
    // No monetary recompute of earnings/allocations here.
    expect(M).not.toMatch(/update\s+public\.companion_earnings\s+set\s+(net_minor|commission_minor|basis_minor)/i);
    expect(M).not.toContain('delete from public.settlement_adjustments');
    expect(M).not.toContain('delete from public.payment_dispute_earnings');
    expect(M).toContain("select pg_notify('pgrst', 'reload schema')");
  });
  it('introduces a support-workflow state SEPARATE from provider_status and internal_state', () => {
    expect(M).toContain('add column if not exists support_workflow_state text not null default \'unassigned\'');
    expect(M).toContain("check (support_workflow_state in\n        ('unassigned', 'handling', 'awaiting_evidence', 'evidence_submitted', 'completed'))");
    expect(M).toContain('add column if not exists support_owner_account_id uuid references public.accounts(id)');
    expect(M).toContain('add column if not exists support_workflow_updated_by uuid references public.accounts(id)');
  });
});

describe('0059 security posture', () => {
  it('every privileged function is SECURITY DEFINER, search_path empty, support-gated, revoked from public/anon', () => {
    for (const [name, sig] of RPCS) {
      const body = fn(name);
      expect(body).toContain("language plpgsql security definer set search_path = ''");
      expect(body).toContain('app_private.is_support_admin()'); // gated
      expect(M).toContain(`revoke all on function ${name}${sig} from public, anon`);
      expect(M).toContain(`grant execute on function ${name}${sig} to authenticated`);
    }
  });
  it('new tables enable RLS and expose NO client policies', () => {
    for (const t of ['dispute_notes', 'dispute_manual_evidence']) {
      expect(M).toContain(`alter table public.${t} enable row level security`);
      expect(M).not.toMatch(new RegExp(`create policy[^\\n]*${t}`));
    }
  });
});

describe('0059 notes are append-only + private', () => {
  it('notes live in a dedicated append-only table, not an overwritten text column', () => {
    expect(M).toContain('create table if not exists public.dispute_notes');
    expect(M).toContain('body text not null check (char_length(body) between 1 and 4000)');
    // The writer only INSERTs — no update/delete of notes anywhere.
    const add = fn('public.support_add_dispute_note');
    expect(add).toContain('insert into public.dispute_notes');
    expect(M).not.toMatch(/update\s+public\.dispute_notes/i);
    expect(M).not.toMatch(/delete\s+from\s+public\.dispute_notes/i);
  });
});

describe('0059 manual evidence is idempotent and never claims Stripe acceptance', () => {
  it('dedupes by idempotency key and makes no Stripe call / acceptance claim', () => {
    const rec = fn('public.support_record_manual_evidence');
    expect(M).toContain('idempotency_key text not null unique');
    expect(rec).toContain('on conflict (idempotency_key) do nothing');
    expect(rec).toContain('idempotency_required');
    expect(rec).toContain("'created', v_created"); // reports whether a new row was written
    expect(rec).toContain('acceptance is not implied');
    // Append-only: no update/delete of evidence rows.
    expect(M).not.toMatch(/update\s+public\.dispute_manual_evidence/i);
    expect(M).not.toMatch(/delete\s+from\s+public\.dispute_manual_evidence/i);
    // Never touches Stripe / makes no outbound call (pure SQL, no pg_net/http).
    expect(M.toLowerCase()).not.toContain('stripe.com');
    expect(M).not.toMatch(/submitEvidence|net\.http|extensions\.http|\bhttp_post\b/);
  });
});

describe('0059 ownership + handling are audited and internal-only', () => {
  it('assign + workflow record actor and timestamp', () => {
    for (const name of ['public.support_assign_dispute', 'public.support_set_dispute_workflow']) {
      const body = fn(name);
      expect(body).toContain('support_workflow_updated_at = now()');
      expect(body).toContain('support_workflow_updated_by = v_actor');
    }
    expect(fn('public.support_assign_dispute')).toContain('support_assigned_at = now()');
    expect(fn('public.support_set_dispute_workflow')).toContain('invalid_workflow_state');
  });
});

describe('0059 evidence packet includes allowed facts and excludes sensitive content', () => {
  const packet = fn('public.support_dispute_evidence_packet');
  it('clearly separates shareable vs internal-only and never auto-submits', () => {
    expect(packet).toContain("'shareable', jsonb_build_object");
    expect(packet).toContain("'internal_only', jsonb_build_object");
    expect(packet).toContain('does not submit this to Stripe');
  });
  it('includes service, session, attendance, review-rating, payment/refund and message COUNT facts', () => {
    expect(packet).toContain("'sessions'");
    expect(packet).toContain('attendance_outcome');
    expect(packet).toContain("'reviews'");
    expect(packet).toContain("'rating', r.rating"); // neutral rating fact
    expect(packet).toContain("'payments'");
    expect(packet).toContain("'refunds'");
    expect(packet).toContain('user_message_count');
    expect(packet).toContain('first_message_at');
  });
  it('excludes message bodies, private review text, support notes and earnings/commission/transfer amounts', () => {
    expect(packet).not.toContain('m.body');
    expect(packet).not.toContain('private_feedback');
    expect(packet).not.toContain('dispute_notes');
    expect(packet).not.toContain('net_minor');
    expect(packet).not.toContain('commission_minor');
    expect(packet).not.toContain('transfer_attempt');
    expect(packet).not.toContain('adjustment_type'); // no platform-loss classification
    // Only THIS order's bookings (scoped by companion_earnings on the mapped order).
    expect(packet).toContain('where e.payment_order_id = v_order');
  });
});

describe('0059 settlement-adjustment actions acknowledge/resolve without deletion', () => {
  it('acknowledge sets state + actor + timestamp, never deletes', () => {
    const ack = fn('public.support_acknowledge_adjustment');
    expect(ack).toContain("set state = 'acknowledged'");
    expect(ack).toContain('acknowledged_by = auth.uid()');
    expect(ack).toContain('acknowledged_at = now()');
    expect(ack).toContain("if v_state = 'resolved' then raise exception 'already_resolved'");
  });
  it('resolve REQUIRES an internal reason and records actor + timestamp', () => {
    const res = fn('public.support_resolve_adjustment');
    expect(res).toContain('reason_required');
    expect(res).toContain("set state = 'resolved'");
    expect(res).toContain('resolved_by = auth.uid()');
    expect(res).toContain('resolution_reason = left(trim(p_reason)');
  });
});

describe('0059 unresolved reconciliation stays provider-identifier based', () => {
  it('lists unmapped disputes and reconciles only via provider identifiers (no client order id)', () => {
    expect(fn('public.support_unresolved_disputes')).toContain('where d.payment_order_id is null');
    const rc = fn('public.support_reconcile_dispute');
    // Signature is exactly the three Stripe identifiers; no order id / amount.
    expect(M).toContain('support_reconcile_dispute(\n  p_stripe_dispute_id text, p_payment_intent text, p_charge text\n)');
    expect(rc).not.toMatch(/p_order|p_amount|p_allocated/);
    // Delegates to the trusted 2G6D reconcile RPC.
    expect(rc).toContain('return public.reconcile_unresolved_dispute(p_stripe_dispute_id, p_payment_intent, p_charge)');
  });
});
