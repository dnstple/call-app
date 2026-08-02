/**
 * Review confirms the conversation (migration 0120 + ReviewCard).
 *
 * Runtime behaviour (member-authoritative completion, idempotency, gating) is
 * proven on a from-scratch schema in stage validation. These lock the source
 * guarantees: it's additive (two-party completion untouched), reuses the
 * completion side-effects, and the card offers a hold path.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const M = readFileSync(join(ROOT, 'supabase', 'migrations', '0120_review_confirms_conversation.sql'), 'utf-8');
const CARD = readFileSync(join(ROOT, 'src', 'components', 'ReviewCard.tsx'), 'utf-8');

describe('0120 member-authoritative completion', () => {
  it('is additive — it does not redefine the two-party completion RPC', () => {
    expect(M).not.toMatch(/create or replace function public\.submit_completion_confirmation/);
    expect(M).not.toContain('submit_completion_confirmation__impl');
    expect(M).toContain('create or replace function public.confirm_conversation_for_review');
  });
  it('is member/coordinator gated and idempotent, and only finalises finished, confirmed bookings', () => {
    expect(M).toContain('app_private.can_act_for_member(v.member_profile_id)');
    expect(M).toMatch(/v\.status = 'completed'[\s\S]*get_completion_state/); // idempotent
    expect(M).toContain("v.status <> 'confirmed'");
    expect(M).toContain('v.ends_at > now()');
  });
  it('reuses the SAME finalisation side-effects as a two-party completion', () => {
    expect(M).toContain("update public.bookings set status = 'completed'");
    expect(M).toContain("app_private.record_transition(p_booking, v.status, 'completed'");
    expect(M).toContain("app_private.settle_package_credit(p_booking, 'consume')");
  });
  it('is authenticated-only', () => {
    expect(M).toContain('revoke all on function public.confirm_conversation_for_review(uuid) from public, anon');
    expect(M).toContain('grant execute on function public.confirm_conversation_for_review(uuid) to authenticated');
  });
});

describe('ReviewCard confirm + report', () => {
  it('confirms the conversation before writing the review', () => {
    expect(CARD).toContain('await confirmConversationForReview(bookingId)');
    expect(CARD.indexOf('confirmConversationForReview')).toBeLessThan(CARD.indexOf("rpc('submit_conversation_review'"));
  });
  it('offers a hold path — Report a problem uses the report_concern outcome', () => {
    expect(CARD).toContain('Report a problem');
    expect(CARD).toContain("submitCompletionOutcome(bookingId, 'report_concern'");
  });
});
