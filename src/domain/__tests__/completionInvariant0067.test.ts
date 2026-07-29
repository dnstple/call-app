/**
 * Completion & earning invariant fix (0067) — contract proofs.
 *
 * Only an ACCEPTED (confirmed) booking may enter the attendance/completion/
 * earning/notification workflow. A requested/declined/cancelled/change_proposed
 * booking fails closed everywhere — attendance, earning creation, reminders,
 * review prompts and the 24h resolver. The frontend renders no completion/payout
 * card for a non-accepted booking. Financial mechanics are unchanged.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const M = readFileSync(join(ROOT, 'supabase', 'migrations', '0067_completion_and_earning_invariant_fix.sql'), 'utf-8');
const M68 = readFileSync(join(ROOT, 'supabase', 'migrations', '0068_restore_completion_earning_semantics.sql'), 'utf-8');
function fn68(name: string): string {
  const s = M68.indexOf(`create or replace function ${name}`);
  if (s < 0) throw new Error(`0068 fn not found: ${name}`);
  return M68.slice(s, M68.indexOf('\n$$;', s));
}
const DETAIL = readFileSync(join(ROOT, 'src', 'pages', 'BookingDetail.tsx'), 'utf-8');
const REVIEW = readFileSync(join(ROOT, 'src', 'components', 'ReviewCard.tsx'), 'utf-8');
const SCAN = readFileSync(join(ROOT, 'docs', 'diagnostics', 'completion_earning_invariant_scan.sql'), 'utf-8');

function fn(name: string): string {
  const s = M.indexOf(`create or replace function ${name}`);
  if (s < 0) throw new Error(`0067 fn not found: ${name}`);
  return M.slice(s, M.indexOf('\n$$;', s));
}

describe('0067 is additive and corrective (never edits 0034–0066)', () => {
  it('redefines only the eligibility-gated functions and reloads PostgREST', () => {
    for (const sig of ['app_private.ensure_companion_earning', 'public.submit_companion_attendance',
                       'public.create_companion_attendance_reminders', 'public.create_review_prompts',
                       'public.resolve_unconfirmed_attendance']) {
      expect(M).toContain(`create or replace function ${sig}`);
    }
    expect(M).not.toMatch(/drop\s+table|alter\s+table/i);        // no schema change
    expect(M).toContain("select pg_notify('pgrst', 'reload schema')");
  });
});

describe('earning creation fails closed for a non-accepted booking', () => {
  it('ensure_companion_earning returns null unless the booking is confirmed', () => {
    const e = fn('app_private.ensure_companion_earning');
    expect(e).toContain('select status into v_status from public.bookings where id = p_booking');
    expect(e).toMatch(/if v_status is distinct from 'confirmed' then\s*\n\s*return null;/);
    // The funded + companion-owner guards remain (defence in depth).
    expect(e).toContain("provider = 'stripe_test' and status = 'succeeded'");
    // Mechanics unchanged: still an on-conflict-do-nothing insert (idempotent).
    expect(e).toContain('on conflict (booking_id) do nothing');
  });
});

describe('attendance submission requires an accepted booking', () => {
  it('submit_companion_attendance raises not_eligible for a non-confirmed booking', () => {
    const s = fn('public.submit_companion_attendance');
    expect(s).toContain("if v_b.status <> 'confirmed' then");
    expect(s).toMatch(/status <> 'confirmed'[\s\S]*?raise exception 'not_eligible/);
    // The status guard precedes the too_early / earning checks.
    expect(s.indexOf("v_b.status <> 'confirmed'")).toBeLessThan(s.indexOf('v_b.ends_at > now()'));
    // Trusted-evidence + make_earning_payable mechanics unchanged.
    expect(s).toContain('make_earning_payable');
    expect(s).toContain('attendance_summary');
  });
});

describe('automation targets only accepted bookings', () => {
  it('reminders, review prompts and the 24h resolver all gate on confirmed', () => {
    for (const name of ['public.create_companion_attendance_reminders',
                        'public.create_review_prompts',
                        'public.resolve_unconfirmed_attendance']) {
      const body = fn(name);
      expect(body).toContain("b.status = 'confirmed'");
      // The old permissive gate is gone.
      expect(body).not.toMatch(/b\.status not in \('cancelled', 'declined'/);
    }
    // The resolver still uses the same financial branches (no weakening).
    const r = fn('public.resolve_unconfirmed_attendance');
    expect(r).toContain('make_earning_payable');
    expect(r).toContain("state = 'held_for_issue'");
  });
});

describe('frontend renders no completion/payout card for a non-accepted booking', () => {
  it('BookingDetail gates the completion cards on an accepted (confirmed) booking', () => {
    expect(DETAIL).toContain("const eligibleForCompletion = booking.status === 'confirmed'");
    expect(DETAIL).toContain('isRequesterSide && ended && eligibleForCompletion');
    expect(DETAIL).toContain('isCompanionSide && ended && eligibleForCompletion');
    // A non-eligible ended booking shows a neutral note, not a broken action.
    expect(DETAIL).toContain('ended && !eligibleForCompletion');
    expect(DETAIL.toLowerCase()).toContain('was not accepted');
  });
  it('the review card never calls the rating RPC before completion, and hides raw errors', () => {
    expect(REVIEW).toContain('const canRate = state.attendanceConfirmed');
    expect(REVIEW).toContain('friendlyReviewError');
    expect(REVIEW).not.toMatch(/setError\(String\(e\.message/); // raw error not shown
    expect(REVIEW).toMatch(/not_completed|not\.\*complete|completion/); // mapped
  });
});

describe('0068 restores the 0046 cumulative earning body + keeps the invariant', () => {
  const e = fn68('app_private.ensure_companion_earning');
  it('adds the confirmed-status invariant at the narrowest choke point (before both funding paths)', () => {
    expect(e).toContain('if v_b.status <> \'confirmed\' then');
    // The guard precedes Path A (the one-off order lookup).
    expect(e.indexOf("v_b.status <> 'confirmed'")).toBeLessThan(e.indexOf("provider = 'stripe_test' and status = 'succeeded'"));
  });
  it('restores Path A (one-off/trial) resolving the Companion from the BOOKING, not the order', () => {
    expect(e).toContain("provider = 'stripe_test' and status = 'succeeded'");
    // 0046 fix: companion owner comes from the booking (orders may omit it).
    expect(e).toContain('where pa.profile_id = v_b.companion_profile_id');
    expect(e).not.toContain('pa.profile_id = v_order.companion_profile_id'); // the stale 0034 lookup is gone
  });
  it('restores Path B (recurring-plan occurrence) + payer_charge / plan snapshots', () => {
    expect(e).toContain("v_b.booking_source <> 'package_credit'");
    expect(e).toContain("v_plan.funding_mode <> 'recurring'");
    expect(e).toContain('from public.plan_billing_periods');
    expect(e).toContain("status = 'paid'");
    expect(e).toContain('v_period.payment_order_id');
    // The insert carries the plan + payer-charge snapshot columns (0046).
    expect(e).toContain('plan_id, plan_billing_period_id, payer_charge_minor');
  });
  it('resolve_unconfirmed_attendance keeps recurring eligibility AND the confirmed gate', () => {
    const r = fn68('public.resolve_unconfirmed_attendance');
    expect(r).toContain("b.status = 'confirmed'");
    expect(r).toContain("p.funding_mode = 'recurring'");        // recurring path restored
    expect(r).toContain("bp.status = 'paid'");
    expect(r).toContain('make_earning_payable');                // mechanics unchanged
  });
  it('does not reintroduce the requested-booking defect (no permissive status fallback)', () => {
    expect(M68).not.toMatch(/status in \('requested'/);
    expect(M68).not.toMatch(/b\.status not in \('cancelled', 'declined'/);
    expect(M68).toContain("select pg_notify('pgrst', 'reload schema')");
  });
});

describe('historical impossible-state scan exists and is read-only', () => {
  it('covers non-confirmed attendance/earnings/prompts and stuck transfers', () => {
    expect(SCAN).not.toMatch(/\b(update|insert|delete)\b/i); // SELECT-only
    for (const check of ['A_nonconfirmed_attendance', 'B_nonconfirmed_earning_live',
                         'C_earning_no_evidence', 'D_review_prompt_nonconfirmed',
                         'E_attendance_reminder_nonconfirmed', 'F_transfer_processing_no_provider']) {
      expect(SCAN).toContain(check);
    }
  });
});
