import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const MIG = readFileSync('supabase/migrations/0167_credit_slots.sql', 'utf8');
const REPO = readFileSync('src/repositories/bookingRepository.ts', 'utf8');

describe('credit booking wiring (0167, Phase 4)', () => {
  it('generates fixed 45-minute slots without an offer', () => {
    expect(MIG).toContain('function public.get_credit_slots(');
    expect(MIG).toContain('v_duration integer := 45');
    expect(MIG).not.toContain('conversation_offers');
  });

  it('slot + booking collision includes the new statuses', () => {
    expect(MIG).toContain("'requested','confirmed','change_proposed','booked','companion_confirmed','admin_fallback'");
  });

  it('create_credit_booking guards against double-booking a slot', () => {
    expect(MIG).toContain("raise exception 'slot_taken'");
    expect(MIG).toContain('public.consume_call_credit(p_member_profile, v_booking)');
  });

  it('repository exposes credit slots + booking', () => {
    expect(REPO).toContain("rpc('get_credit_slots'");
    expect(REPO).toContain("rpc('create_credit_booking'");
    expect(REPO).toContain('no_credits');
  });
});
