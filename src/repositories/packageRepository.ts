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
  BookingCreditStatePayload,
  BookingRow,
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
  // Stage 2E3B2A — booking with credits:
  | 'no_credit'
  | 'package_inactive'
  | 'package_mismatch'
  | 'slot_unavailable'
  | 'invalid_method'
  | 'already_released'
  | 'already_consumed'
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
  if (msg.includes('no_credit')) {
    return new PackageError('This package has no conversations left.', 'conflict', 'no_credit');
  }
  if (msg.includes('package_inactive')) {
    return new PackageError('This package can’t be used any more.', 'conflict', 'package_inactive');
  }
  if (msg.includes('package_mismatch')) {
    return new PackageError('That package doesn’t match this conversation.', 'validation', 'package_mismatch');
  }
  if (msg.includes('slot_taken') || msg.includes('outside_availability')) {
    return new PackageError('That time isn’t available any more. Please choose another time.', 'conflict', 'slot_unavailable');
  }
  if (msg.includes('invalid_method')) {
    return new PackageError('That call method isn’t offered with this package.', 'validation', 'invalid_method');
  }
  if (msg.includes('already_released')) {
    return new PackageError('This credit has already been handed back.', 'conflict', 'already_released');
  }
  if (msg.includes('already_consumed')) {
    return new PackageError('This credit has already been used.', 'conflict', 'already_consumed');
  }
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
  if (msg.includes('member_not_accessible') || msg.includes('cannot book for this member')) {
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

/* ============================================================
 * Stage 2E3B2A — booking with package credits (backend only).
 * ============================================================ */

/**
 * Book a conversation USING a package credit. The server derives Member,
 * Companion, duration and price share from the purchase, checks the
 * ledger balance under a row lock (two simultaneous requests can never
 * take the final credit) and reserves 1 credit atomically with the
 * booking. The browser sends ONLY purchase id, start time and method.
 */
export async function createPackageBookingRequest(
  purchaseId: string,
  startsAt: string,
  communicationMethod: string,
): Promise<BookingRow> {
  const { data, error } = await getSupabaseClient().rpc('create_package_booking_request', {
    p_purchase: purchaseId,
    p_starts_at: startsAt,
    p_method: communicationMethod,
  });
  if (error) throw mapPackageError(error);
  return data as BookingRow;
}

export interface AvailablePackagePurchase {
  purchase: PackagePurchaseRow;
  remaining: number;
}

/**
 * Purchases this Member could use for a conversation with this Companion
 * at this duration — active, matching, with at least one credit left.
 * (Display helper: the server re-checks everything at booking time.)
 */
export async function getAvailablePackagePurchases(
  memberProfileId: string,
  companionProfileId: string,
  durationMinutes: number,
): Promise<AvailablePackagePurchase[]> {
  const purchases = await listPackagePurchases(memberProfileId);
  const candidates = purchases.filter(
    (p) =>
      p.status === 'active' &&
      p.companion_profile_id === companionProfileId &&
      p.duration_minutes === durationMinutes,
  );
  const withBalances = await Promise.all(
    candidates.map(async (purchase) => ({
      purchase,
      remaining: (await getPackageBalance(purchase.id).catch(() => null))?.remaining ?? 0,
    })),
  );
  return withBalances.filter((p) => p.remaining >= 1);
}

/** One usable package with its ledger balance and supported methods. */
export interface UsablePackagePurchase {
  purchase: PackagePurchaseRow;
  remaining: number;
  supportedMethods: string[];
}

/**
 * Packages this Member can use with this Companion RIGHT NOW (any
 * duration): active, matching, ≥1 credit. Display helper — the server
 * re-checks everything at booking time.
 */
export async function getUsablePackagePurchases(
  memberProfileId: string,
  companionProfileId: string,
): Promise<UsablePackagePurchase[]> {
  const purchases = await listPackagePurchases(memberProfileId);
  const candidates = purchases.filter(
    (p) => p.status === 'active' && p.companion_profile_id === companionProfileId,
  );
  if (candidates.length === 0) return [];
  const offers = await getPackageOffers(companionProfileId).catch(() => [] as PackageOfferRow[]);
  const results = await Promise.all(
    candidates.map(async (purchase) => ({
      purchase,
      remaining: (await getPackageBalance(purchase.id).catch(() => null))?.remaining ?? 0,
      supportedMethods:
        offers.find((o) => o.id === purchase.package_offer_id)?.supported_methods ?? ['phone'],
    })),
  );
  return results.filter((r) => r.remaining >= 1);
}

/** One purchase row, when readable (buyer / member side only). */
export async function getPackagePurchase(purchaseId: string): Promise<PackagePurchaseRow | null> {
  const { data, error } = await getSupabaseClient()
    .from('package_purchases')
    .select('*')
    .eq('id', purchaseId)
    .maybeSingle();
  if (error) throw mapPackageError(error);
  return (data as PackagePurchaseRow | null) ?? null;
}

/** Real bookable slots for a package (same rules as offer slots). */
export async function getAvailablePackageSlots(
  purchaseId: string,
  from: string,
  to: string,
): Promise<{ startsAt: string; endsAt: string }[]> {
  const { data, error } = await getSupabaseClient().rpc('get_available_package_slots', {
    p_purchase: purchaseId,
    p_from: from,
    p_to: to,
  });
  if (error) throw mapPackageError(error);
  return ((data ?? []) as { slot_start: string; slot_end: string }[]).map((s) => ({
    startsAt: s.slot_start,
    endsAt: s.slot_end,
  }));
}

export interface BookingCreditState {
  bookingId: string;
  bookingSource: 'single_offer' | 'package_credit';
  packagePurchaseId: string | null;
  reserved: boolean;
  released: boolean;
  consumed: boolean;
}

/** Reservation state of one booking's credit (authorised readers only). */
export async function getBookingCreditState(bookingId: string): Promise<BookingCreditState> {
  const { data, error } = await getSupabaseClient().rpc('get_booking_credit_state', {
    p_booking: bookingId,
  });
  if (error) throw mapPackageError(error);
  const p = data as BookingCreditStatePayload;
  return {
    bookingId: p.booking_id,
    bookingSource: p.booking_source,
    packagePurchaseId: p.package_purchase_id,
    reserved: p.reserved,
    released: p.released,
    consumed: p.consumed,
  };
}
