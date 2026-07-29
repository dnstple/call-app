/**
 * scoped-stripe-transfers — Stage 3C2-C2 scoped provider transfer saga.
 *
 * NOT DEPLOYED in the implementation pass. Executes ONLY an explicit, support-
 * confirmed transfer_finalise run (≤5 earnings) presented with its run id +
 * confirmation token (single-use support credential). Every database transition
 * goes through the lease-bound 0078 RPCs; this function NEVER calls
 * claim_plan_transfers, recover_stale_transfers or any other worker, and never
 * processes an earning outside the approved run scope.
 *
 * LOOKUP-FIRST, EXACTLY-ONCE: for each item the saga performs an immediate
 * bounded provider lookup (Stripe has no idempotency-key lookup; retained keys
 * expire; metadata matching is client-side), persists the result, and only a
 * FRESH not_found + database authorize-create (≤2 min) may proceed to ONE
 * stripe.transfers.create using the exact snapshot + stable idempotency key from
 * the database (never regenerated here). Mismatch/ambiguity/lookup failure stop
 * the item as reconciliation_required. Timeouts after a possible send become
 * provider_outcome_unknown — never an immediate second create.
 *
 * TEST-MODE GUARD: outside production_live the configured key MUST be sk_test_*
 * and every provider transfer MUST report livemode=false (also re-verified in
 * the database finalisers).
 *
 * No secrets, destination ids, idempotency keys or raw provider payloads are
 * ever logged.
 */
import Stripe from 'npm:stripe@17';
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info, x-billing-secret',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// ---- provider abstraction (dependency-injected; fake in tests) ----
interface ProviderTransfer {
  id: string; amount: number; currency: string; destination: string;
  livemode: boolean; created: number; metadata: Record<string, string>;
}
interface TransferProvider {
  retrieveTransfer(id: string): Promise<ProviderTransfer>;
  listTransfers(q: { destination: string; createdGte: number; createdLte: number; startingAfter?: string; limit: number }): Promise<{ data: ProviderTransfer[]; hasMore: boolean }>;
  createTransfer(req: { amountMinor: number; currency: string; destination: string; metadata: Record<string, string> }, opts: { idempotencyKey: string }): Promise<ProviderTransfer>;
}

function stripeProvider(stripe: Stripe): TransferProvider {
  return {
    async retrieveTransfer(id) {
      const t = await stripe.transfers.retrieve(id);
      return { id: t.id, amount: t.amount, currency: t.currency, destination: String(t.destination), livemode: t.livemode, created: t.created, metadata: (t.metadata ?? {}) as Record<string, string> };
    },
    async listTransfers(q) {
      const res = await stripe.transfers.list({
        destination: q.destination, created: { gte: q.createdGte, lte: q.createdLte },
        limit: q.limit, starting_after: q.startingAfter,
      });
      return {
        data: res.data.map((t) => ({ id: t.id, amount: t.amount, currency: t.currency, destination: String(t.destination), livemode: t.livemode, created: t.created, metadata: (t.metadata ?? {}) as Record<string, string> })),
        hasMore: res.has_more,
      };
    },
    async createTransfer(req, opts) {
      const t = await stripe.transfers.create(
        { amount: req.amountMinor, currency: req.currency, destination: req.destination, metadata: req.metadata },
        { idempotencyKey: opts.idempotencyKey },   // EXACT stable key from the DB snapshot
      );
      return { id: t.id, amount: t.amount, currency: t.currency, destination: String(t.destination), livemode: t.livemode, created: t.created, metadata: (t.metadata ?? {}) as Record<string, string> };
    },
  };
}

// ---- exact matching (mirrors src/repositories/transferProviderAdapter.ts) ----
interface Snapshot {
  amount_minor: number; currency: string; destination_account_id: string;
  idempotency_key: string; metadata: Record<string, string>;
  lookup_window_gte: number; lookup_window_lte: number;
}
function classify(snapshot: Snapshot, expectLivemode: boolean, candidates: ProviderTransfer[]):
    { c: 'found_matching' | 'not_found' | 'found_mismatch' | 'ambiguous'; match?: ProviderTransfer } {
  const ours = candidates.filter((t) =>
    t.metadata?.transfer_attempt_id === snapshot.metadata.transfer_attempt_id
    || t.metadata?.earning_id === snapshot.metadata.earning_id);
  if (ours.length === 0) return { c: 'not_found' };
  const exact = ours.filter((t) =>
    t.amount === snapshot.amount_minor
    && t.currency.toLowerCase() === snapshot.currency.toLowerCase()
    && t.destination === snapshot.destination_account_id
    && t.livemode === expectLivemode
    && t.metadata?.earning_id === snapshot.metadata.earning_id);
  if (exact.length === 1 && ours.length === 1) return { c: 'found_matching', match: exact[0] };
  if (exact.length >= 1) return { c: 'ambiguous' };
  return { c: 'found_mismatch' };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: any; error: { message?: string } | null }> };

export function createHandler(deps: { admin: Admin; provider: TransferProvider; billingSecret: string; keyIsTestMode: boolean }) {
  const { admin, provider } = deps;
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    // Authorised scoped support flow ONLY: service secret + run credential.
    if (req.headers.get('x-billing-secret') !== deps.billingSecret) return json({ error: 'forbidden' }, 403);
    let body: { run_id?: string; confirmation_token?: string } = {};
    try { body = await req.json(); } catch { body = {}; }
    if (!body.run_id || !body.confirmation_token) return json({ error: 'run_credentials_required' }, 400);

    const begin = await admin.rpc('begin_scoped_provider_transfer_run', { p_run_id: body.run_id, p_confirmation_token: body.confirmation_token });
    if (begin.error) return json({ error: 'begin_failed', code: begin.error.message?.split(':')[0] }, 409);
    if (begin.data?.already_executed) return json({ ok: true, already_executed: true });

    const env = String(begin.data.environment ?? 'hosted_test');
    const expectLivemode = env === 'production_live';
    // TEST-MODE GUARD: never run a live key outside production_live.
    if (!expectLivemode && !deps.keyIsTestMode) return json({ error: 'live_key_rejected_in_test_environment' }, 409);
    if (expectLivemode) return json({ error: 'production_live_execution_not_yet_enabled' }, 409);

    const earningIds = (begin.data.earning_ids ?? []) as string[];
    if (earningIds.length === 0 || earningIds.length > 5) return json({ error: 'invalid_scope' }, 409);

    for (const earningId of earningIds) {
      const item = await admin.rpc('begin_scoped_provider_transfer_item', { p_run_id: body.run_id, p_confirmation_token: body.confirmation_token, p_earning_id: earningId });
      if (item.error || item.data?.proceed !== true) continue;   // durable item already recorded by the RPC
      const jobId = item.data.job_id as string;
      const lease = item.data.lease_token as string;
      const snapshot = item.data.snapshot as Snapshot;

      try {
        // ---- LOOKUP FIRST (always; also for verify_path with a known id) ----
        if (item.data.mode === 'verify_path' && item.data.snapshot.provider_transfer_id) {
          try {
            const t = await provider.retrieveTransfer(item.data.snapshot.provider_transfer_id as string);
            const c = classify(snapshot, expectLivemode, [t]);
            await admin.rpc('record_scoped_transfer_lookup', { p_job_id: jobId, p_lease_token: lease, p_outcome: c.c === 'found_matching' ? 'found_matching' : 'found_mismatch', p_provider: c.match ?? t });
          } catch {
            await admin.rpc('record_scoped_transfer_lookup', { p_job_id: jobId, p_lease_token: lease, p_outcome: 'lookup_failed', p_provider: null });
          }
          continue;   // verify path NEVER creates
        }
        let candidates: ProviderTransfer[] = [];
        let lookupOutcome: 'found_matching' | 'not_found' | 'found_mismatch' | 'ambiguous' | 'lookup_failed';
        let match: ProviderTransfer | undefined;
        try {
          let startingAfter: string | undefined;
          let overflow = true;
          for (let page = 0; page < 5; page += 1) {
            const res = await provider.listTransfers({ destination: snapshot.destination_account_id, createdGte: snapshot.lookup_window_gte, createdLte: snapshot.lookup_window_lte, startingAfter, limit: 100 });
            candidates = candidates.concat(res.data);
            if (!res.hasMore) { overflow = false; break; }
            startingAfter = res.data[res.data.length - 1]?.id;
          }
          if (overflow) { lookupOutcome = 'lookup_failed'; }
          else { const r = classify(snapshot, expectLivemode, candidates); lookupOutcome = r.c; match = r.match; }
        } catch { lookupOutcome = 'lookup_failed'; }

        const rec = await admin.rpc('record_scoped_transfer_lookup', { p_job_id: jobId, p_lease_token: lease, p_outcome: lookupOutcome, p_provider: match ?? null });
        if (rec.error || rec.data?.may_authorize !== true) continue;   // finalised or reconciliation_required

        // ---- AUTHORISE (fresh, ≤2 min) then ONE create with the exact snapshot ----
        const auth = await admin.rpc('authorize_scoped_transfer_create', { p_job_id: jobId, p_lease_token: lease });
        if (auth.error) continue;
        try {
          const created = await provider.createTransfer(
            { amountMinor: auth.data.amount_minor, currency: String(auth.data.currency).toLowerCase(), destination: auth.data.destination_account_id, metadata: auth.data.metadata },
            { idempotencyKey: auth.data.idempotency_key },
          );
          if (!expectLivemode && created.livemode) {
            await admin.rpc('finalize_scoped_transfer_uncertain', { p_job_id: jobId, p_lease_token: lease, p_reason_code: 'livemode_transfer_in_test_environment' });
            continue;
          }
          await admin.rpc('finalize_scoped_transfer_success', { p_job_id: jobId, p_lease_token: lease, p_provider: created });
        } catch (err) {
          const e = err as { code?: string; message?: string };
          if (e.message?.includes('after_send')) {
            await admin.rpc('finalize_scoped_transfer_uncertain', { p_job_id: jobId, p_lease_token: lease, p_reason_code: 'timeout_after_send' });
          } else if (e.code === 'account_invalid' || e.code === 'transfers_not_allowed' || e.code === 'account_closed') {
            await admin.rpc('finalize_scoped_transfer_rejected', { p_job_id: jobId, p_lease_token: lease, p_code: e.code, p_permanent: true });
          } else if (e.code) {
            await admin.rpc('finalize_scoped_transfer_rejected', { p_job_id: jobId, p_lease_token: lease, p_code: e.code, p_permanent: false });
          } else {
            await admin.rpc('finalize_scoped_transfer_uncertain', { p_job_id: jobId, p_lease_token: lease, p_reason_code: 'timeout_before_confirmation' });
          }
        }
      } catch {
        await admin.rpc('finalize_scoped_transfer_uncertain', { p_job_id: jobId, p_lease_token: lease, p_reason_code: 'saga_interrupted' });
      }
    }

    const done = await admin.rpc('complete_scoped_provider_transfer_run', { p_run_id: body.run_id, p_confirmation_token: body.confirmation_token });
    if (done.error) return json({ error: 'complete_failed' }, 500);
    return json(done.data);
  };
}

// ---- production wiring (unused until this function is deliberately deployed) ----
if (import.meta.main) {
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
  const handler = createHandler({
    admin: createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } }) as unknown as Admin,
    provider: stripeProvider(new Stripe(stripeKey)),
    billingSecret: Deno.env.get('BILLING_WORKER_SECRET') ?? '',
    keyIsTestMode: stripeKey.startsWith('sk_test_'),
  });
  Deno.serve(handler);
}
