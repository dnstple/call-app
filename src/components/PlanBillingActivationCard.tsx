/**
 * 2G5B — coordinator billing-activation step.
 *
 * A plan becomes billing_enabled ONLY when the coordinator (payer) explicitly
 * activates monthly billing here — acceptance by the companion alone never
 * starts charging. Activation is server-enforced (accepted plan + usable saved
 * payment method); a missing card routes to add one. Renders only on the
 * coordinator side of an accepted, not-yet-billed plan in Supabase mode.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CreditCard, Loader2 } from 'lucide-react';
import { isSupabaseMode } from '../config/dataMode';
import { activatePlanBilling, PlanBillingError } from '../repositories/planBillingRepository';

export function PlanBillingActivationCard({ planId, active, billingEnabled, onActivated }: {
  planId: string;
  active: boolean;
  billingEnabled: boolean;
  onActivated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsCard, setNeedsCard] = useState(false);

  if (!isSupabaseMode() || !active || billingEnabled) return null;

  const activate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNeedsCard(false);
    try {
      await activatePlanBilling(planId);
      onActivated();
    } catch (e) {
      if (e instanceof PlanBillingError && e.message.toLowerCase().includes('payment method')) {
        setNeedsCard(true);
      } else {
        setError(e instanceof PlanBillingError ? e.message : 'That didn’t work. Please try again.');
      }
      setBusy(false);
    }
  };

  return (
    <section className="card col" style={{ gap: 8 }} aria-label="Set up monthly billing">
      <div className="row" style={{ gap: 8 }}>
        <CreditCard size={18} aria-hidden="true" />
        <h2 style={{ margin: 0, fontSize: '1.05em' }}>Accepted — set up monthly billing</h2>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Your companion accepted this plan. Billing runs each calendar month for the conversations
        scheduled that month, with a 10% monthly-plan discount. Account credit is applied first;
        only any remainder is charged to your card. No conversations are funded until billing is on.
      </p>
      {needsCard ? (
        <div className="banner banner-danger col" style={{ gap: 8 }} role="note">
          <span>You need a saved payment method before enabling billing.</span>
          <Link to="/settings" className="btn btn-primary btn-small" style={{ alignSelf: 'flex-start' }}>
            Add a payment method
          </Link>
        </div>
      ) : (
        <>
          {error && <p className="small" role="alert" style={{ margin: 0, color: 'var(--color-danger-text)' }}>{error}</p>}
          <button className="btn btn-primary btn-small" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => void activate()}>
            {busy ? <Loader2 size={14} aria-hidden="true" /> : null} Activate monthly billing
          </button>
        </>
      )}
    </section>
  );
}
