import { describe, it, expect } from 'vitest';
import { decide, deletionBlockers, type Context, type ModelVerdict } from '../../../scripts/automation/triageRules.ts';
import { planRun, effectiveCapacity, HARD_DAILY_MAX, type OutreachRow } from '../../../supabase/functions/_shared/charity/plan.ts';

const clean: Context = {
  account_id: 'acc-1', account_match: 'from_account_id', email_matches_account: true,
  signals: { account_exists: true, already_erased: false, managed_profiles: [], open_disputes: 0, payments_30d: 0,
    pending_refunds: 0, active_membership: 0, unused_credits: 0, upcoming_bookings: 0, unpaid_earnings: 0 },
};
const del: ModelVerdict = { category: 'delete_account', confidence: 0.95, deletion_requested: true, ambiguous: false };

describe('deletion safety rules', () => {
  it('proposes a clean, explicit request', () => {
    expect(decide(clean, del)).toEqual({ category: 'delete_account', status: 'proposed', override_reasons: [], resolution: null });
  });

  it.each([
    ['low confidence', clean, { ...del, confidence: 0.7 }, 'low_confidence(0.70)'],
    ['ambiguous', clean, { ...del, ambiguous: true }, 'ambiguous_message'],
    ['not explicit', clean, { ...del, deletion_requested: false }, 'model_did_not_confirm_explicit_request'],
    ['no account', { ...clean, account_id: null, account_match: 'none' as const }, del, 'no_matching_account'],
    ['email mismatch', { ...clean, email_matches_account: false }, del, 'email_differs_from_account'],
    ['coordinator', { ...clean, signals: { ...clean.signals, managed_profiles: ['p2'] } }, del, 'coordinator_with_managed_members'],
    ['dispute', { ...clean, signals: { ...clean.signals, open_disputes: 1 } }, del, 'open_dispute'],
    ['recent payment', { ...clean, signals: { ...clean.signals, payments_30d: 1 } }, del, 'payment_in_last_30_days'],
    ['refund', { ...clean, signals: { ...clean.signals, pending_refunds: 1 } }, del, 'pending_refund'],
    ['booking', { ...clean, signals: { ...clean.signals, upcoming_bookings: 2 } }, del, 'upcoming_booking'],
    ['earnings', { ...clean, signals: { ...clean.signals, unpaid_earnings: 1 } }, del, 'unpaid_companion_earnings'],
    ['credits', { ...clean, signals: { ...clean.signals, active_membership: 1, unused_credits: 3 } }, del, 'active_membership_with_unused_credits'],
  ])('routes to needs_human: %s', (_n, ctx, v, reason) => {
    const d = decide(ctx as Context, v as ModelVerdict);
    expect(d.category).toBe('needs_human');
    expect(d.override_reasons).toContain(reason);
  });

  it('treats a deletion hidden in another category as a deletion', () => {
    const d = decide({ ...clean, signals: { ...clean.signals, open_disputes: 1 } }, { ...del, category: 'refund_billing' });
    expect(d.category).toBe('needs_human');
  });

  it('skips already-erased accounts', () => {
    const d = decide({ ...clean, signals: { ...clean.signals, already_erased: true } }, del);
    expect(d).toMatchObject({ category: 'delete_account', status: 'skipped', resolution: 'already erased' });
  });

  it('active membership with no credits left is not a blocker', () => {
    expect(deletionBlockers({ ...clean, signals: { ...clean.signals, active_membership: 1, unused_credits: 0 } }, del)).toEqual([]);
  });

  it('low-confidence non-deletions go to a human', () => {
    expect(decide(clean, { category: 'general', confidence: 0.4, deletion_requested: false, ambiguous: false }).category).toBe('needs_human');
    expect(decide(clean, { category: 'spam', confidence: 0.9, deletion_requested: false, ambiguous: false }).category).toBe('spam');
  });
});

const ch = { name: 'C', contact_name: null, contact_email: 'c@x.org', is_test: true };
const row = (o: Partial<OutreachRow>): OutreachRow => ({
  id: Math.random().toString(36), charity_id: 'c', status: 'queued', message_variant: 'initial_a', queued_at: '2026-11-01T09:00:00Z',
  first_sent_at: null, fu1_sent_at: null, fu2_sent_at: null, graph_message_id: 'g', charity: ch, ...o,
});

describe('outreach planning and caps', () => {
  const now = new Date('2026-11-24T10:00:00Z'); // Tuesday

  it('never exceeds 30 a day whatever the config says', () => {
    expect(effectiveCapacity(25, 0)).toBe(25);
    expect(effectiveCapacity(500, 0)).toBe(HARD_DAILY_MAX);
    expect(effectiveCapacity(25, 20)).toBe(5);
    expect(effectiveCapacity(25, 40)).toBe(0);
    expect(effectiveCapacity(25, 0, 3)).toBe(3);
  });

  it('caps the plan and defers the rest', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row({ queued_at: `2026-11-${String(1 + (i % 20)).padStart(2, '0')}T00:00:00Z` }));
    const p = planRun(rows, now, 25);
    expect(p.sends.length).toBe(25);
    expect(p.deferred).toBe(15);
  });

  it('schedules follow-ups: FU1 after 4 working days, FU2 after 10 days, close 7 days after FU2', () => {
    const fu1Due = row({ status: 'sent', first_sent_at: '2026-11-18T10:00:00Z' });      // Wed → Tue = 4 working days
    const fu1NotDue = row({ status: 'sent', first_sent_at: '2026-11-20T10:00:00Z' });   // Fri → Tue = 2
    const fu2Due = row({ status: 'followed_up_1', first_sent_at: '2026-11-13T10:00:00Z', fu1_sent_at: '2026-11-19T10:00:00Z' });
    const fu2TooSoonAfterFu1 = row({ status: 'followed_up_1', first_sent_at: '2026-11-10T10:00:00Z', fu1_sent_at: '2026-11-23T10:00:00Z' });
    const close = row({ status: 'followed_up_2', fu2_sent_at: '2026-11-16T10:00:00Z' });
    const p = planRun([fu1Due, fu1NotDue, fu2Due, fu2TooSoonAfterFu1, close], now, 30);
    expect(p.sends.map((s) => [s.row.id, s.step])).toEqual([[fu2Due.id, 'fu2'], [fu1Due.id, 'fu1']]);
    expect(p.close.map((r) => r.id)).toEqual([close.id]);
  });

  it('never re-sends to replied, bounced or unsubscribed threads', () => {
    const p = planRun(['replied', 'bounced', 'unsubscribed', 'do_not_contact'].map((s) => row({ status: s, first_sent_at: '2026-10-01T00:00:00Z' })), now, 30);
    expect(p.sends).toEqual([]);
  });
});
