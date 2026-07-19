/**
 * 2G3 — Companion "Payments and earnings" panel (Settings).
 *
 * All sensitive collection happens on Stripe's hosted onboarding; this
 * panel only shows safe status and opens Account Links. Returning from
 * Stripe triggers a server refresh — the redirect itself proves nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Landmark, Loader2 } from 'lucide-react';
import {
  createConnectOnboardingLink,
  getConnectStatus,
  type ConnectStatus,
} from '../repositories/billingRepository';

type Headline = 'loading' | 'not_started' | 'incomplete' | 'in_review' | 'ready' | 'restricted';

function headlineOf(s: ConnectStatus | null): Headline {
  if (s === null) return 'loading';
  if (!s.hasAccount) return 'not_started';
  if (s.disabledReason) return 'restricted';
  if (s.ready) return 'ready';
  if (s.detailsSubmitted) {
    return (s.requirementsDue?.length ?? 0) > 0 ? 'incomplete' : 'in_review';
  }
  return 'incomplete';
}

const COPY: Record<Exclude<Headline, 'loading'>, { title: string; body: string; action?: string }> = {
  not_started: {
    title: 'Set up payments',
    body: 'You need to complete Stripe’s secure setup before accepting paid conversations.',
    action: 'Set up payments',
  },
  incomplete: {
    title: 'Continue setup',
    body: 'Stripe still needs some information.',
    action: 'Continue setup',
  },
  in_review: {
    title: 'Verification in progress',
    body: 'Stripe is reviewing your information.',
  },
  ready: {
    title: 'Ready to receive earnings',
    body: 'Your payment account is ready. Earnings will become available after eligible conversations are completed.',
  },
  restricted: {
    title: 'Payments restricted',
    body: 'Your payment account needs attention.',
    action: 'Continue setup',
  },
};

export function ConnectPanel() {
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  const [params, setParams] = useSearchParams();

  const load = useCallback((refresh: boolean) => {
    getConnectStatus(refresh).then(setStatus);
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  // Back from Stripe: refresh from the SERVER (webhooks + retrieval decide).
  useEffect(() => {
    const flag = params.get('connect');
    if (!flag) return;
    setConfirming(true);
    getConnectStatus(true).then((s) => {
      setStatus(s);
      setConfirming(false);
    });
    const next = new URLSearchParams(params);
    next.delete('connect');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const openOnboarding = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const url = await createConnectOnboardingLink();
    if (url) {
      window.location.href = url; // Stripe-hosted Express onboarding
      return;
    }
    setFailed(true);
    setBusy(false);
  };

  const headline = headlineOf(status);

  return (
    <section className="card col" style={{ gap: 10 }} aria-label="Payments and earnings">
      <div className="row between wrap" style={{ gap: 8 }}>
        <h3 style={{ margin: 0 }}>Payments and earnings</h3>
        <span className="pill pill-info">Stripe test mode</span>
      </div>

      {headline === 'loading' ? (
        <span className="row" style={{ gap: 8 }}>
          <Loader2 size={16} aria-hidden="true" />
          <span className="muted small">Checking your payment account…</span>
        </span>
      ) : (
        <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
          <Landmark size={18} aria-hidden="true" />
          <div className="col" style={{ gap: 4, minWidth: 0 }}>
            <span className="bold small">
              {COPY[headline].title}
              {headline === 'ready' && <span className="pill pill-ready" style={{ marginLeft: 8 }}>Ready</span>}
              {headline === 'restricted' && <span className="pill pill-blocked" style={{ marginLeft: 8 }}>Restricted</span>}
            </span>
            <span className="muted small">{COPY[headline].body}</span>
            {headline === 'restricted' && status?.disabledReason && (
              <span className="muted small">Reason: {status.disabledReason.replace(/[._]/g, ' ')}</span>
            )}
            {headline === 'incomplete' && (status?.requirementsDue?.length ?? 0) > 0 && (
              <span className="faint small">
                {status!.requirementsDue!.length} item{status!.requirementsDue!.length === 1 ? '' : 's'} still needed on Stripe’s secure form.
              </span>
            )}
            {confirming && (
              <span className="small" role="status">Stripe is confirming your account…</span>
            )}
          </div>
        </div>
      )}

      {failed && (
        <p className="small" role="alert" style={{ margin: 0, color: 'var(--color-danger-text)' }}>
          We couldn’t open Stripe’s setup just now. Please try again.
        </p>
      )}

      {headline !== 'loading' && COPY[headline].action && (
        <button
          className="btn btn-primary btn-small"
          style={{ alignSelf: 'flex-start' }}
          disabled={busy}
          onClick={() => void openOnboarding()}
        >
          {busy ? 'Opening Stripe…' : COPY[headline].action}
        </button>
      )}
      <p className="faint small" style={{ margin: 0 }}>
        Bank and identity details are collected only by Stripe’s secure pages —
        this app never sees or stores them.
      </p>
    </section>
  );
}
