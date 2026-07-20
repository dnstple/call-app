/**
 * 2G4E — internal issue-review queue contracts (migration 0038 + frontend).
 *
 * Static contract tests over the support-only queue: server-gated readers,
 * privacy of complaint text / internal notes / secrets, the authoritative
 * (unchanged) financial resolution logic, role-aware deduplicated
 * notifications, server-derived route protection, and a frontend that holds
 * no financial logic. Live behaviour is verified against the hosted project.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf-8');

const SQL = read('supabase', 'migrations', '0038_internal_issue_queue.sql');
const REPO = read('src', 'repositories', 'internalIssueRepository.ts');
const FORM = read('src', 'components', 'internal', 'IssueResolutionForm.tsx');
const APP = read('src', 'App.tsx');
const SHELL = read('src', 'components', 'Shell.tsx');
const SUPPORT = read('src', 'state', 'support.ts');

const CODE = SQL.replace(/--.*$/gm, ''); // comment-stripped, for negatives

describe('0038 support-authorisation reader', () => {
  it('am_i_support is a public wrapper over the DB-backed role, granted to authenticated', () => {
    expect(SQL).toContain('create or replace function public.am_i_support()');
    expect(SQL).toContain('select app_private.is_support_admin()');
    expect(SQL).toContain('revoke all on function public.am_i_support() from public, anon');
    expect(SQL).toContain('grant execute on function public.am_i_support() to authenticated');
  });
});

describe('0038 queue reader', () => {
  const fn = SQL.slice(
    SQL.indexOf('create or replace function public.get_internal_issue_queue'),
    SQL.indexOf('create or replace function public.get_internal_issue_detail'));

  it('is support-gated with a neutral error', () => {
    expect(fn).toContain('if not app_private.is_support_admin() then');
    expect(fn).toContain("raise exception 'not_found: queue'");
  });

  it('returns list fields but NEVER the complaint description', () => {
    expect(fn).toContain("'member_name'");
    expect(fn).toContain("'companion_name'");
    expect(fn).toContain("'held_minor'");
    expect(fn).toContain("'has_attendance_evidence'");
    // The private complaint text must not appear in the list view.
    expect(fn).not.toContain("'description'");
    expect(fn).not.toContain('i.description');
  });

  it('supports state/priority/category/reporter filters and is authenticated-gated', () => {
    expect(fn).toContain('i.state = any (p_states)');
    expect(fn).toContain('i.priority = p_priority');
    expect(fn).toContain('i.category = p_category');
    expect(fn).toContain('i.reporter_role = p_reporter_role');
    expect(SQL).toContain('grant execute on function public.get_internal_issue_queue(text[], text, text, text) to authenticated');
  });
});

describe('0038 detail reader', () => {
  const fn = SQL.slice(
    SQL.indexOf('create or replace function public.get_internal_issue_detail'),
    SQL.indexOf('create or replace function public.resolve_conversation_issue'));

  it('is support-gated', () => {
    expect(fn).toContain('if not app_private.is_support_admin() then');
    expect(fn).toContain("raise exception 'not_found: issue'");
  });

  it('returns the case-review data support needs', () => {
    expect(fn).toContain("'description', v_i.description");     // support-only complaint
    expect(fn).toContain("'customer_total_minor'");
    expect(fn).toContain("'service_fee_minor'");
    expect(fn).toContain("'companion_entitlement_minor'");
    expect(fn).toContain("'attendance_summary'");
    expect(fn).toContain("'both_two_minutes'");
    expect(fn).toContain("'companion_no_show_threshold'");
    expect(fn).toContain("'credit_status'");
    expect(fn).toContain("'resolution'");
  });

  it('never returns secrets, tokens, bank details, raw payloads or private feedback', () => {
    expect(fn).not.toMatch(/private_feedback/i);
    expect(fn).not.toMatch(/stripe_/i);
    expect(fn).not.toMatch(/secret|token|bank|payload|participant_identity/i);
  });
});

describe('0038 resolution: same financial logic, added notifications', () => {
  const fn = SQL.slice(SQL.indexOf('create or replace function public.resolve_conversation_issue'));

  it('keeps the authoritative, idempotent, atomic financial machinery', () => {
    expect(fn).toContain('if not app_private.is_support_admin() then');
    expect(fn).toContain('from public.issue_resolutions where idempotency_key = p_idempotency');
    expect(fn).toContain("if v_issue.state = 'resolved' then");
    expect(fn).toContain('perform public.issue_account_credit');
    expect(fn).toContain("'resolution-credit-' || v_issue.id::text");
    expect(fn).toContain('payable_at = case when p_companion_minor > 0 then coalesce(payable_at, now())');
    expect(fn).toContain("raise exception 'invalid_amounts");
    expect(fn).toContain('for update');
  });

  it('adds role-aware, deduplicated notifications + a neutral shared event', () => {
    expect(fn).toContain("'issue-resolved-companion:' || v_issue.id::text");
    expect(fn).toContain("'issue-resolved-coordinator:' || v_issue.id::text");
    expect(fn).toContain("'account_credit_issued', 'Account credit issued'");
    expect(fn).toContain("'conversation_issue_resolved'");
    expect(fn).toContain("'issue_resolved:' || v_issue.id::text");
    // Coordinator/companion accounts are derived from the earning, not the client.
    expect(fn).toContain('v_e.companion_account_id');
    expect(fn).toContain('v_e.payer_account_id');
  });

  it('creates no Stripe transfer or card refund anywhere', () => {
    // `transfer_state` (the earning's non-transferred state) is legitimately
    // surfaced; what must be absent is any Stripe transfer/refund CALL.
    expect(CODE).not.toMatch(/transfers?\s*\.\s*create/i);
    expect(CODE).not.toMatch(/refunds?\s*\.\s*create/i);
    expect(CODE).not.toMatch(/\bescrow\b/i);
    expect(CODE).not.toMatch(/stripe/i);
  });

  it('stays support-gated at the grant level (authenticated, gated internally)', () => {
    expect(SQL).toContain('grant execute on function public.resolve_conversation_issue(uuid, text, text, integer, integer, text)');
  });
});

describe('repository sends only safe inputs; server derives the rest', () => {
  it('resolveConversationIssue passes only issue/outcome/note/amounts/idempotency', () => {
    expect(REPO).toContain('p_issue: input.issueId');
    expect(REPO).toContain('p_outcome: input.outcome');
    expect(REPO).toContain('p_note: input.note');
    expect(REPO).toContain('p_idempotency: input.idempotencyKey');
    // Never accepts member/companion/payer/currency/total/commission/state from the browser.
    expect(REPO).not.toMatch(/p_member|p_companion_id|p_payer|p_currency|p_total|p_commission|p_earning_state/);
  });

  it('all reads go through the support-gated RPCs (no direct private-table joins)', () => {
    expect(REPO).toContain("rpc('am_i_support')");
    expect(REPO).toContain("rpc('get_internal_issue_queue'");
    expect(REPO).toContain("rpc('get_internal_issue_detail'");
    expect(REPO).not.toMatch(/\.from\('conversation_issues'\)|\.from\('companion_earnings'\)|\.from\('credit_ledger'\)/);
  });
});

describe('resolution form: no financial logic, explicit confirm, safe copy', () => {
  it('offers the four authoritative outcomes only', () => {
    for (const o of [
      'companion_payable_full', 'customer_credit_full', 'partial_resolution', 'issue_dismissed_release',
    ]) {
      expect(FORM).toContain(o);
    }
  });

  it('uses an explicit review step, never browser confirm()', () => {
    expect(FORM).toContain('reviewing');
    // Check executable code, not the doc comment that names browser confirm().
    const code = FORM.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('window.confirm');
    expect(code).not.toMatch(/(?<![.\w])confirm\(/);
  });

  it('blocks duplicate submission and delegates to the authoritative RPC', () => {
    expect(FORM).toContain('if (!outcome || submitting || !canReview) return;');
    expect(FORM).toContain('resolveConversationIssue({');
    expect(FORM).toContain('idempotencyKey: `resolve-${detail.issueId}`');
    // No direct financial state writes in the component.
    expect(FORM).not.toMatch(/companion_earnings|credit_ledger|issue_resolutions/);
  });

  it('confirmation copy is honest: no Stripe transfer, no card refund', () => {
    expect(FORM).toContain('It will not create a Stripe transfer.');
    expect(FORM).toContain('It will not refund the payment card.');
    // Money crosses to the server as integer minor units.
    expect(FORM).toContain('Math.round(Number(trimmed) * 100)');
  });

  it('validates partial amounts against the permitted totals', () => {
    expect(FORM).toContain('cannot be negative');
    expect(FORM).toContain('Combined amount cannot exceed');
    expect(FORM).toContain('unallocated');
  });
});

describe('route protection is server-derived', () => {
  it('SupportOnly gates on the server support check and never falls back to access', () => {
    expect(APP).toContain('function SupportOnly');
    expect(APP).toContain('const status = useIsSupport();');
    expect(APP).toContain("if (status === 'loading')");     // no case data before auth resolves
    expect(APP).toContain("if (status !== 'yes')");          // deny for non-support
    expect(APP).toContain('<SupportOnly><InternalIssues /></SupportOnly>');
    expect(APP).toContain('<SupportOnly><InternalIssueDetail /></SupportOnly>');
  });

  it('the support status hook is always server-derived and mock-safe', () => {
    expect(SUPPORT).toContain('amISupport()');
    expect(SUPPORT).toContain('if (!isSupabaseMode())');
    expect(SUPPORT).not.toMatch(/localStorage|sessionStorage/);
  });

  it('the internal nav entry is shown ONLY to confirmed support users', () => {
    expect(SHELL).toContain("supportStatus === 'yes'");
    expect(SHELL).toContain('/internal/issues');
  });
});
