/**
 * Companion payout-setup nudge. Shown at the top of Home for a companion who is
 * NOT yet payout-ready (no Stripe Connect account, or onboarding incomplete), so
 * they set up how they get paid before earnings pile up "held". All sensitive
 * collection happens on Stripe's hosted onboarding — this only reads safe status
 * and opens an Account Link. Renders nothing once payouts are enabled.
 */
import { useCallback, useEffect, useState } from 'react';
import { Landmark, Loader2, X } from 'lucide-react';
import { getConnectStatus, createConnectOnboardingLink, type ConnectStatus } from '../repositories/billingRepository';

export function CompanionPayoutPrompt() {
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let alive = true;
    void getConnectStatus().then((s) => { if (alive) setStatus(s); }).catch(() => { /* non-blocking */ });
    return () => { alive = false; };
  }, []);

  const open = useCallback(async () => {
    setOpening(true);
    try {
      const url = await createConnectOnboardingLink('/');
      if (url) { window.location.href = url; return; }
    } catch { /* fall through */ }
    setOpening(false);
  }, []);

  // Nothing to show while loading, once dismissed for the session, or once ready.
  if (status === null || dismissed || status.ready || status.payoutsEnabled) return null;

  const started = status.hasAccount && status.detailsSubmitted;
  const title = status.disabledReason
    ? 'Your payout account needs attention'
    : started
      ? 'Finish setting up payouts'
      : 'Set up how you get paid';
  const body = status.disabledReason
    ? 'Stripe needs more information before it can pay you. Finish the steps to receive your earnings.'
    : started
      ? 'Stripe still needs a little more to release your earnings — it only takes a minute.'
      : 'Connect your bank securely through Stripe so we can pay out your call earnings.';

  return (
    <div className="card" style={{ padding: '14px 16px', marginBottom: 14, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <Landmark size={18} aria-hidden="true" style={{ marginTop: 2, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div className="muted small" style={{ marginTop: 2 }}>{body}</div>
        <button className="btn btn-primary btn-small" style={{ marginTop: 10 }} disabled={opening} onClick={() => void open()}>
          {opening ? <Loader2 size={15} className="call-waiting-pulse" aria-hidden="true" /> : <Landmark size={15} aria-hidden="true" />}
          {status.hasAccount ? 'Continue setup' : 'Set up payouts'}
        </button>
      </div>
      <button
        className="btn btn-ghost btn-small"
        aria-label="Dismiss for now"
        onClick={() => setDismissed(true)}
        style={{ flexShrink: 0 }}
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
