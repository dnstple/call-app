/**
 * 2G5A — read-only recurring-billing estimate for a conversation plan.
 *
 * Coordinator-side only. Shows the upcoming monthly period priced entirely by
 * the server (occurrences × price − 10% monthly discount, with account credit
 * applied before any card amount). No money is moved here — the charge engine
 * is 2G5B. Self-hides outside Supabase mode or when the server declines.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, CalendarClock, CheckCircle2, Loader2 } from 'lucide-react';
import { isSupabaseMode } from '../config/dataMode';
import { formatMinor } from '../repositories/availabilityRepository';
import {
  completePlanBillingPeriod,
  currentMonthStart,
  getPlanBillingPeriods,
  getPlanBillingPreview,
  PlanBillingError,
  type PlanBillingPeriod,
  type PlanBillingPreview,
} from '../repositories/planBillingRepository';

function monthLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

export function PlanBillingPreviewCard({ planId }: { planId: string }) {
  const [preview, setPreview] = useState<PlanBillingPreview | null>(null);
  const [period, setPeriod] = useState<PlanBillingPeriod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [completing, setCompleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSupabaseMode()) return;
    let live = true;
    setLoading(true);
    setError(null);
    Promise.all([
      getPlanBillingPreview(planId, currentMonthStart()),
      getPlanBillingPeriods(planId).catch(() => [] as PlanBillingPeriod[]),
    ])
      .then(([p, periods]) => {
        if (!live) return;
        setPreview(p);
        setPeriod(periods[0] ?? null); // most recent (sorted desc server-side)
      })
      .catch((e) => live && setError(e instanceof PlanBillingError ? e.message : 'We couldn’t load the estimate.'))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [planId]);

  const completePayment = async () => {
    if (!period?.paymentOrderId || completing) return;
    setCompleting(true);
    setActionError(null);
    try {
      const { url } = await completePlanBillingPeriod(period.paymentOrderId);
      window.location.href = url; // Stripe-hosted confirmation
    } catch (e) {
      setActionError(e instanceof PlanBillingError ? e.message : 'That didn’t work. Please try again.');
      setCompleting(false);
    }
  };

  if (!isSupabaseMode()) return null;

  if (loading) {
    return (
      <section className="card row" style={{ gap: 10 }} aria-label="Monthly billing estimate">
        <Loader2 size={18} aria-hidden="true" />
        <span className="muted">Estimating this month’s billing…</span>
      </section>
    );
  }
  // A declined/unavailable estimate simply doesn't render (never a fake value).
  if (error || !preview) return null;

  const p = preview;
  return (
    <section className="card col" style={{ gap: 8 }} aria-label="Monthly billing estimate">
      <div className="row" style={{ gap: 8 }}>
        <CalendarClock size={18} aria-hidden="true" />
        <h2 style={{ margin: 0, fontSize: '1.05em' }}>Estimated billing · {monthLabel(p.periodStart)}</h2>
      </div>
      <div className="col" style={{ gap: 4 }}>
        <div className="row between">
          <span className="muted">{p.occurrences} conversation{p.occurrences === 1 ? '' : 's'} × {formatMinor(p.perConversationMinor, p.currency)}</span>
          <span>{formatMinor(p.grossMinor, p.currency)}</span>
        </div>
        <div className="row between">
          <span className="muted">Monthly discount ({p.discountPct}%)</span>
          <span>−{formatMinor(p.discountMinor, p.currency)}</span>
        </div>
        {p.creditAppliedMinor > 0 && (
          <div className="row between">
            <span className="muted">Account credit applied</span>
            <span>−{formatMinor(p.creditAppliedMinor, p.currency)}</span>
          </div>
        )}
        <div className="row between" style={{ borderTop: '1px solid var(--color-border)', paddingTop: 4 }}>
          <span className="bold">Estimated card amount</span>
          <span className="bold">{formatMinor(p.cardAmountMinor, p.currency)}</span>
        </div>
      </div>
      {period?.status === 'paid' && (
        <div className="row" style={{ gap: 8 }}>
          <CheckCircle2 size={16} aria-hidden="true" style={{ color: 'var(--color-success-text)' }} />
          <span className="muted small">This month’s plan is paid and funded.</span>
        </div>
      )}
      {period?.status === 'payment_pending' && (
        <span className="muted small">This month’s payment is being processed.</span>
      )}
      {period?.status === 'action_required' && period.paymentOrderId && (
        <div className="banner banner-danger col" style={{ gap: 8 }} role="note">
          <span className="row" style={{ gap: 8 }}>
            <AlertTriangle size={16} aria-hidden="true" /> Action needed to fund this month’s conversations.
          </span>
          {actionError && <span className="small" role="alert">{actionError}</span>}
          <button className="btn btn-primary btn-small" style={{ alignSelf: 'flex-start' }} disabled={completing} onClick={() => void completePayment()}>
            {completing ? <Loader2 size={14} aria-hidden="true" /> : null} Complete payment
          </button>
        </div>
      )}
      {period?.status === 'payment_failed' && (
        <span className="small" style={{ color: 'var(--color-danger-text)' }}>
          Last payment didn’t go through — we’ll retry, or update your payment method in Settings.
        </span>
      )}

      <p className="faint small" style={{ margin: 0 }}>
        Estimate only — from your current weekly schedule. No payment is taken yet.
      </p>
    </section>
  );
}
