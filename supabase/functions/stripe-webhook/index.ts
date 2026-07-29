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

// Every dispute event object carries the full identifiers + provider fields, so
// the SAME upsert payload can be built for created/updated/closed/funds_* events.
// This is what lets a fund-movement event ensure the dispute exists (and is
// mapped) before it records the fund flag, independent of event ordering.
function disputeUpsertArgs(d: Stripe.Dispute) {
  const due = d.evidence_details?.due_by;
  return {
    p_stripe_dispute_id: d.id,
    p_payment_intent: typeof d.payment_intent === 'string' ? d.payment_intent : null,
    p_charge: typeof d.charge === 'string' ? d.charge : null,
    p_amount: d.amount ?? 0,
    p_currency: (d.currency ?? 'gbp').toUpperCase(),
    p_reason: d.reason ?? null,
    p_provider_status: d.status ?? null,
    p_evidence_due: due ? new Date(due * 1000).toISOString() : null,
  };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });

  const secretKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
  // Two sandbox destinations, two signing secrets: "Your account" events
  // and "Connected accounts" events. Either may be configured; at least
  // one must be. Secrets are never logged or echoed.
  const platformSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
  const connectSecret = Deno.env.get('STRIPE_CONNECT_WEBHOOK_SECRET') ?? '';
  if (!secretKey.startsWith('sk_test_') || (!platformSecret && !connectSecret)) {
    return new Response('not_configured', { status: 500 });
  }
  const stripe = new Stripe(secretKey);

  // RAW body first — every signature check covers these exact bytes.
  const rawBody = await req.text();
  const signature = req.headers.get('stripe-signature') ?? '';
  let event: Stripe.Event | null = null;
  for (const secret of [platformSecret, connectSecret]) {
    if (!secret) continue;
    try {
      event = await stripe.webhooks.constructEventAsync(rawBody, signature, secret);
      break;
    } catch {
      // Try the other configured secret; never weaken verification.
    }
  }
  if (!event) {
    // Neither configured secret validates this signature → reject.
    return new Response('invalid_signature', { status: 400 });
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // Idempotency: persist the event id BEFORE side effects. A duplicate
  // insert means we've seen it — acknowledge and stop.
  // Retry-safe idempotency: an event is only marked 'processed' AFTER its DB
  // side effects succeed. A duplicate that is already 'processed' is a no-op; a
  // prior 'failed'/'processing' row is re-run, and a failed side effect returns
  // 500 so Stripe redelivers and we retry.
  await admin.from('stripe_webhook_events').upsert({
    id: event.id,
    event_type: event.type,
    payload: event.data.object as Record<string, unknown>,
    status: 'received',
  }, { onConflict: 'id', ignoreDuplicates: true });
  // Atomic claim: exactly one concurrent invocation processes the event; an
  // already-processed event is a safe no-op; a stale 'processing' row is
  // re-claimable so a crashed/failed attempt is retried on redelivery.
  const claim = await admin.rpc('claim_webhook_event', { p_id: event.id, p_stale_minutes: 5 });
  if (claim.error) return new Response('persist_failed', { status: 500 });
  if (claim.data !== true) {
    return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
  }

  let result = 'ignored';
  let ok = true;
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
          // 2G2 exactly-once finalisation, now routed through the 3D-B1
          // shared reconcile path: verifies the expected intent linkage plus
          // amount/currency against the local snapshot, then calls the SAME
          // row-locked finalise inside app_private.reconcile_payment_order.
          await admin.rpc('reconcile_payment_order', {
            p_order: orderId,
            p_intent: typeof session.payment_intent === 'string' ? session.payment_intent : null,
            p_provider_status: session.payment_status === 'paid' ? 'succeeded' : 'processing',
            p_amount_minor: session.payment_status === 'paid' ? session.amount_total : null,
            p_currency: session.payment_status === 'paid' ? session.currency : null,
            p_event_at: new Date(event.created * 1000).toISOString(),
            p_metadata_order: orderId,
          });
          result = session.payment_status === 'paid' ? 'order_finalised' : 'order_processing';
        }
        break;
      }
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const orderId = pi.metadata?.payment_order_id;
        if (orderId && pi.currency?.toUpperCase() === 'GBP') {
          await admin.rpc('reconcile_payment_order', {
            p_order: orderId, p_intent: pi.id, p_provider_status: 'succeeded',
            p_amount_minor: pi.amount_received ?? pi.amount, p_currency: pi.currency,
            p_event_at: new Date(event.created * 1000).toISOString(),
            p_metadata_order: orderId,
          });
          result = 'order_finalised';
        }
        break;
      }
      case 'payment_intent.processing': {
        // 3D-B1: durable projection only — no financial effect. The customer
        // sees an honest 'processing' state instead of a silent stall.
        const pi = event.data.object as Stripe.PaymentIntent;
        const orderId = pi.metadata?.payment_order_id;
        if (orderId) {
          await admin.rpc('reconcile_payment_order', {
            p_order: orderId, p_intent: pi.id, p_provider_status: 'processing',
            p_amount_minor: null, p_currency: null,
            p_event_at: new Date(event.created * 1000).toISOString(),
            p_metadata_order: orderId,
          });
          result = 'order_processing';
        }
        break;
      }
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const orderId = pi.metadata?.payment_order_id;
        if (orderId) {
          // Releases the credit reservation and frees the slot hold. For
          // plan_period orders this routes through the single-authority state
          // sync; a cancellation carries the distinct safe 'payment_cancelled'
          // code so order + period always end in a consistent terminal state.
          await admin.rpc('reconcile_payment_order', {
            p_order: orderId, p_intent: pi.id,
            p_provider_status: event.type === 'payment_intent.canceled' ? 'canceled' : 'failed',
            p_amount_minor: null, p_currency: null,
            p_event_at: new Date(event.created * 1000).toISOString(),
            p_metadata_order: orderId,
          });
          result = 'order_failed';
        }
        break;
      }
      case 'account.updated': {
        // 2G3: safe status sync + deduplicated notifications on MEANINGFUL
        // state changes only (never one per webhook).
        const acct = event.data.object as Stripe.Account;
        const { data: before } = await admin.from('connected_accounts')
          .select('account_id, details_submitted, payouts_enabled, transfers_capability, disabled_reason')
          .eq('stripe_account_id', acct.id).maybeSingle();
        const next = {
          details_submitted: Boolean(acct.details_submitted),
          charges_enabled: Boolean(acct.charges_enabled),
          payouts_enabled: Boolean(acct.payouts_enabled),
          transfers_capability: String(acct.capabilities?.transfers ?? 'inactive'),
          requirements_due: acct.requirements?.currently_due ?? [],
          requirements_past_due: acct.requirements?.past_due ?? [],
          requirements_eventually_due: acct.requirements?.eventually_due ?? [],
          disabled_reason: acct.requirements?.disabled_reason ?? null,
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        await admin.from('connected_accounts').update(next).eq('stripe_account_id', acct.id);

        // Derived headline state — notify only when it changes.
        const derive = (r: { details_submitted: boolean; payouts_enabled: boolean; transfers_capability: string; disabled_reason: string | null }) =>
          r.disabled_reason ? 'restricted'
            : r.payouts_enabled && r.transfers_capability === 'active' && r.details_submitted ? 'ready'
            : r.details_submitted ? 'in_review'
            : 'incomplete';
        const prevState = before ? derive(before as never) : 'incomplete';
        const nextState = derive(next as never);
        if (before?.account_id && nextState !== prevState) {
          const copy: Record<string, { title: string; body: string }> = {
            ready: { title: 'Payment account ready', body: 'Your payment account is ready. Earnings will become available after eligible conversations are completed.' },
            in_review: { title: 'Verification in progress', body: 'Stripe is reviewing your information.' },
            incomplete: { title: 'Payment setup incomplete', body: 'Stripe still needs some information to finish your payment setup.' },
            restricted: { title: 'Payments restricted', body: 'Your payment account needs attention. Continue setup to resolve it.' },
          };
          await admin.from('notifications').insert({
            user_id: before.account_id,
            type: `connect_${nextState}`,
            title: copy[nextState].title,
            body: copy[nextState].body,
            dedupe_key: `connect:${acct.id}:${nextState}`,
          });
        }
        result = 'account_synced';
        break;
      }
      // 2G6B — Connect transfer reconciliation. Resolve the internal attempt via
      // trusted metadata (transfer_attempt_id) or, as a fallback, the transfer
      // id. Finalisation RPCs are idempotent, so duplicate/out-of-order events
      // and the Edge Function's own finalisation never conflict.
      case 'transfer.created':
      case 'transfer.updated':
      case 'transfer.reversed': {
        const tr = event.data.object as Stripe.Transfer;
        let attemptId = typeof tr.metadata?.transfer_attempt_id === 'string'
          ? tr.metadata.transfer_attempt_id : null;
        if (!attemptId) {
          const found = await admin.rpc('attempt_id_for_transfer', { p_transfer_id: tr.id });
          attemptId = (found.data as string | null) ?? null;
        }
        if (attemptId) {
          const reversed = event.type === 'transfer.reversed' || (tr.amount_reversed ?? 0) > 0;
          if (reversed) {
            await admin.rpc('finalize_transfer_reversed', { p_attempt: attemptId, p_code: 'transfer_reversed' });
            result = 'transfer_reversed';
          } else {
            // transfer.created/updated confirm the transfer exists → mark settled.
            await admin.rpc('finalize_transfer_succeeded', {
              p_attempt: attemptId, p_transfer_id: tr.id, p_created: tr.created ?? null,
            });
            result = 'transfer_reconciled';
          }
        } else {
          result = 'transfer_unmatched';
        }
        break;
      }
      // 2G6C — refund reconciliation. Resolve the internal refund via trusted
      // metadata (payment_refund_id) or the Stripe refund id; finalisers are
      // idempotent, so duplicate/out-of-order events and the worker's own
      // finalisation never conflict. Webhook amounts are NEVER used as money
      // authority — only the internally-approved amount stands.
      case 'refund.created':
      case 'refund.updated': {
        const rf = event.data.object as Stripe.Refund;
        let refundId = typeof rf.metadata?.payment_refund_id === 'string'
          ? rf.metadata.payment_refund_id : null;
        if (!refundId) {
          const found = await admin.rpc('refund_id_for_stripe', { p_stripe_refund_id: rf.id });
          refundId = (found.data as string | null) ?? null;
        }
        if (refundId) {
          if (rf.status === 'succeeded') {
            await admin.rpc('finalize_refund_succeeded', {
              p_refund: refundId, p_stripe_refund_id: rf.id,
              p_charge_id: typeof rf.charge === 'string' ? rf.charge : null,
            });
            result = 'refund_reconciled';
          } else if (rf.status === 'failed' || rf.status === 'canceled') {
            await admin.rpc('finalize_refund_failed_permanent', {
              p_refund: refundId, p_code: rf.failure_reason ?? 'refund_failed',
              p_message: 'Refund rejected by the payment provider.',
            });
            result = 'refund_failed';
          } else {
            result = 'refund_pending';
          }
        } else {
          result = 'refund_unmatched';
        }
        break;
      }
      // 2G6D — dispute reconciliation. Provider dispute status and actual fund
      // movement are RECORDED separately; no evidence is submitted, no transfer
      // reversed. RPC errors throw → the event is left retriable (500).
      //
      // EVERY dispute event object (created, updated, funds_withdrawn,
      // funds_reinstated) carries the full identifiers + provider fields, so the
      // fund-movement handlers FIRST upsert the dispute (idempotently creating and
      // mapping it if the created event has not landed yet) and only THEN record
      // the fund flag. This makes each fund event independently processable and
      // removes the out-of-order defect where a funds event that arrived before
      // created was silently marked processed with no effect.
      case 'charge.dispute.created':
      case 'charge.dispute.updated': {
        const d = event.data.object as Stripe.Dispute;
        const up = await admin.rpc('record_dispute_upsert', disputeUpsertArgs(d));
        if (up.error) throw new Error(`dispute_upsert:${up.error.message}`);
        result = 'dispute_recorded';
        break;
      }
      case 'charge.dispute.closed': {
        const d = event.data.object as Stripe.Dispute;
        // Ensure the dispute exists/maps even if closed raced ahead of created.
        const up = await admin.rpc('record_dispute_upsert', disputeUpsertArgs(d));
        if (up.error) throw new Error(`dispute_upsert:${up.error.message}`);
        const r = await admin.rpc('record_dispute_closed', {
          p_stripe_dispute_id: d.id, p_provider_status: d.status ?? null, p_outcome: d.status ?? null,
        });
        if (r.error) throw new Error(`dispute_closed:${r.error.message}`);
        result = 'dispute_closed';
        break;
      }
      case 'charge.dispute.funds_withdrawn': {
        const d = event.data.object as Stripe.Dispute;
        // 1) ensure the dispute row exists + is mapped from the full event object;
        const up = await admin.rpc('record_dispute_upsert', disputeUpsertArgs(d));
        if (up.error) throw new Error(`dispute_upsert:${up.error.message}`);
        // 2) then record the fund movement (backstopped: raises if row absent).
        const r = await admin.rpc('record_dispute_funds_withdrawn', { p_stripe_dispute_id: d.id });
        if (r.error) throw new Error(`dispute_funds_withdrawn:${r.error.message}`);
        result = 'dispute_funds_withdrawn';
        break;
      }
      case 'charge.dispute.funds_reinstated': {
        const d = event.data.object as Stripe.Dispute;
        const up = await admin.rpc('record_dispute_upsert', disputeUpsertArgs(d));
        if (up.error) throw new Error(`dispute_upsert:${up.error.message}`);
        const r = await admin.rpc('record_dispute_funds_reinstated', { p_stripe_dispute_id: d.id });
        if (r.error) throw new Error(`dispute_funds_reinstated:${r.error.message}`);
        result = 'dispute_funds_reinstated';
        break;
      }
      default:
        result = 'ignored';
    }
    await admin.from('stripe_webhook_events').update({
      status: 'processed', processed_at: new Date().toISOString(), result,
    }).eq('id', event.id);
  } catch (e) {
    ok = false;
    await admin.from('stripe_webhook_events').update({
      status: 'failed', processed_at: null,
      result: `error:${e instanceof Error ? e.message : 'unknown'}`,
    }).eq('id', event.id);
  }

  // A failed side effect returns 500 so Stripe redelivers and the operation
  // retries; a successful/ignored event acknowledges with 200.
  return new Response(JSON.stringify({ received: true, ok }), { status: ok ? 200 : 500 });
});
