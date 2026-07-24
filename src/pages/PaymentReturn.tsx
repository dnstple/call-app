/**
 * Stage 3D-C — payment authentication return route (/payment/return).
 *
 * Landing point for Stripe-hosted bank-authentication returns:
 *   /#/payment/return?order=<payment_order_id>&outcome=success|cancelled
 *
 * The `outcome` parameter is NEVER financial authority — it only shapes the
 * first interim wording. The durable server projection (owner-safe RPC, then
 * an explicit check_payment_order for recoverable orders) decides everything.
 * This page never creates a PaymentIntent and never restarts checkout.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import PaymentStatusCard from '../components/PaymentStatusCard';
import { checkPaymentOrder } from '../repositories/billingRepository';
import {
  isValidOrderId,
  loadPaymentSession,
  savePaymentSession,
  type PaymentRecoverySession,
} from '../payments/paymentSession';
import { isSupabaseMode } from '../config/dataMode';
import { getSupabaseClient } from '../supabase/client';

export default function PaymentReturn() {
  const [params] = useSearchParams();
  const orderParam = params.get('order') ?? '';
  const outcome = params.get('outcome') ?? '';
  const [authState, setAuthState] = useState<'checking' | 'signed_in' | 'signed_out'>('checking');
  const checkedOnce = useRef(false);

  // Restore/refresh the durable local session from the return parameters.
  const session: PaymentRecoverySession | null = useMemo(() => {
    if (!isValidOrderId(orderParam)) return null;
    const existing = loadPaymentSession();
    if (existing?.orderId === orderParam) return existing;
    // A valid return URL is itself safe recovery context (e.g. cleared
    // storage or another browser profile after the banking app).
    savePaymentSession({ orderId: orderParam, kind: 'one_off', returnTo: null });
    return loadPaymentSession();
  }, [orderParam]);

  useEffect(() => {
    if (!isSupabaseMode()) {
      setAuthState('signed_out');
      return;
    }
    let alive = true;
    getSupabaseClient()
      .auth.getUser()
      .then(({ data }) => {
        if (alive) setAuthState(data.user ? 'signed_in' : 'signed_out');
      })
      .catch(() => {
        if (alive) setAuthState('signed_out');
      });
    return () => {
      alive = false;
    };
  }, []);

  // One server-side recovery check on arrival: re-reads ONLY the intent
  // already stored for this order and reconciles idempotently. Signed-in
  // owners only; anything else stays read-only.
  useEffect(() => {
    if (authState !== 'signed_in' || !isValidOrderId(orderParam) || checkedOnce.current) return;
    checkedOnce.current = true;
    void checkPaymentOrder(orderParam);
  }, [authState, orderParam]);

  if (!orderParam || !isValidOrderId(orderParam)) {
    return (
      <main className="col" style={{ gap: 16, maxWidth: 560, margin: '0 auto' }} aria-live="polite">
        <div className="card" role="alert">
          <h1>Payment link problem</h1>
          <p className="muted">
            This payment link is missing its reference, so we can’t look anything up.
            Don’t worry — no payment is ever taken from this page. You can check your
            conversations to see whether your booking was confirmed.
          </p>
          <Link className="btn" to="/conversations">Return to conversations</Link>
        </div>
      </main>
    );
  }

  if (authState === 'checking') {
    return (
      <main className="col" style={{ gap: 16, maxWidth: 560, margin: '0 auto' }} aria-live="polite">
        <div className="card">
          <h1>One moment</h1>
          <p className="muted">Checking your session before we look up this payment…</p>
        </div>
      </main>
    );
  }

  if (authState === 'signed_out') {
    return (
      <main className="col" style={{ gap: 16, maxWidth: 560, margin: '0 auto' }} aria-live="polite">
        <div className="card" role="alert">
          <h1>Please sign in</h1>
          <p className="muted">
            You’ve returned from your bank’s security check, but you’re not signed in on
            this browser. Sign in and reopen this page — your payment is safe and will
            not be taken twice.
          </p>
          <Link className="btn btn-primary" to="/">Sign in</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="col" style={{ gap: 16, maxWidth: 560, margin: '0 auto' }}>
      <h1 className="visually-hidden">Payment status</h1>
      {outcome === 'cancelled' && (
        <p className="muted" role="status">
          It looks like you stopped before finishing the bank security check — checking
          the definite status with our records now.
        </p>
      )}
      <PaymentStatusCard
        orderId={orderParam}
        returnTo={
          session?.returnTo
            ? { to: session.returnTo, label: 'Return to where you were' }
            : undefined
        }
      />
    </main>
  );
}
