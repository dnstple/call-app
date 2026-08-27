import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const MIG = readFileSync('supabase/migrations/0160_membership_and_credit_ledger.sql', 'utf8');

describe('membership + credit ledger (0160, Phase 2)', () => {
  it('creates memberships with one live membership per member', () => {
    expect(MIG).toContain('create table if not exists public.memberships');
    expect(MIG).toContain('memberships_one_live_per_member');
    expect(MIG).toContain("status in ('pending','starter','active','past_due','paused')");
  });

  it('creates a per-credit ledger with a 3-month expiry', () => {
    expect(MIG).toContain('create table if not exists public.call_credits');
    expect(MIG).toContain("source              text not null check (source in ('starter','weekly','extra','admin'))");
    expect(MIG).toContain("now() + interval '3 months'");
  });

  it('issue/refund/expire are service-role only; balance/consume are user-facing', () => {
    expect(MIG).toContain('grant execute on function public.issue_call_credit(uuid, uuid, text, integer) to service_role');
    expect(MIG).toContain('grant execute on function public.refund_call_credit(uuid) to service_role');
    expect(MIG).toContain('grant execute on function public.expire_call_credits() to service_role');
    expect(MIG).toContain('grant execute on function public.my_call_credits(uuid) to authenticated');
    expect(MIG).toContain('grant execute on function public.consume_call_credit(uuid, uuid) to authenticated');
  });

  it('consume takes the soonest-expiring credit and guards act-for-member', () => {
    expect(MIG).toContain('order by expires_at asc');
    expect(MIG).toContain('for update skip locked');
    expect(MIG).toContain('not_authorised_for_member');
    expect(MIG).toContain("raise exception 'no_credits'");
  });

  it('both tables have RLS and read-own policies', () => {
    expect(MIG).toContain('alter table public.memberships enable row level security');
    expect(MIG).toContain('alter table public.call_credits enable row level security');
    expect(MIG).toContain('"call_credits: read own"');
  });

  it('schedules a daily expiry sweep', () => {
    expect(MIG).toContain("cron.schedule('expire-call-credits'");
    expect(MIG).toContain('public.expire_call_credits()');
  });
});
