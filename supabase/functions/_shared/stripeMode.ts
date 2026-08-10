/**
 * Stripe key-mode guard (shared by every Stripe edge function).
 *
 * PRODUCTION: LIVE keys only. Test keys (sk_test_*) are no longer accepted — the
 * platform runs on live Stripe. A live key (sk_live_*) is accepted only when
 * STRIPE_LIVE_ENABLED === 'true', so real money still requires the deliberate
 * opt-in flag; anything else fails closed.
 */
export function stripeKeyAllowed(secretKey: string): boolean {
  const liveEnabled = Deno.env.get('STRIPE_LIVE_ENABLED') === 'true';
  return liveEnabled && secretKey.startsWith('sk_live_');
}
