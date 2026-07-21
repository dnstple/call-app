/**
 * stripe-transfers — 2G6B Connect settlement worker (Stripe TEST mode).
 *
 * Service-only (x-billing-secret). The DB claim (claim_plan_transfers) selects
 * eligible PAYABLE earnings with FOR UPDATE SKIP LOCKED, claims one transfer
 * attempt per earning and COMMITS before this function contacts Stripe. We then
 * create ONE platform-balance transfer per earning (separate charges &
 * transfers; no source_transaction — an earning's funding may span credit, a
 * card PI, a monthly plan PI and multiple occurrences), using a STABLE
 * idempotency key per earning so duplicate workers / retries never double-pay.
 * Each result is finalised through a transactional RPC; the stripe-webhook
 * reconciles transfer.created/updated/reversed later.
 *
 * Amount + currency come ONLY from the claimed server data. No raw Stripe error
 * object is persisted; only a safe code + short message.
 *
 *   supabase functions deploy stripe-transfers --no-verify-jwt
 */
import Stripe from 'npm:stripe@17';
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info, x-billing-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

type Claim = {
  attempt_id: string; earning_id: string; companion_account_id: string; companion_profile_id: string;
  connected_account_id: string; amount_minor: number; currency: string; booking_id: string;
  stripe_idempotency_key: string;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const secretKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
  if (!secretKey.startsWith('sk_test_')) {
    return json({ error: 'stripe_not_configured', detail: 'Test-mode secret key required.' }, 200);
  }
  // Service-only: same internal worker secret as the billing cron.
  if ((req.headers.get('x-billing-secret') ?? '') !== (Deno.env.get('BILLING_CRON_SECRET') ?? ' ')) {
    return json({ error: 'unauthorised' }, 401);
  }
  const stripe = new Stripe(secretKey);
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { body = {}; }
  const limit = typeof body.limit === 'number' && body.limit > 0 && body.limit <= 100 ? body.limit : 20;

  // Recover any stranded claims from a crashed worker first (safe: stable key).
  await admin.rpc('recover_stale_transfers', { p_minutes: 30 });

  const claimed = await admin.rpc('claim_plan_transfers', { p_limit: limit });
  if (claimed.error) return json({ error: 'claim_failed' }, 500);
  const items = (claimed.data ?? []) as Claim[];

  let transferred = 0, retryable = 0, permanent = 0;
  for (const it of items) {
    try {
      const tr = await stripe.transfers.create(
        {
          amount: it.amount_minor,           // server-derived only
          currency: 'gbp',
          destination: it.connected_account_id,
          metadata: {
            earning_id: it.earning_id,
            booking_id: it.booking_id,
            companion_account_id: it.companion_account_id,
            companion_profile_id: it.companion_profile_id,
            transfer_attempt_id: it.attempt_id,
          },
        },
        { idempotencyKey: it.stripe_idempotency_key },
      );
      const fin = await admin.rpc('finalize_transfer_succeeded', {
        p_attempt: it.attempt_id, p_transfer_id: tr.id, p_created: tr.created ?? null,
      });
      if (fin.error) { retryable += 1; continue; } // will be re-claimed; Stripe key dedupes
      transferred += 1;
    } catch (err) {
      // Map to a SAFE code; never persist the raw Stripe object.
      const e = err as { type?: string; code?: string };
      const isPermanent = e.type === 'StripeInvalidRequestError'
        || e.code === 'account_invalid' || e.code === 'transfers_not_allowed' || e.code === 'account_closed';
      const code = e.code ?? (e.type ?? 'provider_error');
      if (isPermanent) {
        await admin.rpc('finalize_transfer_failed_permanent', {
          p_attempt: it.attempt_id, p_code: code, p_message: 'Transfer rejected by the payment provider.',
        });
        permanent += 1;
      } else {
        await admin.rpc('finalize_transfer_failed_retryable', {
          p_attempt: it.attempt_id, p_code: code, p_message: 'Temporary transfer error; will retry.',
        });
        retryable += 1;
      }
    }
  }
  return json({ ok: true, claimed: items.length, transferred, retryable, permanent });
});
