/**
 * 2G6E-A contracts — dispute support operations & manual evidence workflow (0061).
 * Structural proofs that the support surfaces are additive, support-gated,
 * append-only where required, idempotent, privacy-preserving, audited, and that
 * the read-only evidence packet never leaks message bodies, private review text,
 * support notes, or earnings/commission/transfer amounts. No Stripe API call and
 * no automatic evidence submission. Also checks the frontend repository wires to
 * the intended RPCs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const M = readFileSync(join(ROOT, 'supabase', 'migrations', '0061_dispute_support_operations.sql'), 'utf-8');
const REPO = readFileSync(join(ROOT, 'src', 'repositories', 'disputeSupportRepository.ts'), 'utf-8');
function fn(name: string): string {
  const s = M.indexOf(`create or replace function ${name}`);
  if (s < 0) throw new Error(`function not found: ${name}`);
  return M.slice(s, M.indexOf('\n$$;', s));
}
// Every support-facing RPC declared in 0061 and its signature.
const RPCS: Array<[string, string]> = [
  ['public.support_claim_dispute', '(uuid)'],
  ['public.support_release_dispute', '(uuid)'],
  ['public.support_set_case_status', '(uuid, text)'],
  ['public.support_dispute_detail', '(uuid)'],
  ['public.support_add_dispute_note', '(uuid, text)'],
  ['public.support_record_manual_evidence', '(uuid, text, text[], integer, text, text, text, text)'],
  ['public.support_dispute_evidence_packet', '(uuid)'],
  ['public.support_acknowledge_adjustment', '(uuid)'],
  ['public.support_resolve_adjustment', '(uuid, text)'],
  ['public.support_unresolved_disputes', '()'],
  ['public.support_reconcile_dispute', '(text, text, text)'],
  ['public.support_dispute_queue', '()'],
];

describe('0061 is additive and does not touch existing 2G6D financial behaviour', () => {
  it('adds only new tables/columns/functions; never drops or rewrites dispute money paths', () => {
    expect(M).not.toMatch(/drop\s+(table|column|constraint|function\s+public\.record_dispute|function\s+public\.reconcile_unresolved|function\s+app_private\.map_and_hold)/i);
    expect(M).not.toMatch(/\btruncate\b/i);
    expect(M).not.toMatch(/update\s+public\.companion_earnings\s+set\s+(net_minor|commission_minor|basis_minor)/i);
    expect(M).not.toContain('delete from public.settlement_adjustments');
    expect(M).not.toContain('delete from public.payment_dispute_earnings');
    expect(M).toContain("select pg_notify('pgrst', 'reload schema')");
  });
  it('introduces a one-to-one support case model with an explicit status vocabulary', () => {
    expect(M).toContain('create table if not exists public.dispute_support_cases');
    expect(M).toContain('dispute_id uuid not null unique references public.payment_disputes(id)');
    expect(M).toContain("check (handling_status in\n      ('unassigned', 'in_review', 'evidence_prepared', 'evidence_submitted', 'waiting_provider', 'resolved'))");
    expect(M).toContain('assigned_account_id uuid references public.accounts(id)');
    expect(M).toContain('claimed_at timestamptz');
    expect(M).toContain('last_handled_at timestamptz');
    expect(M).toContain('resolved_at timestamptz');
  });
});

describe('0061 append-only tables with RLS and no client policies', () => {
  it('cases, notes, manual evidence and audit have RLS enabled and no client policies', () => {
    for (const t of ['dispute_support_cases', 'dispute_notes', 'dispute_manual_evidence', 'dispute_support_audit']) {
      expect(M).toContain(`alter table public.${t} enable row level security`);
      expect(M).not.toMatch(new RegExp(`create policy[^\\n]*${t}`));
    }
    // No update/delete path exists for the append-only note/evidence/audit tables.
    for (const t of ['dispute_notes', 'dispute_manual_evidence', 'dispute_support_audit']) {
      expect(M).not.toMatch(new RegExp(`update\\s+public\\.${t}`, 'i'));
      expect(M).not.toMatch(new RegExp(`delete\\s+from\\s+public\\.${t}`, 'i'));
    }
  });
  it('manual evidence dedupes on a PER-DISPUTE idempotency key (no cross-dispute collision)', () => {
    // Scoped uniqueness: the same key under two disputes must not collide.
    expect(M).toContain('idempotency_key text not null,');
    expect(M).toContain('unique (dispute_id, idempotency_key)');
    expect(M).not.toContain('idempotency_key text not null unique'); // not global
    const rec = fn('public.support_record_manual_evidence');
    expect(rec).toContain('on conflict (dispute_id, idempotency_key) do nothing');
    expect(rec).toContain('where dispute_id = p_dispute and idempotency_key = p_idempotency');
  });
  it('the audit table constrains action types and records a server-derived actor', () => {
    expect(M).toContain('check (action_type in');
    expect(M).toContain("'case_claimed'");
    expect(M).toContain("'reconcile_attempted'");
    expect(fn('app_private.write_dispute_audit')).toContain('auth.uid()');
  });
});

describe('0061 security posture', () => {
  it('every support RPC is SECURITY DEFINER, search_path empty, support-gated, revoked from public/anon, granted authenticated', () => {
    for (const [name, sig] of RPCS) {
      const body = fn(name);
      expect(body).toContain("language plpgsql security definer set search_path = ''");
      expect(body).toContain('app_private.is_support_admin()');
      expect(M).toContain(`revoke all on function ${name}${sig} from public, anon`);
      expect(M).toContain(`grant execute on function ${name}${sig} to authenticated`);
    }
  });
  it('private helpers are revoked from every client role (definer-only)', () => {
    expect(M).toContain('revoke all on function app_private.get_or_create_dispute_case(uuid) from public, anon, authenticated');
    expect(M).toContain('revoke all on function app_private.write_dispute_audit(uuid, uuid, text, jsonb) from public, anon, authenticated');
    expect(M).toContain('revoke all on function public.support_case_json(uuid) from public, anon, authenticated');
  });
});

describe('0061 handling model — claim/release/status are single-winner and audited', () => {
  it('claim is an atomic single-winner conditional update, idempotent for the owner', () => {
    const cl = fn('public.support_claim_dispute');
    expect(cl).toContain('where id = v_case and assigned_account_id is null'); // single winner
    expect(cl).toContain("raise exception 'already_claimed'");
    expect(cl).toContain("write_dispute_audit(p_dispute, v_case, 'case_claimed'");
  });
  it('release requires ownership and audits', () => {
    const rl = fn('public.support_release_dispute');
    expect(rl).toContain("raise exception 'not_owner'");
    expect(rl).toContain("write_dispute_audit(p_dispute, v_case, 'case_released'");
  });
  it('status change validates the vocabulary, enforces a transition model, and audits transitions', () => {
    const st = fn('public.support_set_case_status');
    expect(st).toContain("raise exception 'invalid_status'");
    expect(st).toContain("raise exception 'invalid_transition'"); // defined transition model enforced
    // 'unassigned' is release-only — never a manual set target.
    expect(st).toContain("if p_status not in ('in_review', 'evidence_prepared', 'evidence_submitted', 'waiting_provider', 'resolved')");
    // resolved may only reopen to in_review (no silent resolved -> active).
    expect(st).toContain("(v_from = 'resolved'           and p_status = 'in_review')");
    expect(st).toContain("write_dispute_audit(p_dispute, v_case, 'status_changed'");
  });
});

describe('0061 evidence packet includes allowed facts and excludes sensitive content', () => {
  const packet = fn('public.support_dispute_evidence_packet');
  it('clearly separates shareable vs internal-only, is versioned, and never auto-submits', () => {
    expect(packet).toContain("'packet_version', 1");
    expect(packet).toContain("'shareable', jsonb_build_object");
    expect(packet).toContain("'internal_only', jsonb_build_object");
    expect(packet).toContain('does not submit this to Stripe');
  });
  it('includes sessions, call segments, completion, review-metadata, payment/refund and message COUNTS', () => {
    expect(packet).toContain("'sessions'");
    expect(packet).toContain("'call_segments'");
    expect(packet).toContain("'completion_confirmations'");
    expect(packet).toContain("'review', (select jsonb_build_object('exists', true, 'rating', r.rating");
    expect(packet).toContain('user_message_count');
    expect(packet).toContain('communicated_before_first_session');
  });
  it('excludes message bodies, private review text, support notes and earnings/commission/transfer amounts', () => {
    expect(packet).not.toContain('m.body');
    expect(packet).not.toContain('private_feedback');
    expect(packet).not.toContain('dispute_notes');
    expect(packet).not.toContain('net_minor');
    expect(packet).not.toContain('commission_minor');
    expect(packet).not.toContain('transfer_attempt');
    expect(packet).not.toContain('adjustment_type');
    expect(packet).toContain('where e.payment_order_id = v_order'); // only THIS order's bookings
  });
});

describe('0061 settlement-adjustment ops acknowledge/resolve without deletion or amount change', () => {
  it('acknowledge is idempotent, audited, never deletes', () => {
    const ack = fn('public.support_acknowledge_adjustment');
    expect(ack).toContain("set state = 'acknowledged'");
    expect(ack).toContain('acknowledged_by = auth.uid()');
    expect(ack).toContain("if v_state = 'acknowledged' then return"); // idempotent
    expect(ack).not.toMatch(/amount_minor\s*=/); // never changes the amount
    expect(ack).toContain("write_dispute_audit(v_dispute, null, 'adjustment_acknowledged'");
  });
  it('resolve requires a reason, is idempotent same-state, audited, never rewrites', () => {
    const res = fn('public.support_resolve_adjustment');
    expect(res).toContain('reason_required');
    expect(res).toContain("if v_state = 'resolved' then return"); // idempotent, no rewrite
    expect(res).toContain('resolved_by = auth.uid()');
    expect(res).not.toMatch(/amount_minor\s*=/);
    expect(res).toContain("write_dispute_audit(v_dispute, null, 'adjustment_resolved'");
  });
});

describe('0061 unresolved reconciliation stays provider-identifier based', () => {
  it('lists unmapped disputes and reconciles only via provider identifiers (no client order id)', () => {
    expect(fn('public.support_unresolved_disputes')).toContain('where d.payment_order_id is null');
    const rc = fn('public.support_reconcile_dispute');
    expect(M).toContain('support_reconcile_dispute(\n  p_stripe_dispute_id text, p_payment_intent text, p_charge text\n)');
    expect(rc).not.toMatch(/p_order|p_booking|p_earning|p_amount|p_allocated/);
    expect(rc).toContain('public.reconcile_unresolved_dispute(p_stripe_dispute_id, p_payment_intent, p_charge)');
    expect(rc).toContain("write_dispute_audit(v_dispute, v_case, 'reconcile_attempted'");
  });
  it('does not weaken the service-role restriction on the low-level 0058 reconcile', () => {
    expect(M).not.toMatch(/grant execute on function public\.reconcile_unresolved_dispute/);
  });
});

describe('0061 frontend repository wires to the intended RPCs', () => {
  it('calls each support RPC by name and never calls Stripe', () => {
    for (const rpc of [
      'support_dispute_queue', 'support_dispute_overview', 'support_unresolved_disputes',
      'support_dispute_detail', 'support_dispute_evidence_packet', 'support_claim_dispute',
      'support_release_dispute', 'support_set_case_status', 'support_add_dispute_note',
      'support_record_manual_evidence', 'support_acknowledge_adjustment', 'support_resolve_adjustment',
      'support_reconcile_dispute',
    ]) {
      expect(REPO).toContain(`'${rpc}'`);
    }
    expect(REPO.toLowerCase()).not.toContain('api.stripe.com');
    expect(REPO).not.toMatch(/fetch\(|axios|new Stripe/);
  });
});
