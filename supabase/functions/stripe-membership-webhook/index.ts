/**
 * stripe-membership-webhook — the membership state machine, driven by Stripe.
 *
 *   checkout.session.completed (kind=membership_starter)
 *       → create the recurring subscription (starts in 7 days), record starter
 *         paid (issues 3 starter credits, sets the 7-day anchor).
 *   invoice.paid (subscription)      → mark active, extend period, accrue credits.
 *   invoice.payment_failed           → past_due (weekly accrual pauses).
 *   customer.subscription.updated    → status + cancel_at_period_end.
 *   customer.subscription.deleted    → cancelled.
 *
 * Requires env: STRIPE_SECRET_KEY, STRIPE_PRICE_MONTHLY, STRIPE_MEMBERSHIP_WEBHOOK_SECRET.
 * Deploy WITHOUT JWT verification (Stripe calls it):
 *   supabase functions deploy stripe-membership-webhook --no-verify-jwt
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17';
import { stripeKeyAllowed } from '../_shared/stripeMode.ts';

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const secretKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
  const whSecret = Deno.env.get('STRIPE_MEMBERSHIP_WEBHOOK_SECRET') ?? '';
  if (!stripeKeyAllowed(secretKey) || !whSecret) return json({ error: 'stripe_not_configured' }, 503);

  const stripe = new Stripe(secretKey, { apiVersion: '2024-06-20' });
  const sig = req.headers.get('stripe-signature') ?? '';
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, whSecret);
  } catch (e) {
    return json({ error: 'bad_signature', detail: (e as Error).message }, 400);
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  async function membershipBySubscription(subId: string): Promise<string | null> {
    const { data } = await admin.from('memberships').select('id').eq('stripe_subscription_id', subId).maybeSingle();
    return data?.id ?? null;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.metadata?.kind !== 'membership_starter') break;
        const memberProfile = s.metadata.member_profile_id!;
        const payer = s.metadata.payer_account_id!;
        const monthlyPrice = s.metadata.monthly_price || (Deno.env.get('STRIPE_PRICE_MONTHLY') ?? '');
        const customer = typeof s.customer === 'string' ? s.customer : s.customer?.id;
        if (!customer || !monthlyPrice) break;

        // Create the recurring subscription that begins in 7 days (trial = 7 days
        // so the first £100 invoice lands then, not now).
        const trialEnd = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
        const sub = await stripe.subscriptions.create({
          customer,
          items: [{ price: monthlyPrice }],
          trial_end: trialEnd,
          metadata: { kind: 'membership', member_profile_id: memberProfile, payer_account_id: payer },
        }, { idempotencyKey: `membership-sub-${memberProfile}` });

        const { data: mid } = await admin.rpc('upsert_membership', {
          p_member_profile: memberProfile, p_payer_account: payer,
          p_stripe_customer: customer, p_stripe_subscription: sub.id,
        });
        if (mid) await admin.rpc('record_membership_starter_paid', { p_membership: mid });
        break;
      }

      case 'invoice.paid': {
        const inv = event.data.object as Stripe.Invoice;
        const subId = typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id;
        if (!subId) break;
        const mid = await membershipBySubscription(subId);
        if (!mid) break;
        const start = inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null;
        const end = inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null;
        await admin.rpc('record_membership_invoice_paid', { p_membership: mid, p_period_start: start, p_period_end: end });
        await admin.rpc('accrue_weekly_credits');
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object as Stripe.Invoice;
        const subId = typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id;
        if (!subId) break;
        const mid = await membershipBySubscription(subId);
        if (mid) await admin.rpc('record_membership_status', { p_membership: mid, p_status: 'past_due', p_cancel_at_period_end: null });
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const mid = await membershipBySubscription(sub.id);
        if (!mid) break;
        const status = sub.cancel_at_period_end ? 'active' : (sub.status === 'past_due' ? 'past_due' : 'active');
        await admin.rpc('record_membership_status', { p_membership: mid, p_status: status, p_cancel_at_period_end: sub.cancel_at_period_end });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const mid = await membershipBySubscription(sub.id);
        if (mid) await admin.rpc('record_membership_status', { p_membership: mid, p_status: 'cancelled', p_cancel_at_period_end: null });
        break;
      }

      default:
        break;
    }
  } catch (e) {
    return json({ error: 'handler_error', detail: (e as Error).message }, 500);
  }

  return json({ received: true });
});
