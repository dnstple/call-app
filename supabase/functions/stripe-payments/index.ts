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

// ---- Stage 3D-B1: central return-URL policy (audit §13/§15) ----------------
// FAIL CLOSED: outside local development the APP_ORIGINS secret MUST be set —
// there is no silent localhost fallback in hosted environments. The only
// unset-env allowance is a browser origin that is itself localhost (dev).
const resolveReturnOrigin = (requested: string): string => {
  const allowed = (Deno.env.get('APP_ORIGINS') ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) {
    if (requested.startsWith('http://localhost')) return requested; // dev only
    throw new Error('app_origins_unconfigured');
  }
  return allowed.includes(requested) ? requested : allowed[0];
};
// Stage 3D-C return-route contract (the client implements this route):
//   <origin>/#/payment/return?order=<payment_order_id>&outcome=success|cancelled
// Only the safe local order id travels in the URL — never secrets or intents.
const paymentReturnUrls = (origin: string, orderId: string) => ({
  success_url: `${origin}/#/payment/return?order=${orderId}&outcome=success`,
  cancel_url: `${origin}/#/payment/return?order=${orderId}&outcome=cancelled`,
});

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
      // Return URLs derive ONLY from the allowlisted app origin (3D-B1
      // central fail-closed policy; the setup return keeps its existing
      // /#/settings?setup=… contract that BillingPanel already handles).
      const origin = resolveReturnOrigin(typeof body.origin === 'string' ? body.origin : '');
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
      // Hosted confirmation path (3D-B1: shared by BOTH requires-action
      // shapes): a payment-mode Checkout Session for the exact card
      // shortfall (no frontend SDK needed).
      const createAuthenticationSession = async () => {
        const requested = typeof body.origin === 'string' ? body.origin : '';
        const origin = resolveReturnOrigin(requested);
        const urls = paymentReturnUrls(origin, order.order_id);
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
            success_url: urls.success_url,
            cancel_url: urls.cancel_url,
          },
          { idempotencyKey: `order-session-${order.order_id}` },
        );
        await admin.rpc('reconcile_payment_order', {
          p_order: order.order_id, p_intent: null, p_provider_status: 'requires_action',
          p_amount_minor: null, p_currency: null, p_event_at: null, p_metadata_order: null,
        });
        return session.url;
      };
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
        if (intent.status === 'requires_action' || intent.status === 'requires_confirmation') {
          // 3D-B1 uniform contract: EVERY authentication requirement returns
          // a hosted continuation URL (audit §6.1). The superseded direct
          // intent is cancelled so exactly one live provider object can fund
          // this order.
          try { await stripe.paymentIntents.cancel(intent.id); } catch { /* already terminal */ }
          const url = await createAuthenticationSession();
          return json({ ok: true, orderId: order.order_id, state: 'requires_action', url });
        }
        // Server-observed projection (webhooks stay authoritative; a
        // synchronous provider success finalises via the SAME shared
        // reconcile path the webhook uses — never from browser assertions).
        await admin.rpc('reconcile_payment_order', {
          p_order: order.order_id, p_intent: intent.id, p_provider_status: intent.status,
          p_amount_minor: intent.status === 'succeeded' ? (intent.amount_received ?? intent.amount) : null,
          p_currency: intent.status === 'succeeded' ? intent.currency : null,
          p_event_at: null, p_metadata_order: null,
        });
        return json({ ok: true, orderId: order.order_id, state: intent.status });
      } catch (err) {
        const stripeErr = err as { code?: string; raw?: { payment_intent?: { id?: string } } };
        if (stripeErr.code === 'authentication_required') {
          const url = await createAuthenticationSession();
          return json({ ok: true, orderId: order.order_id, state: 'requires_action', url });
        }
        // Card declined etc. → release the reservation via finalisation.
        await admin.rpc('finalize_paid_order', {
          p_order: order.order_id, p_outcome: 'failed', p_intent: null,
        });
        return json({ ok: false, orderId: order.order_id, state: 'failed' }, 200);
      }
    }

    if (action === 'check_payment_order') {
      // ---- Stage 3D-B1: backend for the future “Check payment status” ----
      // Input is ONLY the local order id. The stored provider identifiers are
      // the sole lookup authority — an arbitrary client-supplied
      // PaymentIntent id is never accepted, nothing is ever (re)charged and
      // no provider object is ever created here. Repeats are idempotent.
      const orderId = typeof body.orderId === 'string' ? body.orderId : '';
      if (!orderId) return json({ error: 'not_found' }, 200);
      const { data: ord } = await admin.from('payment_orders')
        .select('id, coordinator_account_id, card_amount_minor, status, stripe_payment_intent_id, stripe_checkout_session_id')
        .eq('id', orderId).maybeSingle();
      if (!ord || ord.coordinator_account_id !== user.id) {
        return json({ error: 'not_found' }, 200); // neutral — no existence leak
      }
      // Credit-only orders have no provider object; live card orders resolve
      // the intent stored for THIS order (directly, or via its own session).
      let intentId = (ord.stripe_payment_intent_id as string | null) ?? null;
      if (!intentId && ord.stripe_checkout_session_id && ord.card_amount_minor > 0) {
        const session = await stripe.checkout.sessions.retrieve(ord.stripe_checkout_session_id);
        intentId = typeof session.payment_intent === 'string' ? session.payment_intent : null;
      }
      if (intentId && ord.card_amount_minor > 0) {
        const pi = await stripe.paymentIntents.retrieve(intentId);
        const linked = typeof pi.metadata?.payment_order_id === 'string'
          ? pi.metadata.payment_order_id : null;
        await admin.rpc('reconcile_payment_order', {
          p_order: ord.id,
          p_intent: pi.id,
          p_provider_status: pi.status,
          p_amount_minor: pi.status === 'succeeded' ? (pi.amount_received ?? pi.amount) : null,
          p_currency: pi.status === 'succeeded' ? pi.currency : null,
          p_event_at: null,
          p_metadata_order: linked,
        });
      }
      const { data: status } = await authed.rpc('get_payment_order_status', { p_order: orderId });
      return json({ ok: true, status });
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
      // 3D-B1 central fail-closed origin policy (Connect return keeps its
      // existing /#/settings?connect=… contract).
      const origin = resolveReturnOrigin(typeof body.origin === 'string' ? body.origin : '');
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
