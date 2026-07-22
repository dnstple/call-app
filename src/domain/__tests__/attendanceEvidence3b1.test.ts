/**
 * Stage 3B1 — authoritative call attendance evidence (0069) contract proofs.
 *
 * These are static/source contracts (no DB). They prove the migration is
 * additive, deterministic, role-aware and — above all — FINANCIALLY INERT:
 * evidence aggregation and the completion read model never touch an earning,
 * transfer, refund, dispute, credit or payment-order money, and never call
 * Stripe. Behavioural proofs live in the hosted rls.integration block.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const M = readFileSync(join(ROOT, 'supabase', 'migrations', '0069_authoritative_call_attendance_evidence.sql'), 'utf-8');
const NOTE = readFileSync(join(ROOT, 'src', 'components', 'CallEvidenceNote.tsx'), 'utf-8');
const DETAIL = readFileSync(join(ROOT, 'src', 'pages', 'BookingDetail.tsx'), 'utf-8');

/** Body of a single function definition, up to its closing `$$;`. */
function fn(name: string): string {
  const s = M.indexOf(`create or replace function ${name}`);
  if (s < 0) throw new Error(`0069 fn not found: ${name}`);
  return M.slice(s, M.indexOf('\n$$;', s));
}
/** Strip SQL/TS comments so assertions match EXECUTABLE code, not documentation
 * (the migration header deliberately NAMES the financial calls it never makes). */
const stripSql = (s: string): string => s.replace(/--.*$/gm, '');
const stripTs = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const M_CODE = stripSql(M);

describe('0069 is additive and never rewrites an existing function', () => {
  it('introduces only NEW objects (no create-or-replace of earning/attendance/issue fns)', () => {
    // The 0067 stale-cumulative-body mistake is impossible here: 0069 defines only
    // brand-new functions.
    for (const existing of [
      'public.submit_companion_attendance', 'app_private.ensure_companion_earning',
      'app_private.make_earning_payable', 'public.resolve_unconfirmed_attendance',
      'public.report_conversation_issue', 'public.get_companion_completion_state',
      'app_private.ingest_call_event', 'app_private.ensure_call_session']) {
      expect(M).not.toContain(`create or replace function ${existing}`);
    }
    expect(M).not.toMatch(/drop\s+table|alter\s+table\s+public\.(bookings|companion_earnings|payment_orders)/i);
    expect(M).toContain("select pg_notify('pgrst', 'reload schema')");
  });
});

describe('financial firewall — 0069 moves no money and calls no financial path', () => {
  it('never CALLS an earning mutator or any transfer/refund/dispute/credit/Stripe path', () => {
    // Executable code only (comments name these paths precisely to say it avoids them).
    const forbidden = [
      'ensure_companion_earning', 'make_earning_payable', 'companion_transfer_attempts',
      'claim_transfer', 'payment_refunds', 'payment_disputes', 'credit_ledger',
      'spend_account_credit', 'issue_account_credit', 'stripe'];
    for (const bad of forbidden) {
      expect(M_CODE.toLowerCase()).not.toContain(bad.toLowerCase());
    }
    // Reading companion_earnings.state for a Companion-safe payout label is allowed;
    // WRITING any money row is not.
    expect(M_CODE).not.toMatch(/insert\s+into\s+public\.(companion_earnings|payment_orders|companion_transfer_attempts|payment_refunds)/i);
    expect(M_CODE).not.toMatch(/update\s+public\.(companion_earnings|payment_orders)\s+set/i);
  });
  it('the evidence trigger is EVIDENCE-ONLY (recompute, never a financial call)', () => {
    const t = fn('app_private.trg_sync_attendance_evidence');
    expect(t).toContain('app_private.recompute_attendance_evidence');
    expect(t).not.toMatch(/earning|transfer|refund|payable/i);
    expect(M).toContain('after insert or update on public.call_provider_events');
    expect(M).toContain('when (new.call_session_id is not null)');
  });
});

describe('evidence model — required shape', () => {
  it('call_attendance_evidence carries both sides, overlap, provenance and status vocab', () => {
    expect(M).toContain('create table if not exists public.call_attendance_evidence');
    for (const col of [
      'companion_first_joined_at', 'companion_last_left_at', 'companion_connected_seconds',
      'companion_join_count', 'companion_ever_connected',
      'member_first_joined_at', 'member_last_left_at', 'member_connected_seconds',
      'member_join_count', 'member_ever_connected',
      'overlap_seconds', 'both_connected', 'evidence_version',
      'last_provider_event_id', 'last_provider_event_at', 'calculated_at',
      'window_opens_at', 'window_closes_at']) {
      expect(M).toContain(col);
    }
    for (const q of ['complete', 'partial', 'no_provider_events', 'inconsistent_provider_events',
                     'outside_eligible_booking', 'pending_call_window']) {
      expect(M).toContain(`'${q}'`);
    }
    for (const c of ['both_connected', 'companion_only', 'member_only', 'neither_observed',
                     'insufficient_evidence', 'pending']) {
      expect(M).toContain(`'${c}'`);
    }
  });
});

describe('aggregation — deterministic, window-bounded, overlap-aware', () => {
  const r = fn('app_private.recompute_attendance_evidence');
  it('is idempotent (on-conflict upsert) and locks the session for serial application', () => {
    expect(r).toContain('for update');
    expect(M).toContain('on conflict (booking_id) do update set');
  });
  it('bounds the window from the SESSION snapshot via call_config (reschedule-aware)', () => {
    expect(r).toContain('v_s.scheduled_start - make_interval(mins => coalesce(v_cfg.join_opens_before_start_minutes');
    expect(r).toContain('v_s.scheduled_end + make_interval(mins => coalesce(v_cfg.join_closes_after_end_minutes');
    // Missing-leave segments are bounded (never open-ended).
    expect(r).toContain('v_bound := least(v_closes, coalesce(v_s.room_finished_at, v_closes), now())');
  });
  it('orders by provider time (out-of-order safe) and maps identity → logical side', () => {
    expect(r).toContain('order by coalesce(e.provider_created_at, e.received_at), e.received_at, e.provider_event_id');
    expect(r).toContain('cp.booking_role as side');
    expect(r).toContain('if v_evt.side is null then continue');   // unexpected identity never counted
  });
  it('computes cross-side overlap and never infers absence from silence', () => {
    expect(r).toContain('v_overlap');
    expect(r).toContain("v_quality := 'no_provider_events'");
    expect(r).toContain("v_quality := 'pending_call_window'");
    expect(r).toContain("v_quality := 'outside_eligible_booking'");
  });
});

describe('completion read model — role-aware and payout-safe', () => {
  const g = fn('public.get_conversation_completion_state');
  it('derives the caller role server-side and fails closed for unrelated callers', () => {
    expect(g).toContain('app_private.can_edit_profile(v_b.companion_profile_id)');
    expect(g).toContain('app_private.can_act_for_member(v_b.member_profile_id)');
    expect(g).toContain('app_private.is_support_admin()');
    expect(g).toMatch(/else\s*\n\s*raise exception 'not_found: conversation'/);
  });
  it('exposes payout status to the Companion ONLY, and never Stripe/transfer/room detail', () => {
    expect(g).toContain("if v_role = 'companion' then");
    expect(g).toContain("'payout_status'");
    // The member/coordinator branch must not carry payout fields; and no raw
    // provider/room/stripe leakage anywhere in the EXECUTABLE read model.
    const gCode = stripSql(g);
    expect(gCode).not.toMatch(/room_name/);
    expect(gCode).not.toMatch(/stripe|transfer_state|stripe_account/i);
  });
  it('derives the completion-state vocabulary (nothing new is stored)', () => {
    for (const s of ['cancelled_or_declined', 'not_eligible', 'scheduled', 'call_window_open',
                     'issue_open', 'evidence_conflict', 'companion_reported_member_absent',
                     'member_confirmed', 'companion_reported_took_place', 'awaiting_companion_report',
                     'finalised']) {
      expect(g).toContain(`'${s}'`);
    }
    // Conflict is DERIVED and never overwrites a source declaration/confirmation.
    expect(g).toContain('v_conflict := true');
    expect(g).not.toMatch(/update\s+public\.(conversation_attendance|completion_confirmations|companion_earnings)/i);
  });
});

describe('support diagnostics — support-only, no secrets', () => {
  const d = fn('public.support_attendance_diagnostics');
  it('is gated to support and leaks no room name, token or financial/message secret', () => {
    expect(d).toContain('if not app_private.is_support_admin() then raise exception');
    expect(d).not.toMatch(/room_name|access_token|private_feedback|stripe|card|bank/i);
  });
});

describe('frontend — calm, neutral, role-correct evidence wording', () => {
  it('the evidence note is non-accusatory and free of payout wording', () => {
    expect(NOTE).toContain('The call connection record is incomplete. Your response has been saved.');
    expect(NOTE).toContain('get_conversation_completion_state');
    // No payout/earning wording in the executable component (comments excluded).
    expect(stripTs(NOTE)).not.toMatch(/payout|earning|transfer|paid|no-show|no_show/i);
  });
  it('BookingDetail renders the evidence note only for an accepted, ended conversation', () => {
    expect(DETAIL).toContain('CallEvidenceNote');
    expect(DETAIL).toContain('ended && eligibleForCompletion && (isCompanionSide || isRequesterSide)');
    // The 0067 acceptance gate is preserved verbatim.
    expect(DETAIL).toContain("const eligibleForCompletion = booking.status === 'confirmed'");
  });
});
