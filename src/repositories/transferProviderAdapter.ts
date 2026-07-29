/**
 * Stage 3C2-C2 — provider adapter contract + EXACT matching rules + fake
 * provider. No file here performs network I/O; the live Stripe adapter lives
 * only inside the (undeployed) scoped-stripe-transfers Edge Function and is
 * injected, never imported by app code. Tests run entirely offline.
 */

export interface ProviderTransfer {
  id: string;
  amount: number;                   // minor units
  currency: string;                 // lowercase, e.g. 'gbp'
  destination: string;              // connected account id
  livemode: boolean;
  created: number;                  // epoch seconds
  metadata: Record<string, string>;
}

export interface ProviderTransferPage {
  data: ProviderTransfer[];
  hasMore: boolean;
}

export interface ExactTransferRequest {
  amountMinor: number;
  currency: string;                 // 'gbp'
  destination: string;
  metadata: Record<string, string>;
}

export interface TransferProvider {
  retrieveTransfer(id: string): Promise<ProviderTransfer>;
  listTransfers(query: {
    destination: string;
    createdGte: number;
    createdLte: number;
    startingAfter?: string;
    limit: number;
  }): Promise<ProviderTransferPage>;
  createTransfer(
    request: ExactTransferRequest,
    options: { idempotencyKey: string },
  ): Promise<ProviderTransfer>;
}

export interface ExpectedSnapshot {
  amountMinor: number;
  currency: string;                 // 'GBP' (compared lowercased)
  destination: string;
  earningId: string;
  transferAttemptId: string;
  expectLivemode: boolean;          // false in hosted_test; true only in production_live
}

export type LookupClassification =
  | 'found_matching' | 'not_found' | 'found_mismatch' | 'ambiguous' | 'lookup_failed';

/** EXACT matching: every required field must agree. Candidates that carry OUR
 * attempt/earning metadata but disagree on money facts are MISMATCHES (danger);
 * unrelated transfers are ignored. >1 exact match = ambiguous. Never silently
 * selects the first result. */
export function classifyLookup(
  snapshot: ExpectedSnapshot,
  candidates: ProviderTransfer[],
): { classification: Exclude<LookupClassification, 'lookup_failed'>; match?: ProviderTransfer } {
  const ours = candidates.filter((t) =>
    t.metadata?.transfer_attempt_id === snapshot.transferAttemptId
    || t.metadata?.earning_id === snapshot.earningId);
  if (ours.length === 0) return { classification: 'not_found' };
  const exact = ours.filter((t) =>
    t.amount === snapshot.amountMinor
    && t.currency.toLowerCase() === snapshot.currency.toLowerCase()
    && t.destination === snapshot.destination
    && t.livemode === snapshot.expectLivemode
    && t.metadata?.earning_id === snapshot.earningId);
  if (exact.length === 1 && ours.length === 1) return { classification: 'found_matching', match: exact[0] };
  if (exact.length > 1) return { classification: 'ambiguous' };
  if (exact.length === 1) return { classification: 'ambiguous' };   // one exact + extra related = ambiguous
  return { classification: 'found_mismatch' };
}

/** Bounded, paginated lookup. Pages of ≤100, hard cap of maxPages (default 5) —
 * a window overflow classifies as lookup_failed (unknown), never as absence. */
export async function boundedLookup(
  provider: TransferProvider,
  snapshot: ExpectedSnapshot,
  window: { createdGte: number; createdLte: number },
  maxPages = 5,
): Promise<{ classification: LookupClassification; match?: ProviderTransfer }> {
  const all: ProviderTransfer[] = [];
  let startingAfter: string | undefined;
  try {
    for (let page = 0; page < maxPages; page += 1) {
      const res = await provider.listTransfers({
        destination: snapshot.destination,
        createdGte: window.createdGte, createdLte: window.createdLte,
        startingAfter, limit: 100,
      });
      all.push(...res.data);
      if (!res.hasMore) return classifyLookup(snapshot, all);
      startingAfter = res.data[res.data.length - 1]?.id;
      if (!startingAfter) return { classification: 'lookup_failed' };
    }
    return { classification: 'lookup_failed' };                       // window overflow ⇒ unknown
  } catch {
    return { classification: 'lookup_failed' };                       // provider error ⇒ unknown, never absence
  }
}

// ---------------------------------------------------------------------------
// FAKE provider for tests: deterministic, offline, models every audited edge.
// ---------------------------------------------------------------------------
export type FakeFailureMode =
  | 'none'
  | 'timeout_before_send'          // createTransfer throws BEFORE the provider processes
  | 'timeout_after_send'           // createTransfer throws AFTER the provider processed
  | 'list_fails'
  | 'reject_permanent'
  | 'reject_retryable';

export class FakeTransferProvider implements TransferProvider {
  public created: ProviderTransfer[] = [];
  public createCallsByKey = new Map<string, number>();
  private byKey = new Map<string, ProviderTransfer>();
  constructor(
    public existing: ProviderTransfer[] = [],
    public failureMode: FakeFailureMode = 'none',
    public livemode = false,
  ) {}

  async retrieveTransfer(id: string): Promise<ProviderTransfer> {
    const found = [...this.existing, ...this.created].find((t) => t.id === id);
    if (!found) throw new Error('resource_missing');
    return found;
  }

  async listTransfers(q: { destination: string; createdGte: number; createdLte: number; startingAfter?: string; limit: number }): Promise<ProviderTransferPage> {
    if (this.failureMode === 'list_fails') throw new Error('provider_unavailable');
    const pool = [...this.existing, ...this.created]
      .filter((t) => t.destination === q.destination && t.created >= q.createdGte && t.created <= q.createdLte)
      .sort((a, b) => a.id.localeCompare(b.id));
    const startIdx = q.startingAfter ? pool.findIndex((t) => t.id === q.startingAfter) + 1 : 0;
    const page = pool.slice(startIdx, startIdx + q.limit);
    return { data: page, hasMore: startIdx + q.limit < pool.length };
  }

  async createTransfer(req: ExactTransferRequest, opts: { idempotencyKey: string }): Promise<ProviderTransfer> {
    this.createCallsByKey.set(opts.idempotencyKey, (this.createCallsByKey.get(opts.idempotencyKey) ?? 0) + 1);
    if (this.failureMode === 'timeout_before_send') throw new Error('ECONNRESET_before_send');
    if (this.failureMode === 'reject_permanent') { const e = new Error('account_invalid') as Error & { code?: string }; e.code = 'account_invalid'; throw e; }
    if (this.failureMode === 'reject_retryable') { const e = new Error('rate_limited') as Error & { code?: string }; e.code = 'lock_timeout'; throw e; }
    // Stripe idempotency: the SAME retained key returns the original transfer.
    const prior = this.byKey.get(opts.idempotencyKey);
    if (prior) return prior;
    const tr: ProviderTransfer = {
      id: `tr_fake_${this.byKey.size + 1}_${req.metadata.transfer_attempt_id?.slice(0, 8) ?? 'x'}`,
      amount: req.amountMinor, currency: req.currency.toLowerCase(), destination: req.destination,
      livemode: this.livemode, created: Math.floor(Date.now() / 1000), metadata: { ...req.metadata },
    };
    this.byKey.set(opts.idempotencyKey, tr);
    this.created.push(tr);
    if (this.failureMode === 'timeout_after_send') throw new Error('ECONNRESET_after_send');   // processed but caller never learns
    return tr;
  }
}
