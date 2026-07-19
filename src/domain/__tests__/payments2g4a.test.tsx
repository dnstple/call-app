// @vitest-environment jsdom
/**
 * 2G4A — completion/reviews/issues/earnings contracts (migration 0034).
 * Static contracts here; live behaviour joins the hosted RLS suite after
 * 0034 is applied.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const SQL = readFileSync(join(ROOT, 'supabase', 'migrations', '0034_completion_reviews_earnings.sql'), 'utf-8');
const EXEC = SQL.replace(/--.*$/gm, '');

describe('earnings model', () => {
  it('1+2+3. only succeeded stripe_test orders create ONE earning per booking', () => {
    expect(SQL).toContain('booking_id uuid not null unique references public.bookings(id)');
    expect(SQL).toContain("provider = 'stripe_test' and status = 'succeeded'");
    expect(SQL).toContain('return null; -- simulation / unfunded / ineligible: NO earning, ever.');
    expect(SQL).toContain('on conflict (booking_id) do nothing');
    expect(SQL).toContain("check (provider = 'stripe_test')");
  });

  it('4+5+7. values come ONLY from payment snapshots, integer GBP minor units', () => {
    expect(SQL).toContain('v_order.subtotal_minor - v_order.discount_minor - v_order.commission_minor');
    expect(SQL).toContain('v_order.commission_rate_pct');
    expect(EXEC).not.toMatch(/conversation_offers|active_commission|active_service_fee/);
    expect(SQL).toContain("currency text not null default 'GBP' check (currency = 'GBP')");
    expect(EXEC).not.toMatch(/_minor (numeric|real|double|float)/);
  });

  it('8+33+34. browsers cannot write earnings or invoke the processors', () => {
    expect(SQL).not.toMatch(/create policy .* on public\.companion_earnings[\s\S]{0,60}for (insert|update|delete)/i);
    for (const fn of ['release_eligible_earnings', 'resolve_unconfirmed_attendance']) {
      expect(SQL).toMatch(new RegExp(`revoke all on function public\\.${fn}\\(\\) from public, anon, authenticated`));
      expect(SQL).toMatch(new RegExp(`grant execute on function public\\.${fn}\\(\\) to service_role`));
    }
    expect(SQL).toMatch(/revoke all on function app_private\.ensure_companion_earning\(uuid\) from public, anon, authenticated/);
  });

  it('states + reserved transfer states; NO Stripe transfers anywhere', () => {
    expect(SQL).toContain("('pending_completion', 'held_for_issue', 'payable', 'reversed')");
    expect(SQL).toContain("('not_ready', 'transfer_pending', 'transferred', 'reversed')");
    expect(EXEC).not.toMatch(/transfers\.create|stripe\.transfer/i);
  });
});

describe('attendance', () => {
  it('6+7+10. companion-owner only, post-end enforced, one final outcome', () => {
    expect(SQL).toContain("pa.access_role = 'owner' and pa.consent_status <> 'withdrawn'");
    expect(SQL).toContain("raise exception 'too_early: the conversation has not finished yet'");
    expect(SQL).toContain('booking_id uuid not null unique references public.bookings(id)');
    expect(SQL).toContain("raise exception 'already_submitted: attendance has already been recorded'");
  });

  it('8+9+11. yes needs no explanation; others do; retry is idempotent', () => {
    expect(SQL).toContain("check (outcome = 'took_place' or source = 'system' or explanation is not null)");
    expect(SQL).toContain("raise exception 'explanation_required: please describe what happened'");
    expect(SQL).toContain("'repeat', true");
  });

  it('member_no_show is NEVER paid on assertion alone — held for evidence', () => {
    const branch = SQL.slice(SQL.indexOf("elsif p_outcome = 'member_no_show'"), SQL.indexOf('elsif p_outcome = ') > -1 ? SQL.indexOf('else\n    update public.companion_earnings') : undefined);
    expect(branch).toContain("state = 'held_for_issue'");
    expect(branch).not.toContain('make_earning_payable');
  });

  it('34. attendance segments have NO client policies and replay-safe uniqueness', () => {
    expect(SQL).toContain('external_event_id text not null unique');
    expect(SQL).not.toMatch(/create policy .* on public\.call_attendance_segments/i);
  });
});

describe('reviews + release rules', () => {
  it('11–14+24. coordinator-scoped, optional 1–5 stars, one per occurrence', () => {
    expect(SQL).toContain('rating smallint check (rating between 1 and 5)');
    expect(SQL).toContain("raise exception 'invalid_rating: stars must be between 1 and 5'");
    expect(SQL).toContain('booking_id uuid not null unique references public.bookings(id)');
    expect(SQL).toContain('approved boolean not null default true'); // fine without stars
  });

  it('15. private feedback stays author-only (no companion/public policy)', () => {
    expect(SQL).toContain('coordinator_account_id = auth.uid()');
    const reviewPolicies = SQL.slice(SQL.indexOf('conversation_reviews enable row level security'), SQL.indexOf('conversation_issues'));
    expect(reviewPolicies).not.toMatch(/companion_account_id|is_discoverable|using \(true\)/);
  });

  it('16+17+27. 24-hour edit window; edits never touch money', () => {
    expect(SQL).toContain("raise exception 'edit_window_closed: reviews can be edited for 24 hours'");
    const editBlock = SQL.slice(SQL.indexOf('-- Edits: same author'), SQL.indexOf("return jsonb_build_object('ok', true, 'edited', true)"));
    expect(editBlock).not.toContain('make_earning_payable');
    expect(editBlock).not.toContain('companion_earnings');
  });

  it('18+19+20+22+35. release = companion yes + (approval | 12h, no open issue); payable_at once', () => {
    expect(SQL).toContain("outcome = 'took_place'");
    expect(SQL).toContain("b.ends_at + interval '12 hours' <= now()");
    expect(SQL).toContain("i.state <> 'resolved'");
    expect(SQL).toContain("if v_e.id is null or v_e.state <> 'pending_completion' then return; end if;");
    expect(SQL).toContain('payable_at = coalesce(payable_at, now())');
    expect(SQL).toContain('for update of e skip locked');
  });
});

describe('issues + resolution', () => {
  it('23+24+26. role-aware categories; safety = high priority (allowed mid-call)', () => {
    expect(SQL).toContain("if p_category not in ('member_no_show', 'technical_problem', 'other') then");
    expect(SQL).toContain("'companion_no_show', 'member_no_show', 'audio_video_problem'");
    expect(SQL).toContain("if p_category = 'inappropriate_or_concerning_behaviour' then v_priority := 'high'; end if;");
    expect(SQL).toContain("p_category <> 'inappropriate_or_concerning_behaviour' and v_b.ends_at > now()");
  });

  it('25+54. complaint text is reporter+support only; one active issue per booking', () => {
    expect(SQL).toContain('reporter_account_id = auth.uid()');
    expect(SQL).toContain('conversation_issues_one_active');
    const issuePolicies = SQL.slice(SQL.indexOf('conversation_issues enable row level security'), SQL.indexOf('issue_resolutions'));
    expect(issuePolicies).not.toMatch(/using \(true\)/);
  });

  it('27–32. support-only atomic resolution: full pay / full credit incl. fee / partial / dismiss', () => {
    expect(SQL).toContain('if not app_private.is_support_admin() then');
    expect(SQL).toContain("p_credit_minor := v_order.total_minor; -- incl. service fee");
    expect(SQL).toContain("(p_companion_minor + p_credit_minor) > v_order.total_minor");
    expect(SQL).toContain('issue_id uuid not null unique references public.conversation_issues(id)');
    expect(SQL).toContain("'resolution-credit-' || v_issue.id::text"); // credit exactly once
    expect(SQL).toContain('where idempotency_key = p_idempotency');
    expect(EXEC).not.toMatch(/refunds?\.create/i);
  });

  it('support role is DB-backed and never self-granted', () => {
    expect(SQL).toContain('create table if not exists public.support_admins');
    expect(SQL).not.toMatch(/create policy .* on public\.support_admins[\s\S]{0,60}for insert/i);
    expect(SQL).toContain("granted_by text not null default 'service_role'");
  });
});

describe('24-hour fallback (evidence-based, service-role fixtures)', () => {
  it('35–38. 2-min both → apparent completion; 10-min wait → no-show payable; unclear → hold; issues override', () => {
    expect(SQL).toContain('v_comp >= 120 and v_mem >= 120');
    expect(SQL).toContain('v_comp >= 600 and v_mem < 120');
    expect(SQL).toContain("'unclear_attendance'");
    expect(SQL).toContain("b.ends_at + interval '24 hours' <= now()");
    // Open issues (incl. safety) exclude the booking from automation.
    expect(SQL).toContain("not exists (select 1 from public.conversation_issues i\n                      where i.booking_id = b.id and i.state <> 'resolved')");
    // System-derived attendance is labelled distinctly.
    expect(SQL).toContain("values (v_row.booking_id, 'took_place', 'system'");
  });
});
