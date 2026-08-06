/**
 * Stripe key-mode guard (shared by every Stripe edge function).
 *
 * Test keys (sk_test_*) always run — the pilot's default. A LIVE key
 * (sk_live_*) is accepted ONLY when STRIPE_LIVE_ENABLED === 'true', so real
 * money can never flow just because a live secret was set: going live also
 * requires a deliberate, explicit opt-in flag. Anything else fails closed.
 *
 * This preserves the original "no accidental live" safety while allowing a
 * controlled switch to production.
 */
export function stripeKeyAllowed(secretKey: string): boolean {
  if (secretKey.startsWith('sk_test_')) return true;
  const liveEnabled = Deno.env.get('STRIPE_LIVE_ENABLED') === 'true';
  return liveEnabled && secretKey.startsWith('sk_live_');
}
