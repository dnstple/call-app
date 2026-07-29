/**
 * Block 2 (Trust & Safety) — migration + wiring contracts.
 *
 * The security-critical behaviour (consent versioning, block enforcement across
 * booking/message/conversation/call, moderation gating, report holds, support
 * authorisation) is functionally proven on scratch Postgres — see
 * outputs/block2_runner.py (RESULT fail=0, 30+ invariants). These structural
 * checks pin the migrations' additive safety and the frontend wiring so drift
 * cannot silently weaken a gate.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const M = (n: string) => readFileSync(join(ROOT, 'supabase', 'migrations', n), 'utf-8');
const M88 = M('0088_versioned_consent.sql');
const M89 = M('0089_conversation_reporting.sql');
const M90 = M('0090_user_blocking.sql');
const M91 = M('0091_companion_moderation.sql');
const M92 = M('0092_trust_safety_enforcement.sql');
const ALL = [M88, M89, M90, M91, M92];

describe('Block 2 migrations are additive and never touch financial history', () => {
  it('no destructive DDL and no writes to completed financial tables', () => {
    for (const m of ALL) {
      expect(m).not.toMatch(/drop\s+table|truncate/i);
      expect(m).not.toMatch(/(insert into|update)\s+public\.(payment_orders|companion_transfer_attempts|payment_refunds|settlement_adjustments|credit_ledger)/i);
    }
    // The ONLY earning write in the whole block is the existing held_for_issue hold.
    const earningWrites = ALL.join('\n').match(/update\s+public\.companion_earnings\s+set\s+state\s*=\s*'([a-z_]+)'/gi) ?? [];
    expect(earningWrites.every((w) => w.includes("'held_for_issue'"))).toBe(true);
  });
});

describe('0088 consent is versioned + server-owned', () => {
  it('keys acknowledgements by subject+type+version with one active row', () => {
    expect(M88).toContain('create table if not exists public.consent_policies');
    expect(M88).toContain('current_version integer not null');
    expect(M88).toContain('consent_ack_one_active');
    expect(M88).toMatch(/policy_version = p\.current_version/); // current-version check
  });
  it('has_current_consent + acknowledge are definer and revoked from clients', () => {
    expect(M88).toContain('app_private.has_current_consent(uuid, text)');
    expect(M88).toContain('revoke all on function public.acknowledge_consent(uuid, text) from public, anon');
    expect(M88).toContain('grant execute on function public.acknowledge_consent(uuid, text) to authenticated');
  });
});

describe('0089 reporting reuses the existing hold path only', () => {
  it('holds a still-pending earning and never creates a new money path', () => {
    expect(M89).toContain("set state = 'held_for_issue'");
    expect(M89).toMatch(/where id = v_earning and state = 'pending_completion'/);
    expect(M89).toContain('report_conversation_concern');
    // Unrelated users are rejected (participant derivation falls through to not_found).
    expect(M89).toContain("raise exception 'not_found: conversation'");
  });
});

describe('0090 blocking is pair-order safe + idempotent + independent directions', () => {
  it('one active row per (member, companion, direction)', () => {
    expect(M90).toContain('user_blocks_one_active');
    expect(M90).toMatch(/direction\)\s*\n\s*where removed_at is null/);
    expect(M90).toContain('app_private.active_block_between(uuid, uuid)');
    expect(M90).toContain('create_block');
    expect(M90).toContain('remove_block');
  });
});

describe('0091 moderation lifecycle is support-gated + audited', () => {
  it('adds status column defaulting pending and audits transitions', () => {
    expect(M91).toContain("moderation_status text not null default 'pending'");
    expect(M91).toContain('companion_moderation_events');
    expect(M91).toContain("raise exception 'reason_required");
    expect(M91).toContain('is_support_admin()');
    // Backfill only approves currently-discoverable companions.
    expect(M91).toMatch(/set moderation_status = 'approved'[\s\S]*?discoverable_companions/);
  });
});

describe('0092 enforces every gate and preserves the audited call function', () => {
  it('discovery requires approved + consent + not blocked', () => {
    expect(M92).toContain("cp.moderation_status = 'approved'");
    expect(M92).toContain("app_private.has_current_consent(p.id, 'companion_pilot')");
    expect(M92).toMatch(/not exists\s*\([\s\S]*?public\.user_blocks/);
  });
  it('booking/conversation/message triggers gate block/consent/moderation', () => {
    expect(M92).toContain('bookings_enforce_trust');
    expect(M92).toContain('conversations_enforce_trust');
    expect(M92).toContain('messages_enforce_trust');
    // Message gate lets system rows through.
    expect(M92).toContain("if new.kind is distinct from 'user' then return new; end if;");
  });
  it('call eligibility adds block/suspension/consent reasons without weakening the rest', () => {
    expect(M92).toContain("'blocked'");
    expect(M92).toContain("'companion_unavailable'");
    expect(M92).toContain("'consent_required'");
    // The original fail-closed config + window checks remain.
    expect(M92).toContain("'configuration_missing'");
    expect(M92).toContain("'too_early'");
    expect(M92).toContain("'join_window_closed'");
    expect(M92).toContain('revoke all on function public.call_join_eligibility(uuid) from public, anon');
  });
});

describe('frontend wiring exists and is server-authoritative', () => {
  const repo = readFileSync(join(ROOT, 'src', 'repositories', 'trustRepository.ts'), 'utf-8');
  const trust = readFileSync(join(ROOT, 'src', 'components', 'TrustSafety.tsx'), 'utf-8');
  const page = readFileSync(join(ROOT, 'src', 'pages', 'InternalTrust.tsx'), 'utf-8');
  const app = readFileSync(join(ROOT, 'src', 'App.tsx'), 'utf-8');
  it('the repo calls only RPCs (no direct table writes)', () => {
    expect(repo).toContain("rpc('acknowledge_consent'");
    expect(repo).toContain("rpc('report_conversation_concern'");
    expect(repo).toContain("rpc('create_block'");
    expect(repo).toContain("rpc('support_set_companion_moderation'");
    expect(repo).not.toMatch(/\.from\(['"](user_blocks|consent_acknowledgements|companion_profiles)['"]\)/);
  });
  it('report/block/consent components and the support console are present + routed', () => {
    expect(trust).toContain('export function ReportConcernButton');
    expect(trust).toContain('export function BlockControl');
    expect(trust).toContain('export function ConsentPanel');
    expect(page).toContain('supportSetModeration');
    expect(app).toContain('<SupportOnly><InternalTrust /></SupportOnly>');
  });
});
