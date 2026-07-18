/**
 * 2G1+ — Coordinator billing panel (Settings). TEST MODE clearly labelled.
 *
 * Card setup uses a Stripe-HOSTED setup-mode Checkout Session (documented
 * choice: no embedded SDK exists, so the hosted page is the smallest safe
 * surface). The redirect back merely triggers a status refresh — the
 * webhook is the proof a card was saved. Only safe summary fields (brand,
 * last4, expiry) ever reach this component.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CreditCard, Loader2, PiggyBank } from 'lucide-react';
import {
  createSetupSession,
  getBillingStatus,
  getCreditSummary,
  removePaymentMethod,
  type BillingStatus,
  type CreditSummary,
} from '../repositories/billingRepository';
import { formatMinor } from '../repositories/availabilityRepository';

type SetupPhase = 'idle' | 'redirecting' | 'completed' | 'cancelled' | 'failed';

export function BillingPanel() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [credit, setCredit] = useState<CreditSummary | null>(null);
  const [phase, setPhase] = useState<SetupPhase>('idle');
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useSearchParams();

  const refresh = useCallback(() => {
    getBillingStatus().then(setStatus);
    getCreditSummary().then(setCredit);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Returning from Stripe: refresh and show the outcome banner. The URL
  // param NEVER marks a card ready — only the webhook-updated status does.
  useEffect(() => {
    const setup = params.get('setup');
    if (!setup) return;
    setPhase(setup === 'success' ? 'completed' : 'cancelled');
    refresh();
    const next = new URLSearchParams(params);
    next.delete('setup');
    setParams(next, { replace: true });
  }, [params, setParams, refresh]);

  const startSetup = async () => {
    if (busy) return;
    setBusy(true);
    setPhase('redirecting');
    const url = await createSetupSession();
    if (url) {
      window.location.href = url; // Stripe-hosted card entry
      return;
    }
    setPhase('failed');
    setBusy(false);
  };

  const removeCard = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await removePaymentMethod();
    if (!ok) setPhase('failed');
    refresh();
    setBusy(false);
  };

  return (
    <section className="card col" style={{ gap: 10 }} aria-label="Payments and credit">
      <div className="row between wrap" style={{ gap: 8 }}>
        <h3 style={{ margin: 0 }}>Payments</h3>
        <span className="pill pill-info">Stripe test mode</span>
      </div>

      {phase === 'completed' && (
        <p className="small" role="status" style={{ margin: 0, color: 'var(--color-success-text)' }}>
          Card setup finished — confirming with Stripe…
        </p>
      )}
      {phase === 'cancelled' && (
        <p className="small muted" role="status" style={{ margin: 0 }}>
          Card setup was cancelled. Nothing was saved.
        </p>
      )}
      {phase === 'failed' && (
        <p className="small" role="alert" style={{ margin: 0, color: 'var(--color-danger-text)' }}>
          We couldn’t start card setup just now. Please try again.
        </p>
      )}

      <div className="row wrap" style={{ gap: 10 }}>
        <CreditCard size={18} aria-hidden="true" />
        {status === null ? (
          <span className="row" style={{ gap: 6 }}>
            <Loader2 size={14} aria-hidden="true" />
            <span className="muted small">Checking payment set-up…</span>
          </span>
        ) : !status.configured ? (
          <span className="muted small">
            Payments aren’t configured in this environment yet. No real money
            moves in the prototype.
          </span>
        ) : status.paymentMethodReady && status.card ? (
          <span className="col" style={{ gap: 2 }}>
            <span className="small bold">
              {status.card.brand.charAt(0).toUpperCase() + status.card.brand.slice(1)} ending in {status.card.last4}
            </span>
            <span className="muted small">
              Expires {String(status.card.expMonth).padStart(2, '0')}/{String(status.card.expYear).slice(-2)}
            </span>
          </span>
        ) : status.paymentMethodReady ? (
          <span className="small">A payment method is saved for future bookings.</span>
        ) : (
          <span className="muted small">
            No payment method saved. Add a card now, or you’ll be asked before
            your first paid conversation.
          </span>
        )}
      </div>

      {status?.configured && (
        <div className="row wrap" style={{ gap: 8 }}>
          {!status.paymentMethodReady ? (
            <button className="btn btn-primary btn-small" disabled={busy} onClick={() => void startSetup()}>
              {phase === 'redirecting' ? 'Opening Stripe…' : 'Add payment method'}
            </button>
          ) : (
            <>
              <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => void startSetup()}>
                {phase === 'redirecting' ? 'Opening Stripe…' : 'Change payment method'}
              </button>
              <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => void removeCard()}>
                Remove payment method
              </button>
            </>
          )}
        </div>
      )}

      <div className="row" style={{ gap: 10 }}>
        <PiggyBank size={18} aria-hidden="true" />
        <span className="small">
          Account credit:{' '}
          <strong>{formatMinor(credit?.availableMinor ?? 0)}</strong>
          {credit && credit.expiringNextMinor > 0 && credit.expiringNextAt && (
            <span className="muted">
              {' '}· {formatMinor(credit.expiringNextMinor)} expires{' '}
              {new Date(credit.expiringNextAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
            </span>
          )}
        </span>
      </div>
      <p className="faint small" style={{ margin: 0 }}>
        Cards are entered on Stripe’s secure page — we never see or store your
        card number. Credit is applied automatically before your card, works
        for any of your Members with any Companion, and lasts 12 months.
      </p>
    </section>
  );
}
