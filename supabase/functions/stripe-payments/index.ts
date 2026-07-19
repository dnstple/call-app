/**
 * 2G1 — Stripe TEST-MODE payment foundation (authenticated actions).
 *
 * The ONLY browser-reachable Stripe surface. Every Stripe object is
 * created server-side with idempotency keys; the browser receives only
 * client secrets / publishable-safe data. Secrets live in Function
 * secrets, never VITE_ variables, never the database:
 *
 *   supabase secrets set STRIPE_SECRET_KEY=sk_test_...
 *   supabase functions deploy stripe-payments
 *
 * Actions:
 *   ensure_customer   → creates/returns the Coordinator's Stripe Customer
 *   create_setup_intent → SetupIntent for saving an off-session card
 *   billing_status    → customer + payment-method readiness (no card data)
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const secretKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
  if (!secretKey.startsWith('sk_test_')) {
    // TEST MODE ONLY — a live key is refused outright.
    return json({ error: 'stripe_not_configured', detail: 'Test-mode secret key required.' }, 200);
  }
  const stripe = new Stripe(secretKey);

  // Caller identity from the verified Supabase session.
  const authed = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false } },
  );
  const { data: userData } = await authed.auth.getUser();
  const user = userData?.user;
  if (!user) return json({ error: 'unauthorised' }, 401);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const action = typeof body.action === 'string' ? body.action : '';

  // ---------- ensure the Coordinator's Stripe Customer ----------
  async function ensureCustomer(): Promise<{ customerId: string }> {
    const { data: existing } = await admin
      .from('stripe_customers').select('stripe_customer_id').eq('account_id', user!.id).maybeSingle();
    if (existing?.stripe_customer_id) return { customerId: existing.stripe_customer_id };
    const customer = await stripe.customers.create(
      {
        email: user!.email ?? undefined,
        // Internal UUID only — never Member details in Stripe metadata.
        metadata: { account_id: user!.id },
      },
      { idempotencyKey: `customer-${user!.id}` },
    );
    await admin.from('stripe_customers').upsert({
      account_id: user!.id,
      stripe_customer_id: customer.id,
    }, { onConflict: 'account_id' });
    return { customerId: customer.id };
  }

  try {
    if (action === 'ensure_customer') {
      const { customerId } = await ensureCustomer();
      return json({ ok: true, customerId });
    }

    if (action === 'create_setup_intent') {
      const { customerId } = await ensureCustomer();
      const intent = await stripe.setupIntents.create(
        {
          customer: customerId,
          usage: 'off_session',
          metadata: { account_id: user.id },
        },
        { idempotencyKey: `setup-${user.id}-${new Date().toISOString().slice(0, 10)}` },
      );
      return json({ ok: true, clientSecret: intent.client_secret });
    }

    // Card-setup approach: Stripe-HOSTED Checkout Session in setup mode.
    // The app has no embedded Stripe frontend SDK, so the hosted page is
    // the smallest, safest surface: Stripe collects the card, the webhook
    // confirms it — the redirect back is never trusted as proof.
    if (action === 'create_setup_session') {
      const { customerId } = await ensureCustomer();
      // Return URLs derive ONLY from the allowlisted app origin.
      const allowed = (Deno.env.get('APP_ORIGINS') ?? 'http://localhost:5173')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const requested = typeof body.origin === 'string' ? body.origin : '';
      const origin = allowed.includes(requested) ? requested : allowed[0];
      const session = await stripe.checkout.sessions.create(
        {
          mode: 'setup',
          customer: customerId,
          payment_method_types: ['card'],
          // Metadata rides on the SetupIntent so the existing
          // setup_intent.succeeded webhook handler confirms completion.
          setup_intent_data: { metadata: { account_id: user.id } },
          success_url: `${origin}/#/settings?setup=success`,
          cancel_url: `${origin}/#/settings?setup=cancelled`,
        },
        { idempotencyKey: `setup-session-${user.id}-${Date.now()}` },
      );
      return json({ ok: true, url: session.url });
    }

    if (action === 'remove_payment_method') {
      const { data: row } = await admin
        .from('stripe_customers')
        .select('default_payment_method_id')
        .eq('account_id', user.id)
        .maybeSingle();
      if (row?.default_payment_method_id) {
        await stripe.paymentMethods.detach(row.default_payment_method_id);
      }
      await admin.from('stripe_customers').update({
        default_payment_method_id: null,
        payment_method_ready: false,
        updated_at: new Date().toISOString(),
      }).eq('account_id', user.id);
      return json({ ok: true });
    }

    if (action === 'billing_status') {
      const { data: row } = await admin
        .from('stripe_customers')
        .select('stripe_customer_id, payment_method_ready, default_payment_method_id')
        .eq('account_id', user.id)
        .maybeSingle();
      // Safe summary ONLY — brand, last4, expiry. Card numbers and CVC
      // never exist anywhere in this system.
      let card: { brand: string; last4: string; expMonth: number; expYear: number } | null = null;
      if (row?.default_payment_method_id) {
        try {
          const pm = await stripe.paymentMethods.retrieve(row.default_payment_method_id);
          if (pm.card) {
            card = {
              brand: pm.card.brand,
              last4: pm.card.last4,
              expMonth: pm.card.exp_month,
              expYear: pm.card.exp_year,
            };
          }
        } catch {
          card = null;
        }
      }
      return json({
        ok: true,
        hasCustomer: Boolean(row?.stripe_customer_id),
        paymentMethodReady: Boolean(row?.payment_method_ready),
        card,
        testMode: true,
      });
    }

    // ---------- 2G2: paid trial / one-off requests ----------
    if (action === 'quote_paid_request') {
      const { data, error } = await authed.rpc('quote_paid_request', {
        p_member: body.memberProfileId, p_companion: body.companionProfileId, p_offer: body.offerId,
      });
      if (error) return json({ error: 'quote_failed', detail: error.message }, 200);
      return json({ ok: true, quote: data });
    }

    if (action === 'create_paid_request') {
      // Server-side order first (credit reserved, prices snapshotted).
      const { data: created, error } = await authed.rpc('create_paid_request', {
        p_member: body.memberProfileId, p_companion: body.companionProfileId,
        p_offer: body.offerId, p_starts_at: body.startsAt,
        p_idempotency: body.idempotencyKey,
      });
      if (error) return json({ error: 'request_failed', detail: error.message }, 200);
      const order = created as { order_id: string; status: string; card_amount_minor: number };
      // Credit-only orders finalised atomically — NO PaymentIntent exists.
      if (order.status === 'succeeded' || order.card_amount_minor === 0) {
        return json({ ok: true, orderId: order.order_id, state: 'succeeded', fundedByCreditOnly: true });
      }
      const { customerId } = await ensureCustomer();
      const { data: cust } = await admin.from('stripe_customers')
        .select('default_payment_method_id').eq('account_id', user.id).maybeSingle();
      if (!cust?.default_payment_method_id) {
        return json({ ok: false, orderId: order.order_id, state: 'payment_method_required' }, 200);
      }
      try {
        const intent = await stripe.paymentIntents.create(
          {
            amount: order.card_amount_minor,
            currency: 'gbp',
            customer: customerId,
            payment_method: cust.default_payment_method_id,
            off_session: true,
            confirm: true,
            metadata: { payment_order_id: order.order_id, account_id: user.id },
          },
          { idempotencyKey: `order-${order.order_id}` },
        );
        // The webhook — never this response — finalises the order.
        return json({ ok: true, orderId: order.order_id, state: intent.status });
      } catch (err) {
        const stripeErr = err as { code?: string; raw?: { payment_intent?: { id?: string } } };
        if (stripeErr.code === 'authentication_required') {
          // Hosted confirmation path: a payment-mode Checkout Session for
          // the exact card shortfall (no frontend SDK needed).
          const allowed = (Deno.env.get('APP_ORIGINS') ?? 'http://localhost:5173')
            .split(',').map((s) => s.trim()).filter(Boolean);
          const requested = typeof body.origin === 'string' ? body.origin : '';
          const origin = allowed.includes(requested) ? requested : allowed[0];
          const session = await stripe.checkout.sessions.create(
            {
              mode: 'payment',
              customer: customerId,
              line_items: [{
                price_data: {
                  currency: 'gbp', unit_amount: order.card_amount_minor,
                  product_data: { name: 'Conversation request' },
                },
                quantity: 1,
              }],
              payment_intent_data: { metadata: { payment_order_id: order.order_id } },
              metadata: { payment_order_id: order.order_id },
              success_url: `${origin}/#/conversations?payment=success`,
              cancel_url: `${origin}/#/conversations?payment=cancelled`,
            },
            { idempotencyKey: `order-session-${order.order_id}` },
          );
          return json({ ok: true, orderId: order.order_id, state: 'requires_action', url: session.url });
        }
        // Card declined etc. → release the reservation via finalisation.
        await admin.rpc('finalize_paid_order', {
          p_order: order.order_id, p_outcome: 'failed', p_intent: null,
        });
        return json({ ok: false, orderId: order.order_id, state: 'failed' }, 200);
      }
    }

    // ---------- 2G3: Stripe Connect onboarding (Companions) ----------
    // Safe status projection — never bank/identity data (Stripe holds it).
    const safeConnectStatus = (row: Record<string, unknown> | null) => row && ({
      hasAccount: true,
      detailsSubmitted: Boolean(row.details_submitted),
      payoutsEnabled: Boolean(row.payouts_enabled),
      transfersCapability: String(row.transfers_capability ?? 'inactive'),
      requirementsDue: (row.requirements_due as string[]) ?? [],
      requirementsPastDue: (row.requirements_past_due as string[]) ?? [],
      disabledReason: (row.disabled_reason as string | null) ?? null,
      lastSyncedAt: (row.last_synced_at as string | null) ?? null,
      ready: Boolean(row.payouts_enabled) && row.transfers_capability === 'active' && Boolean(row.details_submitted),
    });

    // The caller's OWN companion profile (owner access) — the only person
    // who may create or view their Connect account.
    async function callerCompanionProfile(): Promise<string | null> {
      const { data } = await authed
        .from('profile_access')
        .select('profile_id, access_role, profiles!inner(role)')
        .eq('account_id', user!.id)
        .eq('access_role', 'owner');
      const row = (data ?? []).find((r: { profiles?: { role?: string } }) => r.profiles?.role === 'companion');
      return row ? (row as { profile_id: string }).profile_id : null;
    }

    async function ensureConnectAccount(): Promise<{ stripeAccountId: string } | { error: string }> {
      const companionProfileId = await callerCompanionProfile();
      if (!companionProfileId) return { error: 'not_companion' };
      const { data: existing } = await admin
        .from('connected_accounts').select('stripe_account_id').eq('account_id', user!.id).maybeSingle();
      if (existing?.stripe_account_id) return { stripeAccountId: existing.stripe_account_id };
      // Express, GB/GBP, transfers capability only — the platform charges
      // customers; transfers to Companions come in a later phase.
      const account = await stripe.accounts.create(
        {
          type: 'express',
          country: 'GB',
          default_currency: 'gbp',
          capabilities: { transfers: { requested: true } },
          metadata: { account_id: user!.id, companion_profile_id: companionProfileId },
        },
        { idempotencyKey: `connect-${user!.id}` },
      );
      await admin.from('connected_accounts').upsert({
        account_id: user!.id,
        companion_profile_id: companionProfileId,
        stripe_account_id: account.id,
        account_type: 'express',
        country: 'GB',
        default_currency: 'gbp',
        onboarding_started_at: new Date().toISOString(),
      }, { onConflict: 'account_id' });
      return { stripeAccountId: account.id };
    }

    async function syncConnectStatus(stripeAccountId: string) {
      const acct = await stripe.accounts.retrieve(stripeAccountId);
      const update = {
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
      await admin.from('connected_accounts').update(update).eq('stripe_account_id', stripeAccountId);
      return update;
    }

    if (action === 'ensure_connect_account') {
      const made = await ensureConnectAccount();
      if ('error' in made) return json({ error: made.error }, 200);
      return json({ ok: true });
    }

    if (action === 'create_connect_onboarding_link') {
      const made = await ensureConnectAccount();
      if ('error' in made) return json({ error: made.error }, 200);
      const allowed = (Deno.env.get('APP_ORIGINS') ?? 'http://localhost:5173')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const requested = typeof body.origin === 'string' ? body.origin : '';
      const origin = allowed.includes(requested) ? requested : allowed[0];
      // Account Links are short-lived and single-use by Stripe design; an
      // expired link is simply regenerated here ("Continue setup").
      const link = await stripe.accountLinks.create({
        account: made.stripeAccountId,
        refresh_url: `${origin}/#/settings?connect=refresh`,
        return_url: `${origin}/#/settings?connect=return`,
        type: 'account_onboarding',
      });
      return json({ ok: true, url: link.url });
    }

    if (action === 'get_connect_status') {
      const { data: row } = await admin
        .from('connected_accounts').select('*').eq('account_id', user.id).maybeSingle();
      return json({ ok: true, status: row ? safeConnectStatus(row) : { hasAccount: false } });
    }

    if (action === 'refresh_connect_status') {
      // The redirect back is NEVER proof — this retrieves from Stripe.
      const { data: row } = await admin
        .from('connected_accounts').select('stripe_account_id').eq('account_id', user.id).maybeSingle();
      if (!row?.stripe_account_id) return json({ ok: true, status: { hasAccount: false } });
      await syncConnectStatus(row.stripe_account_id);
      const { data: fresh } = await admin
        .from('connected_accounts').select('*').eq('account_id', user.id).maybeSingle();
      return json({ ok: true, status: safeConnectStatus(fresh as Record<string, unknown>) });
    }

    if (action === 'payment_state') {
      const { data: row } = await authed.from('payment_orders')
        .select('id, status, card_amount_minor, credit_applied_minor, total_minor')
        .eq('id', body.orderId).maybeSingle();
      return json({ ok: true, order: row ?? null });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    return json({ error: 'stripe_error', detail: e instanceof Error ? e.message : 'unknown' }, 200);
  }
});
