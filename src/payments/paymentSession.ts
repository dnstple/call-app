/**
 * Stage 3D-C — durable customer payment session.
 *
 * Persists ONLY safe local recovery data so an in-flight purchase survives
 * full-page redirects (Stripe-hosted bank authentication), banking-app
 * returns, reloads, unmounts and closing/reopening the app.
 *
 * NEVER stored here: client secrets, payment-method identifiers, raw Stripe
 * responses, card data, or anything service-role. The order id is the only
 * identifier — the server-side owner check governs everything it unlocks.
 */

export type PaymentPurchaseKind = 'one_off' | 'trial' | 'plan_period';

export interface PaymentRecoverySession {
  v: 1;
  orderId: string;
  kind: PaymentPurchaseKind;
  /** Safe navigation context only (route to return to after completion). */
  returnTo: string | null;
  createdAt: string;
  /** Last safe customer_status observed (display hint only, never authority). */
  lastState: string | null;
}

export const PAYMENT_SESSION_KEY = 'callapp.payment.session.v1';

// Payment orders expire server-side after 30 minutes; allow the customer a
// generous-but-bounded recovery window beyond that before the session is
// considered stale (bank flows can be slow).
export const PAYMENT_SESSION_MAX_AGE_MS = 90 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidOrderId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null; // storage unavailable (private mode etc.) — degrade gracefully
  }
}

export function savePaymentSession(input: {
  orderId: string;
  kind: PaymentPurchaseKind;
  returnTo?: string | null;
  lastState?: string | null;
}): void {
  const s = storage();
  if (!s || !isValidOrderId(input.orderId)) return;
  const session: PaymentRecoverySession = {
    v: 1,
    orderId: input.orderId,
    kind: input.kind,
    returnTo: input.returnTo ?? null,
    createdAt: new Date().toISOString(),
    lastState: input.lastState ?? null,
  };
  try {
    s.setItem(PAYMENT_SESSION_KEY, JSON.stringify(session));
  } catch {
    /* quota/full — recovery degrades to the return-URL order id */
  }
}

export function updatePaymentSessionState(orderId: string, lastState: string): void {
  const existing = loadPaymentSession();
  if (!existing || existing.orderId !== orderId) return;
  savePaymentSession({ ...existing, lastState });
}

/** Load + validate; malformed or stale sessions are cleared and null returned. */
export function loadPaymentSession(): PaymentRecoverySession | null {
  const s = storage();
  if (!s) return null;
  const raw = s.getItem(PAYMENT_SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PaymentRecoverySession>;
    if (
      parsed.v !== 1 ||
      !isValidOrderId(parsed.orderId) ||
      !['one_off', 'trial', 'plan_period'].includes(parsed.kind ?? '') ||
      typeof parsed.createdAt !== 'string'
    ) {
      clearPaymentSession();
      return null;
    }
    const age = Date.now() - Date.parse(parsed.createdAt);
    if (!Number.isFinite(age) || age < 0 || age > PAYMENT_SESSION_MAX_AGE_MS) {
      clearPaymentSession();
      return null;
    }
    return parsed as PaymentRecoverySession;
  } catch {
    clearPaymentSession();
    return null;
  }
}

export function clearPaymentSession(): void {
  const s = storage();
  try {
    s?.removeItem(PAYMENT_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Clear only when the purchase reached a definitive terminus. A polling
 * timeout ('confirmation_delayed') is NOT terminal — the session must survive
 * so the customer can keep checking.
 */
export function clearPaymentSessionOnTerminal(orderId: string, customerStatus: string): void {
  if (!['completed', 'failed', 'cancelled'].includes(customerStatus)) return;
  const existing = loadPaymentSession();
  if (existing && existing.orderId === orderId) clearPaymentSession();
}
