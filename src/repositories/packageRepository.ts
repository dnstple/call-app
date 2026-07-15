/**
 * Package persistence (Supabase mode, Stage 2E3A).
 *
 * Packages = a fixed number of conversations with one Companion.
 * Purchases are SIMULATED — no payment is taken, and the row says so.
 * All writes go through controlled database functions; the browser never
 * supplies buyers, prices, counts or credit totals. Balances are always
 * calculated from the append-only credit ledger, never from client state.
 * No booking integration yet (reserve/consume arrive in Stage 2E3B).
 * Never falls back to mock packages.
 */
import { getSupabaseClient } from '../supabase/client';
import type {
  PackageBalancePayload,
  PackageLedgerRow,
  PackageOfferRow,
  PackagePurchaseResultPayload,
  PackagePurchaseRow,
} from '../supabase/database.types';
import { RepoError, type RepoErrorKind } from './profileRepository';

export type PackageErrorCode =
  | 'unauthorised'
  | 'invalid_offer'
  | 'offer_inactive'
  | 'invalid_price'
  | 'invalid_count'
  | 'member_not_accessible'
  | 'not_found'
  | 'network_failure'
  | 'unknown';

export class PackageError extends RepoError {
  constructor(message: string, kind: RepoErrorKind, public readonly code: PackageErrorCode) {
    super(message, kind);
    this.name = 'PackageError';
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapPackageError(e: any): PackageError {
  const msg = String(e?.message ?? '').toLowerCase();
  if (import.meta.env?.DEV) console.warn('[packages]', e?.code ?? '', e?.message ?? '');
  if (msg.includes('invalid_count')) {
    return new PackageError('A package holds between 2 and 20 conversations.', 'validation', 'invalid_count');
  }
  if (msg.includes('invalid_price')) {
    return new PackageError('The package price must be between £1 and £2,000.', 'validation', 'invalid_price');
  }
  if (msg.includes('offer_inactive')) {
    return new PackageError('This package is no longer available.', 'conflict', 'offer_inactive');
  }
  if (msg.includes('invalid_offer')) {
    return new PackageError('That package isn’t available.', 'validation', 'invalid_offer');
  }
  if (msg.includes('member_not_accessible')) {
    return new PackageError('You don’t have permission to purchase for this member.', 'unauthorised', 'member_not_accessible');
  }
  if (msg.includes('cannot manage offers') || msg.includes('row-level security') || msg.includes('permission denied') || msg.includes('not authenticated')) {
    return new PackageError('You don’t have permission to do that.', 'unauthorised', 'unauthorised');
  }
  if (msg.includes('not found')) {
    return new PackageError('We couldn’t find that package.', 'not_found', 'not_found');
  }
  if (msg.includes('failed to fetch') || msg.includes('network')) {
    return new PackageError('We couldn’t reach the server. Please check your connection.', 'network', 'network_failure');
  }
  return new PackageError('Something went wrong. Please try again.', 'database', 'unknown');
}

/* ---------------- validation (server enforces the same rules) ---------------- */

export const PACKAGE_COUNT_MIN = 2;
export const PACKAGE_COUNT_MAX = 20;
export const PACKAGE_DURATIONS = [15, 30, 45, 60];
export const PACKAGE_PRICE_MIN_MINOR = 100; // £1
export const PACKAGE_PRICE_MAX_MINOR = 200000; // £2,000

export interface PackageOfferInput {
  title?: string;
  conversationCount: number;
  durationMinutes: number;
  priceMinor: number;
  supportedMethods?: string[];
}

export function validatePackageOfferInput(input: PackageOfferInput): PackageError | null {
  if (
    !Number.isInteger(input.conversationCount) ||
    input.conversationCount < PACKAGE_COUNT_MIN ||
    input.conversationCount > PACKAGE_COUNT_MAX
  ) {
    return new PackageError('A package holds between 2 and 20 conversations.', 'validation', 'invalid_count');
  }
  if (!PACKAGE_DURATIONS.includes(input.durationMinutes)) {
    return new PackageError('Please choose 15, 30, 45 or 60 minutes.', 'validation', 'invalid_offer');
  }
  if (
    !Number.isInteger(input.priceMinor) ||
    input.priceMinor < PACKAGE_PRICE_MIN_MINOR ||
    input.priceMinor > PACKAGE_PRICE_MAX_MINOR
  ) {
    return new PackageError('The package price must be between £1 and £2,000.', 'validation', 'invalid_price');
  }
  return null;
}

/* ---------------- credit accounting (pure mirror of the SQL) ---------------- */

export interface PackageBalance {
  purchaseId: string;
  granted: number;
  reserved: number;
  consumed: number;
  remaining: number;
}

/**
 * Balance from ledger entries — identical maths to get_package_balance:
 * grants + releases + adjustments − reserves − consumes.
 */
export function ledgerBalance(
  purchaseId: string,
  entries: Pick<PackageLedgerRow, 'entry_type' | 'quantity'>[],
): PackageBalance {
  let granted = 0;
  let reserved = 0;
  let consumed = 0;
  for (const e of entries) {
    if (e.entry_type === 'grant' || e.entry_type === 'release' || e.entry_type === 'adjustment') granted += e.quantity;
    else if (e.entry_type === 'reserve') reserved += e.quantity;
    else if (e.entry_type === 'consume') consumed += e.quantity;
  }
  return { purchaseId, granted, reserved, consumed, remaining: granted - reserved - consumed };
}

function payloadToBalance(p: PackageBalancePayload): PackageBalance {
  return {
    purchaseId: p.purchase_id,
    granted: Number(p.granted),
    reserved: Number(p.reserved),
    consumed: Number(p.consumed),
    remaining: Number(p.remaining),
  };
}

/* ---------------- offers ---------------- */

export async function getPackageOffers(companionProfileId: string): Promise<PackageOfferRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('package_offers')
    .select('*')
    .eq('companion_profile_id', companionProfileId)
    .order('created_at');
  if (error) throw mapPackageError(error);
  return (data ?? []) as PackageOfferRow[];
}

/** Public read: ACTIVE package offers only (archived stay hidden). */
export async function getPublicPackageOffers(companionProfileId: string): Promise<PackageOfferRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('package_offers')
    .select('*')
    .eq('companion_profile_id', companionProfileId)
    .eq('active', true)
    .order('price_minor');
  if (error) throw mapPackageError(error);
  return (data ?? []) as PackageOfferRow[];
}

export async function createPackageOffer(
  profileId: string,
  input: PackageOfferInput,
): Promise<PackageOfferRow> {
  const invalid = validatePackageOfferInput(input);
  if (invalid) throw invalid;
  const { data, error } = await getSupabaseClient().rpc('create_package_offer', {
    p_profile: profileId,
    p_title: input.title ?? '',
    p_count: input.conversationCount,
    p_duration: input.durationMinutes,
    p_price_minor: input.priceMinor,
    p_methods: input.supportedMethods ?? ['phone'],
  });
  if (error) throw mapPackageError(error);
  return data as PackageOfferRow;
}

export async function updatePackageOffer(
  offerId: string,
  patch: Partial<PackageOfferInput> & { active?: boolean },
): Promise<PackageOfferRow> {
  const { data, error } = await getSupabaseClient().rpc('update_package_offer', {
    p_offer: offerId,
    p_title: patch.title ?? null,
    p_count: patch.conversationCount ?? null,
    p_duration: patch.durationMinutes ?? null,
    p_price_minor: patch.priceMinor ?? null,
    p_methods: patch.supportedMethods ?? null,
    p_active: patch.active ?? null,
  });
  if (error) throw mapPackageError(error);
  return data as PackageOfferRow;
}

/** Offers are archived, never destroyed (purchases hold snapshots). */
export async function archivePackageOffer(offerId: string): Promise<PackageOfferRow> {
  const { data, error } = await getSupabaseClient().rpc('archive_package_offer', {
    p_offer: offerId,
  });
  if (error) throw mapPackageError(error);
  return data as PackageOfferRow;
}

/* ---------------- purchases (SIMULATED — no payment) ---------------- */

export interface SimulatedPurchaseResult {
  purchase: PackagePurchaseRow;
  balance: PackageBalance;
}

/**
 * Create a SIMULATED purchase: the server snapshots the offer, derives the
 * buyer from auth.uid() and grants the initial credits atomically. The
 * browser sends ONLY the member and offer ids — never prices or counts.
 */
export async function createSimulatedPurchase(
  memberProfileId: string,
  offerId: string,
): Promise<SimulatedPurchaseResult> {
  const { data, error } = await getSupabaseClient().rpc('create_simulated_package_purchase', {
    p_member: memberProfileId,
    p_offer: offerId,
  });
  if (error) throw mapPackageError(error);
  const payload = data as PackagePurchaseResultPayload;
  return { purchase: payload.purchase, balance: payloadToBalance(payload.balance) };
}

export async function listPackagePurchases(memberProfileId: string): Promise<PackagePurchaseRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('package_purchases')
    .select('*')
    .eq('member_profile_id', memberProfileId)
    .order('purchased_at', { ascending: false });
  if (error) throw mapPackageError(error);
  return (data ?? []) as PackagePurchaseRow[];
}

/** Balance is ALWAYS calculated server-side from the ledger. */
export async function getPackageBalance(purchaseId: string): Promise<PackageBalance> {
  const { data, error } = await getSupabaseClient().rpc('get_package_balance', {
    p_purchase: purchaseId,
  });
  if (error) throw mapPackageError(error);
  return payloadToBalance(data as PackageBalancePayload);
}
