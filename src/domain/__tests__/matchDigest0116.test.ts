/**
 * Match/introduction digest (migrations 0116 + 0117) — authority + copy contract.
 *
 * Runtime behaviour (enqueue, opt-out suppression, quiet-hours deferral,
 * frequency cap, dedupe, favouriter-only pool) is proven against the migration
 * chain in stage validation. These tests lock the durable guarantees the source
 * must keep: the quiet, opt-in, non-salesy design and its authorisation.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isKnownTemplate } from '../../email/templates';

const ROOT = join(__dirname, '..', '..', '..');
const M116 = readFileSync(join(ROOT, 'supabase', 'migrations', '0116_match_digest_preferences.sql'), 'utf-8');
const M117 = readFileSync(join(ROOT, 'supabase', 'migrations', '0117_match_digest_assembler.sql'), 'utf-8');
const TEMPLATES = readFileSync(join(ROOT, 'src', 'email', 'templates.ts'), 'utf-8');

describe('0116 preferences + quiet hours', () => {
  it('adds an opt-in digest flag and quiet-hours columns without breaking the 5-boolean setter', () => {
    expect(M116).toContain('add column if not exists email_matches boolean not null default true');
    expect(M116).toContain('add column if not exists quiet_hours_start smallint');
    expect(M116).toContain('add column if not exists quiet_hours_end   smallint');
    expect(M116).toContain('add column if not exists time_zone text not null default');
    // The existing set_my_notification_preferences signature must be untouched.
    expect(M116).not.toMatch(/create or replace function public\.set_my_notification_preferences/);
  });

  it('allows the new "matches" email category and honours the opt-in', () => {
    expect(M116).toMatch(/category in \('messages', 'bookings', 'billing', 'safety', 'system', 'matches'\)/);
    expect(M116).toContain("when 'matches' then p.email_matches");
  });

  it('evaluates quiet hours in the account time zone, including windows that cross midnight', () => {
    expect(M116).toContain('p_at at time zone');
    expect(M116).toMatch(/v_hr >= v\.quiet_hours_start or v_hr < v\.quiet_hours_end/); // crosses midnight
    // An unknown stored time zone must never withhold delivery.
    expect(M116).toMatch(/exception when others then\s*\n\s*return false/);
  });

  it('exposes the new fields to the client via additive read + a separate setter', () => {
    expect(M116).toContain("'email_matches',  coalesce(v.email_matches, true)");
    expect(M116).toContain('create or replace function public.set_my_communication_preferences');
    expect(M116).toContain('grant execute on function public.set_my_communication_preferences(boolean, smallint, smallint, text) to authenticated');
  });
});

describe('0117 digest assembler', () => {
  it('reuses the authoritative 0112/0114 eligibility (interest overlap, blocks, favouriter-only pool)', () => {
    expect(M117).toContain('app_private.is_discoverable_companion(c.id)');
    expect(M117).toContain('app_private.active_block_between');
    // Companion side counts favouriters only — never an open member directory.
    expect(M117).toContain('from public.favourites f');
    expect(M117).toContain('rel.can_book');
  });

  it('is service-role only and never client-callable', () => {
    expect(M117).toContain('revoke all on function public.run_match_digests(integer, integer, timestamptz) from public, anon, authenticated');
    expect(M117).toContain('grant execute on function public.run_match_digests(integer, integer, timestamptz) to service_role');
  });

  it('caps frequency, dedupes per ISO week, and defers (not drops) inside quiet hours', () => {
    expect(M117).toContain('from public.match_digest_log l');            // frequency cap source
    expect(M117).toContain('make_interval(days => greatest(1, coalesce(p_min_interval_days, 7)))');
    expect(M117).toMatch(/to_char\(p_now, 'IYYY-IW'\)/);                 // one per account per ISO week
    expect(M117).toContain('on conflict (dedupe_key) where dedupe_key is not null do nothing');
    expect(M117).toContain('app_private.within_quiet_hours(r.account_id, p_now)');
  });

  it('honours opt-out as an auditable suppressed row, and never nudges with nothing to say', () => {
    expect(M117).toContain("v_status := case when v_optin then 'pending' else 'suppressed' end");
    expect(M117).toMatch(/if \(coalesce\(v_member, 0\) \+ coalesce\(v_companion, 0\)\) = 0 then\s*\n\s*continue/);
  });

  it('uses restrained, non-salesy digest copy', () => {
    const body = M117; // the copy lives in the case expression
    for (const banned of [/perfect match/i, /guaranteed/i, /\bAI\b/, /soulmate/i, /best person/i, /compatib/i, /act now/i, /don.t miss/i]) {
      // only check the surfaced strings, which all contain "interests" or "introduction"
      expect(body).not.toMatch(banned);
    }
    expect(M117).toContain('there is never any obligation');
  });
});

describe('digest email rendering', () => {
  it('recognises the assembled digest template key and per-notification keys', () => {
    expect(isKnownTemplate('digest:matches')).toBe(true);
    expect(isKnownTemplate('notification:message_received')).toBe(true);
    expect(isKnownTemplate('unknown:thing')).toBe(false);
  });

  it('has a dedicated, preference-pointing footer for the matches category', () => {
    expect(TEMPLATES).toMatch(/matches:\s*'[^']*turn (them|it) off[^']*Settings/i);
  });
});
