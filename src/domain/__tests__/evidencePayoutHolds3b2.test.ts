/**
 * Stage 3B2 — evidence-informed payout holds (0072) contract proofs.
 *
 * Static/source contracts (no DB). They prove 0072 is additive, deterministic,
 * defence-in-depth, support-gated and — above all — FINANCIALLY INERT beyond
 * blocking/releasing payout ELIGIBILITY: it never initiates/retries/reverses a
 * transfer, refunds/credits the customer, touches a dispute/reconciliation or
 * payment-order money, or calls Stripe. Behaviour lives in the hosted block.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const M = readFileSync(join(ROOT, 'supabase', 'migrations', '0072_evidence_informed_payout_holds.sql'), 'utf-8');
const NOTE = readFileSync(join(ROOT, 'src', 'components', 'CallEvidenceNote.tsx'), 'utf-8');

const stripSql = (s: string): string => s.replace(/--.*$/gm, '');
const stripTs = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const M_CODE = stripSql(M);
function fn(name: string): string {
  const s = M.indexOf(`create or replace function ${name}`);
  if (s < 0) throw new Error(`0072 fn not found: ${name}`);
  return M.slice(s, M.indexOf('\n$$;', s));
}

describe('0072 hold model — tables, RLS, one-open invariant, append-only audit', () => {
  it('adds the review + audit tables, forces RLS with no policies, and one OPEN review per booking', () => {
    expect(M).toContain('create table if not exists public.companion_evidence_payout_reviews');
    expect(M).toContain('create table if not exists public.companion_evidence_payout_review_events');
    for (const t of ['companion_evidence_payout_reviews', 'companion_evidence_payout_review_events']) {
      expect(M).toContain(`alter table public.${t} enable row level security`);
      expect(M).toContain(`alter table public.${t} force row level security`);
    }
    expect(M).not.toMatch(/create policy/i);                       // no policies ⇒ definer-only
    expect(M).toContain("on public.companion_evidence_payout_reviews (booking_id)\n  where state in ('active', 'claimed', 'post_transfer_review')");
    // Conflict-code + state vocabularies.
    for (const c of ['companion_not_observed', 'member_not_observed', 'member_observed_despite_no_show_declaration']) {
      expect(M).toContain(`'${c}'`);
    }
    for (const s of ['active', 'claimed', 'released', 'superseded', 'post_transfer_review']) {
      expect(M).toContain(`'${s}'`);
    }
    // Audit table is append-only: no update/delete of it anywhere.
    expect(M_CODE).not.toMatch(/update\s+public\.companion_evidence_payout_review_events|delete\s+from\s+public\.companion_evidence_payout_review_events/i);
  });
});

describe('0072 evaluator — named policy, blocking cases, non-blocking, locking', () => {
  const e = fn('app_private.evaluate_evidence_payout_hold');
  it('uses a NAMED overlap threshold and the exact eligibility gate', () => {
    expect(e).toContain('c_blocking_overlap_seconds constant integer := 60');
    expect(e).toContain("v_b.status in ('confirmed', 'completed')");
    expect(e).toContain('v_b.ends_at <= now()');
    expect(e).toContain('v_a.id is not null');                     // a declaration must exist
    expect(e).toContain('v_ev.finalised');
    expect(e).toContain("v_ev.evidence_quality = 'complete'");
  });
  it('defines exactly the three named blocking contradictions', () => {
    expect(e).toContain("v_a.outcome = 'took_place' and not v_ev.companion_ever_connected");   // A
    expect(e).toContain("v_a.outcome = 'took_place' and not v_ev.member_ever_connected");       // B
    expect(e).toContain("v_a.outcome = 'member_no_show'");                                       // C
    expect(e).toContain('v_ev.overlap_seconds >= c_blocking_overlap_seconds');
  });
  it('serialises on the evidence row and locks the earning at FIRST detection only', () => {
    expect(e).toContain('from public.call_attendance_evidence where booking_id = p_booking for update');
    expect(e).toContain('from public.companion_earnings where id = v_earn.id for update');
    // Auto-clear is limited to an untouched, system ACTIVE review.
    expect(e).toContain("v_rev.state = 'active' and not v_rev.support_touched");
    expect(e).toContain("resolution = 'auto_cleared_corrected_evidence'");
  });
  it('never creates an earning, calls a transfer/refund/credit worker, or Stripe', () => {
    const c = stripSql(e).toLowerCase();
    for (const bad of ['ensure_companion_earning', 'claim_plan_transfers', 'stripe', 'refund',
                       'credit_ledger', 'payment_disputes', 'reconcil', 'make_transfer']) {
      expect(c).not.toContain(bad);
    }
    // No payment-order money mutation, no earning insert.
    expect(stripSql(e)).not.toMatch(/insert\s+into\s+public\.companion_earnings|update\s+public\.payment_orders\s+set/i);
  });
});

describe('0072 defence in depth — make_payable + transfer claim both gate on the hold', () => {
  it('make_earning_payable refuses while a hold blocks (0034 body + one guard)', () => {
    const m = fn('app_private.make_earning_payable');
    expect(m).toContain('if app_private.evidence_hold_blocks_payout(v_e.booking_id) then return; end if;');
    // Still the 0034 mechanics (pending_completion → payable + notify).
    expect(m).toContain("v_e.state <> 'pending_completion'");
    expect(m).toContain("set state = 'payable'");
  });
  it('claim_plan_transfers excludes held earnings even when payable (0050 body + one exclusion)', () => {
    const c = fn('public.claim_plan_transfers');
    expect(c).toContain('and not app_private.evidence_hold_blocks_payout(e.booking_id)');
    expect(c).toContain('for update of e skip locked');            // race-safe claim
    expect(c).toContain("e.state = 'payable'");                    // unchanged claim shape
    expect(c).toContain('#variable_conflict use_column');
  });
  it('evidence_hold_blocks_payout is true only for active/claimed reviews', () => {
    const h = fn('app_private.evidence_hold_blocks_payout');
    expect(h).toContain("r.state in ('active', 'claimed')");        // post_transfer no longer blocks
  });
});

describe('0072 support workflow — support-only, release without deny+refund', () => {
  it('every support RPC is is_support_admin-gated', () => {
    for (const rpc of ['public.support_evidence_review_queue', 'public.support_evidence_review_detail',
                       'public.support_claim_evidence_review', 'public.support_add_evidence_review_note',
                       'public.support_recheck_evidence_review', 'public.support_release_evidence_review']) {
      expect(fn(rpc)).toContain('if not app_private.is_support_admin() then raise exception');
    }
  });
  it('release requires a reason, offers no deny+refund, and hands back to the existing make-payable logic', () => {
    const r = fn('public.support_release_evidence_review');
    expect(r).toContain("p_resolution not in ('release_payout', 'superseded_by_corrected_evidence', 'escalate_to_existing_issue_process')");
    expect(r).toContain('reason_required');
    // Waiting-period gate before re-running the EXISTING make-payable (never the worker).
    expect(r).toContain('v_b.ends_at + make_interval(hours => c_wait_hours) <= now()');
    expect(r).toContain('perform app_private.make_earning_payable(v_r.earning_id)');
    expect(stripSql(r).toLowerCase()).not.toContain('claim_plan_transfers');   // never the transfer worker
    expect(stripSql(r).toLowerCase()).not.toContain('refund');
  });
  it('detail/queue expose no secrets', () => {
    const blob = fn('public.support_evidence_review_detail') + fn('public.support_evidence_review_queue');
    expect(blob).not.toMatch(/room_name|stripe|access_token|card|bank|private_feedback|message/i);
  });
});

describe('0072 completion read model — Companion under_review, others unchanged', () => {
  const g = fn('public.get_conversation_completion_state');
  it('overrides the Companion payout label to under_review while held (Companion-only)', () => {
    expect(g).toContain("if v_hold then\n      v_payout := 'under_review'");
    expect(g).toContain("'payout_under_review', v_hold");
    expect(g).toContain("if v_role = 'companion' then");
    // The hold flag lives inside the Companion branch — Member/Coordinator never see it.
    expect(g.indexOf("'payout_under_review'")).toBeGreaterThan(g.indexOf("if v_role = 'companion' then"));
    // Strict booleans + completed-booking review eligibility preserved from 0071.
    expect(g).toContain("'review_eligible', coalesce(v_role = 'member' and v_b.status = 'completed' and v_ended, false)");
    expect(g).toContain("'review_submitted', v_review_done");
  });
});

describe('0072 financial firewall (whole migration) + neutral notifications + PostgREST reload', () => {
  it('adds no automatic transfer/refund/credit/dispute/reconciliation/Stripe path', () => {
    // The migration DOES redefine claim_plan_transfers/make_earning_payable (existing
    // functions, gated) — those legitimately reference stripe_account_id column
    // names. It must add no NEW Stripe/HTTP call, refund/credit/dispute path, or
    // backfill.
    const lc = M_CODE.toLowerCase();
    for (const bad of ['pg_net', 'net.http', 'http_post', 'extensions.http', 'payment_refunds',
                       'refund_', 'credit_ledger', 'spend_account_credit', 'issue_account_credit',
                       'payment_disputes', 'reconcil', 'backfill']) {
      expect(lc).not.toContain(bad);
    }
    // No monetary payment-order mutation; no global earning creation.
    expect(M_CODE).not.toMatch(/update\s+public\.payment_orders\s+set|insert\s+into\s+public\.companion_earnings/i);
    expect(M).not.toMatch(/create\s+(or replace\s+)?(trigger|function)[\s\S]*?process_plan_renewals|settlement/i);
  });
  it('notifications are deduplicated and neutral', () => {
    expect(M).toContain("'evidence_hold:' || v_id::text");         // companion hold dedupe key
    expect(M).toContain("'evidence_release:' || v_rev.id::text");  // release dedupe key
    expect(fn('app_private.notify_support_evidence_review')).toContain('from public.support_admins');
    expect(M).toContain("select pg_notify('pgrst', 'reload schema')");
  });
  it('the Companion note is neutral (no accusation, conflict code or support note)', () => {
    expect(NOTE).toContain('Payout under review');
    expect(NOTE).toContain('needs a quick review before payout continues');
    // Executable JSX only (comments explain what it avoids).
    expect(stripTs(NOTE)).not.toMatch(/conflict_code|support_note|cancelled|lied|no_show/i);
  });
});
