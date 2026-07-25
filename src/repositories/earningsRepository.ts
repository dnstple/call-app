/**
 * Stage 3E-C — Companion earnings read repository (safe projections only).
 *
 * Backed by the 0085 owner-scoped SECURITY DEFINER readers. Everything here
 * is read-only: no earning, transfer or payout state can be mutated from the
 * browser anywhere in the app. Buckets are computed server-side by the single
 * authority (app_private.companion_earning_bucket); this module only maps
 * rows and never re-derives financial state.
 */
import { getSupabaseClient } from '../supabase/client';
import { isSupabaseMode } from '../config/dataMode';

export type EarningBucket =
  | 'pending'
  | 'on_hold'
  | 'available'
  | 'processing'
  | 'transferred'
  | 'action_required'
  | 'reversed';

export interface EarningsSummary {
  /** Minor units per bucket; missing buckets are zero. */
  totalsMinor: Record<EarningBucket, number>;
  countsByBucket: Record<EarningBucket, number>;
}

export interface CompanionEarningRow {
  earningId: string;
  bucket: EarningBucket;
  state: string;
  transferState: string;
  bookingStartsAt: string | null;
  memberFirstName: string;
  isTrial: boolean;
  basisMinor: number;
  commissionRatePct: number;
  commissionMinor: number;
  netMinor: number;
  currency: string;
  payableAt: string | null;
  createdAt: string;
}

const BUCKETS: EarningBucket[] = [
  'pending', 'on_hold', 'available', 'processing', 'transferred', 'action_required', 'reversed',
];

type UntypedRpc = { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> };

function emptySummary(): EarningsSummary {
  const zero = () => Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<EarningBucket, number>;
  return { totalsMinor: zero(), countsByBucket: zero() };
}

export async function getMyEarningsSummary(): Promise<EarningsSummary> {
  if (!isSupabaseMode()) return emptySummary();
  const { data, error } = await (getSupabaseClient() as unknown as UntypedRpc)
    .rpc('get_my_companion_earnings_summary');
  const summary = emptySummary();
  if (error || !Array.isArray(data)) return summary;
  for (const raw of data as Array<Record<string, unknown>>) {
    const bucket = raw.bucket as EarningBucket;
    if (!BUCKETS.includes(bucket)) continue;
    summary.totalsMinor[bucket] = Number(raw.net_minor ?? 0);
    summary.countsByBucket[bucket] = Number(raw.earnings_count ?? 0);
  }
  return summary;
}

export async function listMyEarnings(limit = 50): Promise<CompanionEarningRow[]> {
  if (!isSupabaseMode()) return [];
  const { data, error } = await (getSupabaseClient() as unknown as UntypedRpc)
    .rpc('list_my_companion_earnings', { p_limit: limit });
  if (error || !Array.isArray(data)) return [];
  return (data as Array<Record<string, unknown>>).map((r) => ({
    earningId: String(r.earning_id),
    bucket: (BUCKETS.includes(r.bucket as EarningBucket) ? r.bucket : 'pending') as EarningBucket,
    state: String(r.state ?? ''),
    transferState: String(r.transfer_state ?? ''),
    bookingStartsAt: (r.booking_starts_at as string | null) ?? null,
    memberFirstName: String(r.member_first_name ?? ''),
    isTrial: Boolean(r.is_trial),
    basisMinor: Number(r.basis_minor ?? 0),
    commissionRatePct: Number(r.commission_rate_pct ?? 0),
    commissionMinor: Number(r.commission_minor ?? 0),
    netMinor: Number(r.net_minor ?? 0),
    currency: String(r.currency ?? 'GBP'),
    payableAt: (r.payable_at as string | null) ?? null,
    createdAt: String(r.created_at ?? ''),
  }));
}

/** Neutral customer-facing wording for each bucket (single copy authority). */
export const EARNING_BUCKET_COPY: Record<EarningBucket, { label: string; hint: string }> = {
  pending: { label: 'Pending', hint: 'Waiting for the conversation to be confirmed as completed.' },
  on_hold: { label: 'On hold', hint: 'Held while a conversation query is looked into. No action needed from you yet.' },
  available: { label: 'Available', hint: 'Confirmed and queued for your next payout.' },
  processing: { label: 'Processing', hint: 'Being sent to your payout account.' },
  transferred: { label: 'Paid', hint: 'Sent to your payout account.' },
  action_required: { label: 'Needs attention', hint: 'Our team is looking into this payout. You will be contacted if anything is needed.' },
  reversed: { label: 'Reversed', hint: 'This earning was reversed following a resolution.' },
};
