/**
 * Stage 3D-C — app-shell resume notice.
 *
 * When a durable payment recovery session exists (redirect, reload, or the
 * app was closed mid-payment), offer "Resume payment" instead of letting the
 * customer silently start another attempt. Display-only: the linked return
 * route re-derives everything from the server projection.
 */
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { loadPaymentSession } from '../payments/paymentSession';

export default function PaymentResumeNotice() {
  const location = useLocation();
  const [orderId, setOrderId] = useState<string | null>(null);

  useEffect(() => {
    // Re-evaluate on navigation; hidden on the return route itself.
    const session = loadPaymentSession();
    setOrderId(session && !location.pathname.startsWith('/payment/return') ? session.orderId : null);
  }, [location.pathname]);

  if (!orderId) return null;
  return (
    <div className="card card-tight" role="status" aria-live="polite" style={{ margin: '8px 0' }}>
      <span className="muted">A payment was still in progress when you left. </span>
      <Link className="btn" to={`/payment/return?order=${orderId}`}>
        Resume payment
      </Link>
    </div>
  );
}
