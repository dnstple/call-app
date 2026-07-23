/**
 * stripe-refunds — 2G6C card-refund worker (Stripe TEST mode).
 *
 * Service-only (x-billing-secret). The DB claim (claim_payment_refunds) selects
 * eligible CARD refunds with FOR UPDATE SKIP LOCKED and COMMITS before this
 * function contacts Stripe. We then create ONE Stripe refund per row against the
 * order's PaymentIntent (no Charge id is persisted), with a STABLE idempotency
 * key per refund so duplicate workers / retries never double-refund. The
 * account-credit portion was already restored inside request_payment_refund and
 * is NEVER sent to Stripe. Each result is finalised through a transactional RPC;
 * stripe-webhook reconciles refund.updated later. No raw Stripe error is stored.
 *
 *   supabase functions deploy stripe-refunds --no-verify-jwt
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
  refund_id: string; payment_intent_id: string; amount_minor: number; currency: string;
  payer_account_id: string; stripe_idempotency_key: string;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const secretKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
  if (!secretKey.startsWith('sk_test_')) {
    return json({ error: 'stripe_not_configured', detail: 'Test-mode secret key required.' }, 200);
  }
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
  // Fixture-scoped hosted tests may pass explicit refund ids; production omits it.
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : null;

  await admin.rpc('recover_stale_refunds', { p_minutes: 30 });

  // Stage 3C1: claim_payment_refunds + recover_stale_refunds are now kill-switch
  // enforced in the DB. While the 'refund_claim' control is not 'enabled' they are
  // clean no-ops and this settlement pass initiates no refund — the control is the
  // authoritative gate. finalize_refund_* below record provider outcomes (ungated).
  const claimed = await admin.rpc('claim_payment_refunds', { p_limit: limit, p_ids: ids });
  if (claimed.error) return json({ error: 'claim_failed' }, 500);
  const items = (claimed.data ?? []) as Claim[];

  let refunded = 0, retryable = 0, permanent = 0, pending = 0;
  for (const it of items) {
    try {
      const rf = await stripe.refunds.create(
        {
          payment_intent: it.payment_intent_id,   // server-derived; no Charge id exists
          amount: it.amount_minor,                 // server-derived only
          metadata: { payment_refund_id: it.refund_id, payer_account_id: it.payer_account_id },
        },
        { idempotencyKey: it.stripe_idempotency_key },
      );
      if (rf.status === 'succeeded') {
        const fin = await admin.rpc('finalize_refund_succeeded', {
          p_refund: it.refund_id, p_stripe_refund_id: rf.id,
          p_charge_id: typeof rf.charge === 'string' ? rf.charge : null,
        });
        if (fin.error) { retryable += 1; continue; } // re-claimed; stable key dedupes
        refunded += 1;
      } else if (rf.status === 'failed' || rf.status === 'canceled') {
        await admin.rpc('finalize_refund_failed_permanent', {
          p_refund: it.refund_id, p_code: rf.failure_reason ?? 'refund_failed',
          p_message: 'Refund rejected by the payment provider.',
        });
        permanent += 1;
      } else {
        // pending / requires_action → leave 'processing'; the webhook reconciles
        // (metadata carries payment_refund_id).
        pending += 1;
      }
    } catch (err) {
      const e = err as { type?: string; code?: string };
      const isPermanent = e.type === 'StripeInvalidRequestError'
        || e.code === 'charge_already_refunded' || e.code === 'resource_missing';
      const code = e.code ?? (e.type ?? 'provider_error');
      if (isPermanent) {
        await admin.rpc('finalize_refund_failed_permanent', {
          p_refund: it.refund_id, p_code: code, p_message: 'Refund could not be created.',
        });
        permanent += 1;
      } else {
        await admin.rpc('finalize_refund_failed_retryable', {
          p_refund: it.refund_id, p_code: code, p_message: 'Temporary refund error; will retry.',
        });
        retryable += 1;
      }
    }
  }
  return json({ ok: true, claimed: items.length, refunded, retryable, permanent, pending });
});
