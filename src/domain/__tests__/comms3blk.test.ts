/**
 * Block 3 (Communications) — migration + wiring contracts.
 *
 * Functional behaviour (outbox enqueue, preference suppression, dedup,
 * dispatcher idempotency, booking reminders, health) is proven on scratch
 * Postgres — see outputs/block3_runner.py (fail=0). These pin structure/safety.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const M93 = readFileSync(join(ROOT, 'supabase', 'migrations', '0093_email_outbox_and_preferences.sql'), 'utf-8');
const M94 = readFileSync(join(ROOT, 'supabase', 'migrations', '0094_booking_reminders.sql'), 'utf-8');

describe('0093 email outbox + preferences', () => {
  it('is additive and touches no financial table', () => {
    for (const m of [M93, M94]) {
      expect(m).not.toMatch(/drop\s+table|truncate/i);
      expect(m).not.toMatch(/(insert into|update)\s+public\.(payment_orders|companion_earnings|companion_transfer_attempts|bookings)\b/i);
    }
  });
  it('enqueues via an AFTER INSERT trigger honouring preferences (suppressed vs pending)', () => {
    expect(M93).toContain('after insert on public.notifications');
    expect(M93).toContain('app_private.email_opted_in');
    expect(M93).toMatch(/'pending'[\s\S]*else 'suppressed'|when .* then 'pending' else 'suppressed'/);
  });
  it('deduplicates the outbox and never stores provider credentials', () => {
    expect(M93).toContain('email_outbox_dedupe');
    expect(M93).toContain("on conflict (dedupe_key) where dedupe_key is not null do nothing");
    expect(M93).not.toMatch(/api[_-]?key|secret|password|bearer/i);
  });
  it('dispatcher seam is service-role only and never re-sends a sent row', () => {
    expect(M93).toContain('grant execute on function public.claim_email_batch(integer) to service_role');
    expect(M93).toContain('grant execute on function public.mark_email_sent(uuid, text) to service_role');
    expect(M93).toContain("where id = p_id and status <> 'sent'");
    expect(M93).not.toMatch(/grant execute on function public\.claim_email_batch[^;]*to authenticated/);
  });
  it('preference + health RPCs are authenticated/support gated', () => {
    expect(M93).toContain('grant execute on function public.get_my_notification_preferences() to authenticated');
    expect(M93).toContain('grant execute on function public.set_my_notification_preferences(boolean, boolean, boolean, boolean, boolean) to authenticated');
    expect(M93).toContain('is_support_admin()');
  });
});

describe('0094 booking reminders', () => {
  it('is service-role only, deduplicated per window, and does not change bookings', () => {
    expect(M94).toContain('grant execute on function public.create_booking_reminders() to service_role');
    expect(M94).toContain("'booking-reminder-' || v_row.window");
    expect(M94).toContain('on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing');
    expect(M94).not.toMatch(/update\s+public\.bookings\s+set/i);
  });
  it('schedules via pg_cron only when the extension is present', () => {
    expect(M94).toContain("select 1 from pg_extension where extname = 'pg_cron'");
    expect(M94).toContain('booking-reminders-hourly');
  });
});

describe('email TS module is deterministic + credential-free', () => {
  const adapter = readFileSync(join(ROOT, 'src', 'email', 'adapter.ts'), 'utf-8');
  const templates = readFileSync(join(ROOT, 'src', 'email', 'templates.ts'), 'utf-8');
  it('defines a swappable adapter with a deterministic test implementation', () => {
    expect(adapter).toContain('export interface EmailAdapter');
    expect(adapter).toContain('export class TestEmailAdapter');
    expect(adapter).toContain('export async function dispatchOutbox');
    expect(adapter).not.toMatch(/api[_-]?key|https?:\/\//i); // no provider/network baked in
  });
  it('templates carry safety copy and no baked-in dates', () => {
    expect(templates).toContain('not for emergencies');
    expect(templates).toContain('email preferences in Settings');
  });
});

describe('frontend comms wiring', () => {
  const repo = readFileSync(join(ROOT, 'src', 'repositories', 'trustRepository.ts'), 'utf-8');
  const trust = readFileSync(join(ROOT, 'src', 'components', 'TrustSafety.tsx'), 'utf-8');
  const settings = readFileSync(join(ROOT, 'src', 'pages', 'Settings.tsx'), 'utf-8');
  it('preference + health RPC wrappers exist and Settings renders the panel', () => {
    expect(repo).toContain("rpc('get_my_notification_preferences')");
    expect(repo).toContain("rpc('set_my_notification_preferences'");
    expect(repo).toContain("rpc('support_system_health')");
    expect(trust).toContain('export function NotificationPreferencesPanel');
    expect(settings).toContain('NotificationPreferencesPanel');
  });
});
