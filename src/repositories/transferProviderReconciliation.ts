/**
 * Stage 3C2-C1 — READ-ONLY provider transfer reconciliation interface (contract
 * only; NO live implementation in C1, NO Stripe call anywhere in this stage).
 *
 * Purpose: before Stage 3C2-C2 may create ANY provider transfer for an attempt in
 * `processing` with a NULL local stripe_transfer_id (or retry a retryable
 * failure), it MUST first establish provider truth. A NULL local provider id
 * NEVER proves provider absence — the audited crash window is: provider POST
 * succeeded → local finalize failed/crashed → attempt stuck `processing` with no
 * id (recoverable today only via the transfer.* webhook's metadata match).
 *
 * AUDITED LOOKUP IDENTIFIERS (source inspection, no provider call):
 *  - Stripe does NOT support querying by idempotency key. The stable key
 *    ('transfer-<earning>') protects a RE-POST (Stripe dedupes), but cannot be
 *    used as a search key.
 *  - The existing Edge Function sets transfer metadata:
 *      earning_id, booking_id, companion_account_id, companion_profile_id,
 *      transfer_attempt_id
 *    so C2's lookup is: list provider transfers for the destination account in a
 *    bounded created-time window and match metadata.transfer_attempt_id (primary)
 *    or metadata.earning_id (secondary), then verify amount/currency/destination.
 *  - The webhook (transfer.created/updated/reversed) already attaches missing
 *    local ids via the same metadata; the lookup is the synchronous complement
 *    for missed/misordered events.
 *
 * SAFETY CONTRACT: a `provider_transfer_not_found` result is NEVER a durable
 * permission to create a transfer. C2 must perform a FRESH lookup immediately
 * before creation, inside the same guarded execution, or rely on the stable
 * idempotency key as the final dedupe.
 */

export type ProviderLookupClassification =
  | 'provider_transfer_found_matching'   // exists and matches amount/currency/destination
  | 'provider_transfer_not_found'        // no candidate in the searched window — NOT durable
  | 'provider_transfer_found_mismatch'   // exists but amount/currency/destination differ — STOP, support review
  | 'provider_lookup_ambiguous'          // multiple candidates — STOP, support review
  | 'provider_lookup_failed';            // lookup errored — treat as unknown, never as absence

export interface TransferProviderLookupRequest {
  attemptId: string;                     // companion_transfer_attempts.id (metadata.transfer_attempt_id)
  earningId: string;                     // expected metadata.earning_id
  idempotencyKey: string;                // 'transfer-<earning>' (dedupe only; not searchable)
  expectedAmountMinor: number;
  expectedCurrency: string;              // 'GBP'
  expectedDestination: string;           // connected account id (server-side only; never rendered)
}

export interface TransferProviderLookupResult {
  classification: ProviderLookupClassification;
  /** Present only for found_matching / found_mismatch. */
  providerTransferId?: string | null;
  observedAmountMinor?: number | null;
  observedCurrency?: string | null;
  destinationMatches?: boolean | null;
  checkedAt: string;                     // ISO timestamp of the lookup
}

/** C2 will implement this against a guarded server/Edge endpoint. C1 ships the
 * contract + a deterministic stub for tests only. */
export interface TransferProviderLookup {
  lookup(req: TransferProviderLookupRequest): Promise<TransferProviderLookupResult>;
}

/** Test-only fake: deterministic, never performs I/O, never contacts a provider. */
export class StubTransferProviderLookup implements TransferProviderLookup {
  constructor(private readonly fixtures: Record<string, TransferProviderLookupResult> = {}) {}
  async lookup(req: TransferProviderLookupRequest): Promise<TransferProviderLookupResult> {
    return this.fixtures[req.attemptId]
      ?? { classification: 'provider_lookup_failed', checkedAt: new Date(0).toISOString() };
  }
}
