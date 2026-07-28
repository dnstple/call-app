/**
 * Block 11 — Companion → favouriter introductions (migration 0100 contract).
 * Behaviour is proven against a real Postgres separately; these assert the
 * migration's safety shape and additivity.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const M = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0100_companion_interest_introductions.sql'),
  'utf-8',
);

describe('migration 0100 — companion introductions', () => {
  it('exposes only safe display fields for favouriters (no PII)', () => {
    const fn = M.slice(M.indexOf('function public.companion_favouriters'), M.indexOf('function public.companion_introduce'));
    expect(fn).toMatch(/member_first_name/);
    expect(fn).toMatch(/member_region/);
    expect(fn).not.toMatch(/email|phone|date_of_birth|dob/i);
    // Coordinator-on-behalf is resolved to the managed Member.
    expect(fn).toMatch(/via_coordinator/);
    expect(fn).toMatch(/not app_private\.active_block_between/);
  });

  it('introductions are favourite-gated, discoverable-gated, one-pending and rate-limited', () => {
    const fn = M.slice(M.indexOf('function public.companion_introduce'), M.indexOf('function public.respond_to_introduction'));
    expect(fn).toMatch(/not_eligible: this person has not expressed interest/);
    expect(fn).toMatch(/is_discoverable_companion/);
    expect(fn).toMatch(/already_sent/);
    expect(fn).toMatch(/request_declined/);
    expect(fn).toMatch(/rate_limited/);
    // One introductory message, server-controlled.
    expect(fn).toMatch(/insert into public\.messages/);
    // No booking, no payment.
    expect(fn).not.toMatch(/payment|order|charge|bookings/i);
  });

  it('the reverse responder only answers companion-initiated requests, member-side only', () => {
    const fn = M.slice(M.indexOf('function public.respond_to_introduction'));
    expect(fn).toMatch(/v_companion_initiated/);
    expect(fn).toMatch(/not_eligible: this introduction is not yours to answer/);
    // Caller must be the member side (owner or can_message coordinator).
    expect(fn).toMatch(/access_role = 'owner' or \(pa\.access_role = 'coordinator' and pa\.can_message\)/);
  });

  it('is additive and reloads PostgREST', () => {
    expect(M).not.toMatch(/drop table|drop column|delete from|truncate|alter table .* drop/i);
    expect(M).toMatch(/pg_notify\('pgrst', 'reload schema'\)/);
  });
});
