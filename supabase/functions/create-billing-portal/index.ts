/**
 * create-billing-portal — opens Stripe's hosted Billing Portal for the signed-in
 * member so they can cancel (or manage) their subscription. Cancellation itself
 * happens on Stripe's page; the existing stripe-membership-webhook ingests the
 * result. This function only resolves the member's Stripe customer id (server
 * side, never trusting the browser) and returns a one-time portal URL.
 *
 * SELF-CONTAINED (no ../_shared imports) so it deploys from the dashboard editor.
 *   Env: STRIPE_SECRET_KEY, APP_URL.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
  const appUrl = (Deno.env.get('APP_URL') ?? '').replace(/\/+$/, '');
  if (!stripeKey) return json({ error: 'not_configured', detail: 'STRIPE_SECRET_KEY is required.' }, 503);

  // Authenticate the caller.
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorised' }, 401);
  const caller = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ error: 'unauthorised' }, 401);
  const userId = userData.user.id;

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // Resolve the caller's owned member profile → their membership's Stripe customer.
  const { data: access } = await admin
    .from('profile_access')
    .select('profile_id, profiles!inner(role)')
    .eq('account_id', userId)
    .eq('access_role', 'owner');
  const memberProfileIds = ((access ?? []) as Array<{ profile_id: string; profiles?: { role?: string } }>)
    .filter((r) => r.profiles?.role === 'member')
    .map((r) => r.profile_id);
  if (memberProfileIds.length === 0) return json({ error: 'no_membership' }, 404);

  const { data: memberships } = await admin
    .from('memberships')
    .select('stripe_customer_id, status, created_at')
    .in('member_profile_id', memberProfileIds)
    .not('stripe_customer_id', 'is', null)
    .order('created_at', { ascending: false });
  const customer = ((memberships ?? []) as Array<{ stripe_customer_id: string | null }>)
    .map((m) => m.stripe_customer_id)
    .find((c) => !!c);
  if (!customer) return json({ error: 'no_stripe_customer' }, 404);

  // Create the portal session.
  const form = new URLSearchParams();
  form.set('customer', customer);
  form.set('return_url', `${appUrl}/#/settings?sub=managed`);
  try {
    const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data as { error?: { message?: string } })?.error?.message ?? String(res.status);
      // A missing portal configuration is the usual first-time cause.
      return json({ error: 'portal_failed', detail: msg }, 200);
    }
    return json({ url: (data as { url?: string }).url ?? null });
  } catch (e) {
    return json({ error: 'portal_failed', detail: (e as Error).message }, 200);
  }
});
