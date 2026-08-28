/**
 * create-membership-checkout — starts a new membership by charging the £25
 * starter week via Stripe Checkout (mode=payment). On success the membership
 * webhook creates the recurring subscription (begins 7 days later) and issues the
 * 3 starter credits.
 *
 * Auth: the signed-in Member or the Coordinator acting for the member.
 * Requires env: STRIPE_SECRET_KEY, STRIPE_PRICE_MONTHLY (recurring £100 / 28 days),
 * APP_ORIGINS. Returns a Checkout URL.
 *
 *   supabase functions deploy create-membership-checkout
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17';
import { stripeKeyAllowed } from '../_shared/stripeMode.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const STARTER_MINOR = 2500;   // £25.00 starter week (3 credits)

function resolveOrigin(requested: string): string {
  const allowed = (Deno.env.get('APP_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) {
    if (requested.startsWith('http://localhost')) return requested;
    throw new Error('app_origins_unconfigured');
  }
  return allowed.includes(requested) ? requested : allowed[0];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
  const secretKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
  if (!stripeKeyAllowed(secretKey)) return json({ error: 'stripe_not_configured' }, 503);
  const monthlyPrice = Deno.env.get('STRIPE_PRICE_MONTHLY') ?? '';
  if (!monthlyPrice) return json({ error: 'price_not_configured', detail: 'STRIPE_PRICE_MONTHLY missing' }, 503);

  // Authenticate the caller.
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorised' }, 401);
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: 'unauthorised' }, 401);
  const account = userData.user.id;

  let body: { member_profile_id?: string; origin?: string };
  try { body = await req.json(); } catch { body = {}; }
  const memberProfile = body.member_profile_id ?? '';
  if (!memberProfile) return json({ error: 'member_profile_required' }, 400);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // The caller must own or coordinate this member profile.
  const { data: access } = await admin.from('profile_access')
    .select('account_id').eq('profile_id', memberProfile).eq('account_id', account).maybeSingle();
  if (!access) return json({ error: 'forbidden' }, 403);

  // Guard: no existing live membership.
  const { data: existing } = await admin.from('memberships')
    .select('id,status').eq('member_profile_id', memberProfile)
    .in('status', ['pending', 'starter', 'active', 'past_due', 'paused']).maybeSingle();
  if (existing) return json({ error: 'already_member', detail: 'This member already has a membership.' }, 409);

  const stripe = new Stripe(secretKey, { apiVersion: '2024-06-20' });
  let origin: string;
  try { origin = resolveOrigin(body.origin ?? req.headers.get('origin') ?? ''); }
  catch { return json({ error: 'app_origins_unconfigured' }, 503); }

  // Reuse a customer for this payer if one exists on any of their memberships.
  const { data: priorCust } = await admin.from('memberships')
    .select('stripe_customer_id').eq('payer_account_id', account)
    .not('stripe_customer_id', 'is', null).limit(1).maybeSingle();
  let customerId = priorCust?.stripe_customer_id ?? null;
  if (!customerId) {
    const cust = await stripe.customers.create({ metadata: { account_id: account } });
    customerId = cust.id;
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'gbp',
        unit_amount: STARTER_MINOR,
        product_data: { name: 'Apricoti starter week — 3 call credits' },
      },
    }],
    // The subscription that follows is created by the webhook after this succeeds.
    metadata: {
      kind: 'membership_starter',
      member_profile_id: memberProfile,
      payer_account_id: account,
      monthly_price: monthlyPrice,
    },
    payment_intent_data: { metadata: { kind: 'membership_starter', member_profile_id: memberProfile } },
    success_url: `${origin}/#/?membership=started`,
    cancel_url: `${origin}/#/?membership=cancelled`,
    // Per-attempt idempotency key: a stable key collides once a session exists,
    // so each checkout attempt gets a fresh one (creating a new session is safe).
  }, { idempotencyKey: `membership-starter-${memberProfile}-${Date.now()}` });

  return json({ ok: true, url: session.url, session_id: session.id });
  } catch (e) {
    // Always return with CORS headers so the browser sees a real error, not a CORS failure.
    return json({ error: 'checkout_failed', detail: (e as Error).message }, 500);
  }
});
