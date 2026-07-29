/**
 * Stage 3D-C — shared durable payment status card.
 *
 * Renders the honest customer state for one payment order, polls the safe
 * server projection with BOUNDED backoff (UX aid only — webhooks remain the
 * financial authority), and offers "Check payment status" once polling rests.
 * Never creates provider objects; never treats browser state as proof.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  checkPaymentOrder,
  getPaymentOrderStatus,
  type PaymentOrderStatusProjection,
} from '../repositories/billingRepository';
import {
  clearPaymentSessionOnTerminal,
  updatePaymentSessionState,
} from '../payments/paymentSession';
import { canOfferRetry, paymentStatusView } from '../payments/paymentStatus';

// Bounded polling: 1.5 s → 3 s → 5 s steps, hard stop ≈ 2 minutes.
const POLL_STEPS_MS = [1500, 1500, 1500, 1500, 3000, 3000, 3000, 3000, 5000];
const POLL_MAX_ELAPSED_MS = 120_000;

// Terminal-for-polling states (customer-terminal OR requires manual action).
const POLL_STOP = new Set([
  'completed', 'failed', 'cancelled', 'reconciliation_required',
  'awaiting_payment_method', 'awaiting_bank_authentication',
]);

export interface PaymentStatusCardProps {
  orderId: string;
  /** Optional retry action, shown ONLY in server-confirmed non-success states. */
  onRetry?: () => void;
  /** Optional label override for the primary return link. */
  returnTo?: { to: string; label: string };
}

export default function PaymentStatusCard({ orderId, onRetry, returnTo }: PaymentStatusCardProps) {
  const [projection, setProjection] = useState<PaymentOrderStatusProjection | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [checking, setChecking] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);

  const applyProjection = useCallback((p: PaymentOrderStatusProjection) => {
    if (!alive.current) return;
    if (!p.found) {
      setNotFound(true);
      return;
    }
    setNotFound(false);
    setProjection(p);
    if (p.customerStatus) {
      updatePaymentSessionState(orderId, p.customerStatus);
      clearPaymentSessionOnTerminal(orderId, p.customerStatus);
    }
  }, [orderId]);

  // Bounded backoff poll; overlap-guarded; cancelled on unmount; transient
  // network errors are tolerated (the next tick simply retries).
  useEffect(() => {
    alive.current = true;
    let step = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    let lastStatus: string | null = null;

    const tick = async () => {
      if (!alive.current || inFlight.current) return schedule();
      inFlight.current = true;
      try {
        const p = await getPaymentOrderStatus(orderId);
        if (p.found) lastStatus = p.customerStatus ?? null;
        applyProjection(p);
      } catch {
        /* transient error — keep polling within the budget */
      } finally {
        inFlight.current = false;
      }
      if (!alive.current) return;
      if (lastStatus && POLL_STOP.has(lastStatus)) return; // rest — terminal or manual state
      if (Date.now() - startedAt >= POLL_MAX_ELAPSED_MS) {
        // Timeout is NEVER treated as failure: it becomes the delayed state.
        setTimedOut(true);
        return;
      }
      schedule();
    };
    const schedule = () => {
      const delay = POLL_STEPS_MS[Math.min(step, POLL_STEPS_MS.length - 1)];
      step += 1;
      timer = setTimeout(tick, delay);
    };
    void tick();
    return () => {
      alive.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [orderId, applyProjection]);

  const runCheck = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    try {
      const p = await checkPaymentOrder(orderId);
      applyProjection(p);
      if (p.found && p.customerStatus && !POLL_STOP.has(p.customerStatus)) setTimedOut(true);
      else setTimedOut(false);
    } finally {
      if (alive.current) setChecking(false);
    }
  }, [orderId, checking, applyProjection]);

  if (notFound) {
    return (
      <div className="card" role="alert">
        <h2>We couldn’t find this payment</h2>
        <p className="muted">
          This payment link doesn’t match a payment on your account. If you were signed
          out, sign in and open the link again. No payment is taken from this page.
        </p>
        <Link className="btn" to="/conversations">Return to conversations</Link>
      </div>
    );
  }

  const status = projection?.customerStatus ?? null;
  // A polling timeout on a provider-succeeded-but-unconfirmed order presents
  // as confirmation_delayed; on anything else it keeps the honest live state.
  const displayStatus =
    timedOut && status === 'payment_received_confirming' ? 'confirmation_delayed' : status;
  const view = paymentStatusView(displayStatus);
  const showCheck = (view.canCheck || timedOut) && displayStatus !== 'completed';
  const showRetry = Boolean(onRetry) && canOfferRetry(status) && projection !== null;

  return (
    <div className="card" aria-live="polite" aria-busy={view.busy}>
      <h2>{view.title}</h2>
      <p className="muted">{view.message}</p>
      {view.busy && (
        <p className="muted" role="status">
          Checking automatically — you can safely keep this page open.
        </p>
      )}
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        {showCheck && (
          <button className="btn" type="button" disabled={checking} onClick={() => void runCheck()}>
            {checking ? 'Checking…' : 'Check payment status'}
          </button>
        )}
        {displayStatus === 'completed' && projection?.bookingId && (
          <Link className="btn btn-primary" to={`/bookings/${projection.bookingId}`}>
            View your confirmed conversation
          </Link>
        )}
        {showRetry && (
          <button className="btn" type="button" onClick={onRetry}>
            Try payment again
          </button>
        )}
        <Link className="btn" to={returnTo?.to ?? '/conversations'}>
          {returnTo?.label ?? 'Return to conversations'}
        </Link>
      </div>
    </div>
  );
}
