/**
 * Deterministic safety rules applied AFTER the model's classification. The model
 * proposes; these rules decide whether a deletion can be proposed at all. Pure,
 * so they are unit-tested (src/domain/__tests__/triageRules.test.ts).
 */

export const CATEGORIES = [
  'delete_account', 'refund_billing', 'technical', 'companion_query', 'general', 'spam', 'needs_human',
] as const;
export type Category = typeof CATEGORIES[number];

export interface Signals {
  account_exists?: boolean;
  already_erased?: boolean;
  roles?: string[];
  managed_profiles?: string[];
  open_disputes?: number;
  payments_30d?: number;
  pending_refunds?: number;
  active_membership?: number;
  unused_credits?: number;
  upcoming_bookings?: number;
  unpaid_earnings?: number;
}

export interface Context {
  account_id: string | null;
  account_match: 'from_account_id' | 'email' | 'none';
  email_matches_account: boolean | null;
  signals: Signals;
}

export interface ModelVerdict {
  category: Category;
  confidence: number;
  deletion_requested: boolean;
  ambiguous: boolean;
}

export interface Decision {
  category: Category;
  status: 'proposed' | 'skipped';
  override_reasons: string[];
  resolution: string | null;
}

export const DELETE_MIN_CONFIDENCE = 0.85;
export const GENERAL_MIN_CONFIDENCE = 0.6;

/** Why a deletion must go to a human instead. Empty array = safe to propose. */
export function deletionBlockers(ctx: Context, v: ModelVerdict): string[] {
  const s = ctx.signals ?? {};
  const r: string[] = [];
  if (v.confidence < DELETE_MIN_CONFIDENCE) r.push(`low_confidence(${v.confidence.toFixed(2)})`);
  if (v.ambiguous) r.push('ambiguous_message');
  if (!v.deletion_requested) r.push('model_did_not_confirm_explicit_request');
  if (!ctx.account_id) r.push('no_matching_account');
  if (ctx.account_id && s.account_exists === false) r.push('account_row_missing');
  if (ctx.account_match === 'from_account_id' && ctx.email_matches_account === false) r.push('email_differs_from_account');
  if ((s.managed_profiles?.length ?? 0) > 0) r.push('coordinator_with_managed_members');
  if ((s.open_disputes ?? 0) > 0) r.push('open_dispute');
  if ((s.pending_refunds ?? 0) > 0) r.push('pending_refund');
  if ((s.payments_30d ?? 0) > 0) r.push('payment_in_last_30_days');
  if ((s.upcoming_bookings ?? 0) > 0) r.push('upcoming_booking');
  if ((s.unpaid_earnings ?? 0) > 0) r.push('unpaid_companion_earnings');
  if ((s.active_membership ?? 0) > 0 && (s.unused_credits ?? 0) > 0) r.push('active_membership_with_unused_credits');
  return r;
}

export function decide(ctx: Context, v: ModelVerdict): Decision {
  if (v.category === 'delete_account' || v.deletion_requested) {
    if (ctx.signals?.already_erased) {
      return { category: 'delete_account', status: 'skipped', override_reasons: [], resolution: 'already erased' };
    }
    const blockers = deletionBlockers(ctx, v);
    if (blockers.length) return { category: 'needs_human', status: 'proposed', override_reasons: blockers, resolution: null };
    return { category: 'delete_account', status: 'proposed', override_reasons: [], resolution: null };
  }
  if (v.confidence < GENERAL_MIN_CONFIDENCE && v.category !== 'needs_human') {
    return { category: 'needs_human', status: 'proposed', override_reasons: [`low_confidence(${v.confidence.toFixed(2)})`], resolution: null };
  }
  return { category: v.category, status: 'proposed', override_reasons: [], resolution: null };
}
