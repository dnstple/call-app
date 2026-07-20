/**
 * 2G4D — scheduled post-conversation processing contracts (migration 0037).
 *
 * Static contract tests over the additive automation migration: reminders,
 * review prompts, the 24-hour fallback notifications, the orchestrator's
 * error policy, the run-audit table, deterministic dedupe keys, safe copy
 * and guarded pg_cron scheduling. Live money behaviour is verified against
 * the hosted project; these pin the server-side rules statically.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const SQL = readFileSync(join(ROOT, 'supabase', 'migrations', '0037_completion_automation.sql'), 'utf-8');
const SQL34 = readFileSync(join(ROOT, 'supabase', 'migrations', '0034_completion_reviews_earnings.sql'), 'utf-8');

/** SQL with line comments stripped, for negative assertions. */
const CODE = SQL.replace(/--.*$/gm, '');

describe('0037 reuses the financial state machine (no duplication)', () => {
  it('does NOT redefine release_eligible_earnings or make_earning_payable', () => {
    expect(SQL).not.toMatch(/create or replace function public\.release_eligible_earnings/);
    expect(SQL).not.toMatch(/function app_private\.make_earning_payable/);
  });

  it('reuses the existing release + payable helpers by call', () => {
    expect(SQL).toContain('public.release_eligible_earnings()');
    expect(SQL).toContain('app_private.make_earning_payable(v_earning)');
    expect(SQL).toContain('app_private.ensure_companion_earning');
    expect(SQL).toContain('app_private.notify_account');
  });

  it('never implies money moved (no transfer/deposit/refund/escrow; "payout" is future-tense and allowed)', () => {
    // "payout" IS permitted — it describes a FUTURE payout, not a completed
    // transfer. The forbidden words are the ones that claim money moved.
    expect(CODE).not.toMatch(/\btransfer(red|s)?\b/i);
    expect(CODE).not.toMatch(/\bdeposit(ed|s)?\b/i);
    expect(CODE).not.toMatch(/\brefund(ed|s)?\b/i);
    expect(CODE).not.toMatch(/\bescrow\b/i);
    // The payable-adjacent copy uses the approved future-payout wording.
    expect(SQL).toContain('ready for payout');
  });

  it('the reused 12-hour release still uses FOR UPDATE SKIP LOCKED + ends_at (0034)', () => {
    expect(SQL34).toContain('for update of e skip locked');
    expect(SQL34).toContain("b.ends_at + interval '12 hours' <= now()");
    expect(SQL34).toContain('payable_at = coalesce(payable_at, now())');
  });
});

describe('two-hour attendance reminder', () => {
  const fn = SQL.slice(
    SQL.indexOf('create or replace function public.create_companion_attendance_reminders'),
    SQL.indexOf('grant execute on function public.create_companion_attendance_reminders'));

  it('eligibility: funded, 2h after ends_at, no attendance, no open issue, not cancelled', () => {
    expect(fn).toContain("po.provider = 'stripe_test' and po.status = 'succeeded'");
    expect(fn).toContain("b.ends_at <= now() - interval '2 hours'");
    expect(fn).toContain("b.status not in ('cancelled', 'declined')");
    expect(fn).toContain('from public.conversation_attendance a where a.booking_id = b.id');
    expect(fn).toContain("i.state <> 'resolved'");
  });

  it('one deterministic reminder per booking; retries create zero duplicates', () => {
    expect(fn).toContain("'attendance-reminder-2h:' || b.id::text");
    // Pre-filter on the exact dedupe key, plus notify_account's own unique index.
    expect(fn).toContain("n.dedupe_key = 'attendance-reminder-2h:' || b.id::text");
  });

  it('required copy, correct Member name, no payment claim', () => {
    expect(fn).toContain("'Confirm your conversation'");
    expect(fn).toContain('Please confirm whether your conversation with');
    // The reminder NOTIFICATION itself must not imply money (scope to the
    // notify_account call so the payment_orders eligibility join is excluded).
    const notify = fn.slice(fn.indexOf("'attendance_reminder'"), fn.indexOf("2h:' || v_row.booking_id::text)"));
    expect(notify).not.toMatch(/payment|payout|earnings/i);
  });

  it('is service-only', () => {
    expect(SQL).toContain('revoke all on function public.create_companion_attendance_reminders() from public, anon, authenticated');
    expect(SQL).toContain('grant execute on function public.create_companion_attendance_reminders() to service_role');
  });
});

describe('coordinator review prompt', () => {
  const fn = SQL.slice(
    SQL.indexOf('create or replace function public.create_review_prompts'),
    SQL.indexOf('grant execute on function public.create_review_prompts'));

  it('one deterministic prompt per funded booking, not requiring companion first', () => {
    expect(fn).toContain("'review-prompt:' || b.id::text");
    expect(fn).toContain("'How did the conversation go?'");
    expect(fn).toContain('Tell us how ');
    // No dependency on companion attendance being submitted.
    expect(fn).not.toContain('conversation_attendance');
  });

  it('skips already-reviewed or open-issue bookings and is service-only', () => {
    expect(fn).toContain('from public.conversation_reviews r where r.booking_id = b.id');
    expect(fn).toContain("i.state <> 'resolved'");
    expect(SQL).toContain('grant execute on function public.create_review_prompts() to service_role');
  });
});

describe('24-hour fallback: state machine unchanged, notifications added', () => {
  const fn = SQL.slice(
    SQL.indexOf('create or replace function public.resolve_unconfirmed_attendance'),
    SQL.indexOf('function public.process_post_conversation_tasks'));

  it('keeps the trusted thresholds and system-derived marking', () => {
    expect(fn).toContain('v_comp >= 120 and v_mem >= 120');
    expect(fn).toContain('v_comp >= 600 and v_mem < 120');
    expect(fn).toContain("'took_place', 'system'");
    expect(fn).toContain("'member_no_show', 'system'");
  });

  it('relaxes the status gate but keeps issue precedence + 24h + funded guard', () => {
    expect(fn).toContain("b.status not in ('cancelled', 'declined', 'change_proposed')");
    expect(fn).not.toContain("b.status = 'confirmed'");
    expect(fn).toContain("b.ends_at + interval '24 hours' <= now()");
    expect(fn).toContain("po.provider = 'stripe_test' and po.status = 'succeeded'");
    expect(fn).toContain("i.state <> 'resolved'");
    expect(fn).toContain('for update of b skip locked');
  });

  it('unclear evidence holds the earning and opens ONE manual-review case', () => {
    expect(fn).toContain("state = 'held_for_issue'");
    expect(fn).toContain("'unclear_attendance'");
    expect(fn).toContain("'unclear-' || v_row.booking_id::text");
  });

  it('emits neutral, deduped, role-aware notifications with no raw durations', () => {
    expect(fn).toContain("'fallback-completed:' || v_row.booking_id::text");
    expect(fn).toContain("'fallback-attendance:' || v_row.booking_id::text");
    expect(fn).toContain("'attendance-review:' || v_row.booking_id::text");
    expect(fn).toContain("'Conversation completed'");
    expect(fn).toContain("'Attendance confirmed'");
    expect(fn).toContain("'Conversation under review'");
    // Coordinator no-show copy must not accuse the Member; the neutral
    // "reviewed using the call record" wording is used instead.
    expect(fn).toContain('The conversation attendance was reviewed using the call record.');
    expect(fn).not.toContain('did not attend');
    // Durations/seconds are never surfaced in notification bodies.
    expect(fn).not.toMatch(/notify_account\([^)]*seconds/i);
  });

  it('stays service-only', () => {
    expect(SQL).toContain('revoke all on function public.resolve_unconfirmed_attendance() from public, anon, authenticated');
    expect(SQL).toContain('grant execute on function public.resolve_unconfirmed_attendance() to service_role');
  });
});

describe('orchestration + observability', () => {
  it('a run-audit table records each run and is support-read-only', () => {
    expect(SQL).toContain('create table if not exists public.post_conversation_run_audit');
    expect(SQL).toContain("status text not null default 'running' check (status in ('running', 'ok', 'error'))");
    expect(SQL).toContain('app_private.is_support_admin()');
  });

  it('each child runs independently; a failure is visible, never silently ok', () => {
    const fn = SQL.slice(SQL.indexOf('function public.process_post_conversation_tasks'));
    // Four child calls, each wrapped in its own begin/exception subtransaction.
    for (const call of [
      'public.create_review_prompts()',
      'public.create_companion_attendance_reminders()',
      'public.resolve_unconfirmed_attendance()',
      'public.release_eligible_earnings()',
    ]) {
      expect(fn).toContain(call);
    }
    expect(fn).toContain('exception when others then');
    expect(fn).toContain("status = case when v_errors = '' then 'ok' else 'error' end");
    expect(fn).toContain("v_errors := v_errors || 'release_earnings: ' || sqlerrm");
  });

  it('ordering: prompts + reminders, then fallback, then normal release', () => {
    const fn = SQL.slice(SQL.indexOf('function public.process_post_conversation_tasks'));
    expect(fn.indexOf('create_review_prompts()')).toBeLessThan(fn.indexOf('resolve_unconfirmed_attendance()'));
    expect(fn.indexOf('resolve_unconfirmed_attendance()')).toBeLessThan(fn.indexOf('release_eligible_earnings()'));
  });

  it('the orchestrator is service-only', () => {
    expect(SQL).toContain('revoke all on function public.process_post_conversation_tasks() from public, anon, authenticated');
    expect(SQL).toContain('grant execute on function public.process_post_conversation_tasks() to service_role');
  });
});

describe('scheduling is guarded and endpoint-free', () => {
  it('registers pg_cron only when available, idempotently, with a fallback notice', () => {
    expect(SQL).toContain("select 1 from pg_available_extensions where name = 'pg_cron'");
    expect(SQL).toContain('create extension if not exists pg_cron');
    expect(SQL).toContain("'process-post-conversation-tasks'");
    expect(SQL).toContain("'*/15 * * * *'");
    expect(SQL).toContain('exception when others then');
  });

  it('no public/unauthenticated batch endpoint is exposed', () => {
    // The only grants added are to service_role; nothing to anon/authenticated.
    expect(SQL).not.toMatch(/grant execute on function public\.(process_post_conversation_tasks|create_companion_attendance_reminders|create_review_prompts|resolve_unconfirmed_attendance)\([^)]*\) to (authenticated|anon)/);
  });
});
