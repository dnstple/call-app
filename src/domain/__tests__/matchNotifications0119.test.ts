/**
 * In-app match notifications (migration 0119) — authority + calm-by-design.
 *
 * Behaviour (creation, per-subject dedupe, per-account cap, in-app only,
 * feature gating, new-subject pickup) is proven against a from-scratch schema in
 * stage validation. These tests lock the source guarantees.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const M = readFileSync(join(ROOT, 'supabase', 'migrations', '0119_match_notifications.sql'), 'utf-8');
const M104 = readFileSync(join(ROOT, 'supabase', 'migrations', '0104_pilot_admin_and_application_rpcs.sql'), 'utf-8');
const NOTIF = readFileSync(join(ROOT, 'src', 'messaging', 'NotificationsSupabase.tsx'), 'utf-8');

describe('0119 match notifications', () => {
  it('reuses the authoritative 0112/0114 eligibility', () => {
    expect(M).toContain('app_private.is_discoverable_companion(c.id)');
    expect(M).toContain('app_private.active_block_between');
    expect(M).toContain('from public.favourites f');   // favouriter-only companion side
    expect(M).toContain('rel.can_book');
  });

  it('dedupes per subject and caps per account so the bell never floods', () => {
    expect(M).toContain('on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing');
    expect(M).toContain("'match_available:' || cand.companion_profile_id::text");
    expect(M).toContain("'companion_intro:' || cand.member_profile_id::text");
    expect(M).toMatch(/exit when v_inserted >= v_cap/);
  });

  it('is service-role only and feature-gated', () => {
    expect(M).toContain('revoke all on function public.run_match_notifications(integer, integer) from public, anon, authenticated');
    expect(M).toContain('grant execute on function public.run_match_notifications(integer, integer) to service_role');
    expect(M).toContain("app_private.account_has_feature(r.account_id, 'explore')");
    expect(M).toContain("app_private.account_has_feature(r.account_id, 'message_requests')");
  });

  it('is IN-APP ONLY — the types map to no email category (no per-event email)', () => {
    // If 0104's category map mentioned these types they would be emailed per event.
    expect(M104).not.toContain('match_available');
    expect(M104).not.toContain('companion_introduction_suggested');
  });

  it('uses restrained copy', () => {
    for (const banned of [/perfect match/i, /guaranteed/i, /\bAI\b/, /soulmate/i, /best person/i, /act now/i]) {
      expect(M).not.toMatch(banned);
    }
  });
});

describe('client routes match notifications home', () => {
  it('opens the home page for match / introduction notifications', () => {
    expect(NOTIF).toContain("n.kind === 'match_available' || n.kind === 'companion_introduction_suggested'");
    expect(NOTIF).toMatch(/companion_introduction_suggested'\) navigate\('\/'\)/);
  });
});
