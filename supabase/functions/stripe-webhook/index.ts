/**
 * 2G1 — Stripe webhook receiver (financial source of truth).
 *
 * Rules enforced here:
 *  * signature verified against the RAW request body
 *    (STRIPE_WEBHOOK_SECRET from Function secrets);
 *  * the event id is persisted BEFORE any side effect — replays and
 *    retries become no-ops;
 *  * every handler resolves internal records via trusted metadata
 *    (internal UUIDs only) and updates state through the service role;
 *  * browser redirects are never proof of payment — THIS is.
 *
 *   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
 *   supabase functions deploy stripe-webhook --no-verify-jwt
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });

  const secretKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
  if (!secretKey.startsWith('sk_test_') || !webhookSecret) {
    return new Response('not_configured', { status: 500 });
  }
  const stripe = new Stripe(secretKey);

  // RAW body first — the signature covers these exact bytes.
  const rawBody = await req.text();
  const signature = req.headers.get('stripe-signature') ?? '';
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
  } catch {
    return new Response('invalid_signature', { status: 400 });
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // Idempotency: persist the event id BEFORE side effects. A duplicate
  // insert means we've seen it — acknowledge and stop.
  const inserted = await admin.from('stripe_webhook_events').insert({
    id: event.id,
    event_type: event.type,
    payload: event.data.object as Record<string, unknown>,
  });
  if (inserted.error) {
    if (/duplicate|unique/i.test(inserted.error.message)) {
      return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
    }
    return new Response('persist_failed', { status: 500 });
  }

  let result = 'ignored';
  try {
    switch (event.type) {
      case 'setup_intent.succeeded': {
        const si = event.data.object as Stripe.SetupIntent;
        const accountId = si.metadata?.account_id;
        const pm = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id;
        if (accountId && pm) {
          await admin.from('stripe_customers').update({
            default_payment_method_id: pm,
            payment_method_ready: true,
            updated_at: new Date().toISOString(),
          }).eq('account_id', accountId);
          // Make the card the customer's default for off-session charges.
          if (typeof si.customer === 'string') {
            try {
              await stripe.customers.update(si.customer, {
                invoice_settings: { default_payment_method: pm },
              });
            } catch {
              /* default assignment is best-effort */
            }
          }
          result = 'payment_method_saved';
        }
        break;
      }
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const orderId = session.metadata?.payment_order_id;
        if (orderId && session.mode === 'payment') {
          // 2G2: exactly-once finalisation (order lock inside the RPC)
          // creates the funded booking and completes credit consumption.
          await admin.rpc('finalize_paid_order', {
            p_order: orderId,
            p_outcome: 'succeeded',
            p_intent: typeof session.payment_intent === 'string' ? session.payment_intent : null,
          });
          result = 'order_finalised';
        }
        break;
      }
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const orderId = pi.metadata?.payment_order_id;
        if (orderId && pi.currency?.toUpperCase() === 'GBP') {
          await admin.rpc('finalize_paid_order', {
            p_order: orderId, p_outcome: 'succeeded', p_intent: pi.id,
          });
          result = 'order_finalised';
        }
        break;
      }
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const orderId = pi.metadata?.payment_order_id;
        if (orderId) {
          // Releases the credit reservation and frees the slot hold.
          await admin.rpc('finalize_paid_order', {
            p_order: orderId, p_outcome: 'failed', p_intent: pi.id,
          });
          result = 'order_failed';
        }
        break;
      }
      case 'account.updated': {
        // 2G3 fills the full lifecycle; the sync itself is safe now.
        const acct = event.data.object as Stripe.Account;
        await admin.from('connected_accounts').update({
          details_submitted: Boolean(acct.details_submitted),
          charges_enabled: Boolean(acct.charges_enabled),
          payouts_enabled: Boolean(acct.payouts_enabled),
          requirements_due: acct.requirements?.currently_due ?? [],
          requirements_past_due: acct.requirements?.past_due ?? [],
          disabled_reason: acct.requirements?.disabled_reason ?? null,
          last_synced_at: new Date().toISOString(),
        }).eq('stripe_account_id', acct.id);
        result = 'account_synced';
        break;
      }
      default:
        result = 'ignored';
    }
    await admin.from('stripe_webhook_events').update({
      processed_at: new Date().toISOString(),
      result,
    }).eq('id', event.id);
  } catch (e) {
    await admin.from('stripe_webhook_events').update({
      processed_at: new Date().toISOString(),
      result: `error:${e instanceof Error ? e.message : 'unknown'}`,
    }).eq('id', event.id);
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 });
});
