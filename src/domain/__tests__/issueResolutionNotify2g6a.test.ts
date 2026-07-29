/**
 * Regression guard — resolve_conversation_issue must ALWAYS keep the role-aware
 * Companion + Coordinator resolution notifications and their dedupe keys (added
 * in 0038), never leak the internal note, and keep the four outcomes. 0046
 * accidentally rebuilt the function from the older 0034 body and dropped these;
 * 0047 restores them while keeping the 2G6A occurrence-level credit cap.
 *
 * This asserts against the CURRENT authoritative definition (highest-numbered
 * migration that redefines the function), so a future redefine that drops a
 * notification or key fails here before it can reach hosted.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIG = join(__dirname, '..', '..', '..', 'supabase', 'migrations');
const MARKER = 'create or replace function public.resolve_conversation_issue';

// The latest migration that (re)defines resolve_conversation_issue.
const latest = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()
  .filter((f) => readFileSync(join(MIG, f), 'utf-8').includes(MARKER)).pop()!;
const SQL = readFileSync(join(MIG, latest), 'utf-8');
const FN = SQL.slice(SQL.indexOf(MARKER), SQL.indexOf('\n$$;', SQL.indexOf(MARKER)));

describe(`resolve_conversation_issue notifications (authoritative: ${latest})`, () => {
  it('notifies BOTH the companion and coordinator with the established dedupe keys', () => {
    expect(FN).toContain("'issue-resolved-companion:' || v_issue.id::text");
    expect(FN).toContain("'issue-resolved-coordinator:' || v_issue.id::text");
    expect(FN).toContain('v_e.companion_account_id');
    expect(FN).toContain('v_e.payer_account_id');
    // customer_credit_full acknowledges the coordinator's credit distinctly.
    expect(FN).toContain("'account_credit_issued', 'Account credit issued'");
  });
  it('never passes the internal note into a notification', () => {
    const notifies = FN.match(/notify_account\([\s\S]*?\);/g) ?? [];
    expect(notifies.length).toBeGreaterThanOrEqual(6); // 3 outcome branches × 2 parties
    for (const n of notifies) {
      expect(n).not.toContain('p_note');
      expect(n).not.toContain('trim(p_note)');
    }
  });
  it('keeps the occurrence-level customer-charge cap (2G6A)', () => {
    expect(FN).toContain('v_charge := coalesce(v_e.payer_charge_minor, v_order.total_minor)');
    expect(FN).toContain('p_companion_minor := 0; p_credit_minor := v_charge;');
    expect(FN).toContain('p_credit_minor > v_charge');
  });
  it('keeps all four resolution outcomes and the support-admin gate', () => {
    expect(FN).toContain('if not app_private.is_support_admin()');
    for (const o of ['companion_payable_full', 'customer_credit_full', 'partial_resolution', 'issue_dismissed_release']) {
      expect(FN).toContain(`'${o}'`);
    }
  });
  it('stays idempotent (resolution key + resolved no-op)', () => {
    expect(FN).toContain('from public.issue_resolutions where idempotency_key = p_idempotency');
    expect(FN).toContain("if v_issue.state = 'resolved' then");
  });
});
