/**
 * Stage 3F-A — message notification contracts (migration 0087).
 * Functional proofs (recipient set, sender exclusion, coalescing, read
 * re-surface, system-message skip) ran on scratch Postgres — see the Stage 3F
 * audit. These pin the migration's structure and safety.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const M87 = readFileSync(join(ROOT, 'supabase', 'migrations', '0087_message_notifications.sql'), 'utf-8');

describe('0087 message notifications', () => {
  it('is additive and touches no financial object', () => {
    expect(M87).not.toMatch(/drop\s+table|drop\s+column|alter\s+column|delete\s+from|truncate/i);
    // No writes to any financial table (prose in comments is fine; statements are not).
    expect(M87).not.toMatch(/(insert into|update|delete from)\s+public\.(payment_orders|companion_earnings|companion_transfer_attempts|bookings|credit_ledger|settlement_adjustments)/i);
  });
  it('fires only for USER messages with a real sender (system rows skipped)', () => {
    expect(M87).toContain("if new.kind = 'user' and new.sender_account_id is not null then");
    expect(M87).toContain('after insert on public.messages');
  });
  it('reuses the exact recipient + permission rules and NEVER notifies the sender', () => {
    expect(M87).toContain("pa.access_role = 'coordinator'");
    expect(M87).toContain('pa.can_message');
    expect(M87).toContain("pa.consent_status <> 'withdrawn'");
    expect(M87).toContain('pa.account_id is distinct from p_sender_account');
  });
  it('coalesces to one unread notification per (recipient, conversation), re-surfaced on new message', () => {
    expect(M87).toContain("'message_received:' || p_conversation::text");
    expect(M87).toMatch(/on conflict \(user_id, dedupe_key\) where dedupe_key is not null\s*\n\s*do update set read = false, read_at = null, created_at = now\(\)/);
  });
  it('stores no message content (privacy-minimal; future channels read this model)', () => {
    expect(M87).toContain("'You have a new message.'");
    expect(M87).not.toMatch(/new\.body/);
  });
  it('the hook functions are service-side only (no client execute)', () => {
    expect(M87).toContain('revoke all on function app_private.notify_new_message(uuid, uuid) from public, anon, authenticated');
    expect(M87).toContain('revoke all on function app_private.on_message_insert_notify() from public, anon, authenticated');
  });
});
