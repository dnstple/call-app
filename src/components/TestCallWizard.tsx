/**
 * Trial-conversation journey (formerly "test call").
 *
 * 2G2 fix: this dedicated trial wizard predated paid requests and still
 * called createBookingRequest with prototype-payment copy in EVERY mode.
 * Supabase mode now runs the REAL paid flow — quote_paid_request summary,
 * credit-first funding, saved card shortfall, webhook-confirmed funding —
 * while mock mode keeps its clearly-simulated prototype step. Shared UI
 * receives the payment mode explicitly via isSupabaseMode(); a quote
 * failure shows an honest error + retry and NEVER falls back to an
 * unpaid booking.
 *
 * User-facing term everywhere: "Trial conversation".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, Sparkles } from 'lucide-react';
import type { ConversationOfferRow } from '../supabase/database.types';
import type { User } from '../types';
import {
  createBookingRequest,
  getAvailableSlots,
  IN_APP_METHOD,
  type AvailableSlot,
} from '../repositories/bookingRepository';
import {
  createPaidRequest,
  getPaymentOrderState,
  quotePaidRequest,
  type PaidRequestQuote,
} from '../repositories/billingRepository';
import { isSupabaseMode } from '../config/dataMode';
import { RepoError } from '../repositories/profileRepository';
import { formatMinor } from '../repositories/availabilityRepository';
import { useAuthSnapshot } from '../state/authBridge';
import { DateTimeSlotPicker, SLOT_WINDOW_DAYS } from './DateTimeSlotPicker';
import { FlowModal, IN_APP_CALL_LABEL, PrototypePaymentStep } from './FlowModal';
import { ProfilePhoto } from './ui';

type Step = 'when' | 'who' | 'pay' | 'done';

export function TestCallWizard({
  companion,
  trialOffer,
  onClose,
  onBooked,
}: {
  companion: User;
  trialOffer: ConversationOfferRow;
  onClose: () => void;
  onBooked?: () => void;
}) {
  const auth = useAuthSnapshot();
  const navigate = useNavigate();
  const paid = isSupabaseMode(); // explicit payment mode for this journey

  const eligibleMembers = auth.profiles
    .filter((p) => p.profile.role === 'member' && p.access.can_book && p.access.consent_status !== 'withdrawn')
    .map((p) => p.profile);

  const [step, setStep] = useState<Step>('when');
  const [slots, setSlots] = useState<AvailableSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [slotError, setSlotError] = useState<string | null>(null);
  const [slot, setSlot] = useState<AvailableSlot | null>(null);
  const [memberId, setMemberId] = useState(eligibleMembers[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 2G2 paid flow state (Supabase mode only).
  const [quote, setQuote] = useState<PaidRequestQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [payState, setPayState] = useState<string | null>(null);
  const idempotencyRef = useRef('');

  const member = eligibleMembers.find((m) => m.id === memberId);

  const loadSlots = useCallback(async () => {
    setLoading(true);
    setSlotError(null);
    try {
      const from = new Date().toISOString();
      const to = new Date(Date.now() + SLOT_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
      setSlots(await getAvailableSlots({ companionProfileId: companion.id, offerId: trialOffer.id, from, to }));
    } catch (e) {
      setSlotError(e instanceof RepoError ? e.message : 'We couldn’t load available times.');
    } finally {
      setLoading(false);
    }
  }, [companion.id, trialOffer.id]);

  useEffect(() => {
    void loadSlots();
  }, [loadSlots]);

  // Supabase mode: the SERVER quote drives the pay step. Selections are
  // preserved while the Coordinator adds a card and on retry.
  const loadQuote = useCallback(() => {
    if (!paid || !member) return;
    setQuote(null);
    setQuoteError(null);
    quotePaidRequest(member.id, companion.id, trialOffer.id)
      .then(setQuote)
      .catch((e) => setQuoteError(e instanceof Error ? e.message : 'We couldn’t price this conversation just now.'));
  }, [paid, member, companion.id, trialOffer.id]);

  useEffect(() => {
    if (step !== 'pay' || !paid || !slot || !member) return;
    idempotencyRef.current = `trial-${member.id}-${trialOffer.id}-${slot.startsAt}`;
    setPayState(null);
    loadQuote();
  }, [step, paid, slot, member, trialOffer.id, loadQuote]);

  const confirm = async () => {
    if (!slot || !member || submitting) return; // duplicate-click protection
    setSubmitting(true);
    setError(null);
    try {
      if (paid) {
        // REAL paid request — webhook-gated; no unpaid fallback exists.
        const result = await createPaidRequest({
          memberProfileId: member.id,
          companionProfileId: companion.id,
          offerId: trialOffer.id,
          startsAt: slot.startsAt,
          idempotencyKey: idempotencyRef.current,
        });
        if (result.state === 'payment_method_required') {
          setPayState('payment_method_required');
          setSubmitting(false);
          return;
        }
        if (result.state === 'requires_action' && result.url) {
          setPayState('redirecting');
          window.location.href = result.url;
          return;
        }
        if (result.state === 'failed') {
          setError('Your payment didn’t go through. No request was sent — please try again.');
          setSubmitting(false);
          return;
        }
        setPayState('confirming');
        for (let i = 0; i < 20; i += 1) {
          const status = await getPaymentOrderState(result.orderId);
          if (status === 'succeeded') {
            setPayState('succeeded');
            setStep('done');
            onBooked?.();
            setSubmitting(false);
            return;
          }
          if (status === 'failed' || status === 'expired') {
            setPayState(null);
            setError('Your payment didn’t go through. No request was sent — please try again.');
            setSubmitting(false);
            return;
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        setSubmitting(false);
        return;
      }
      // Mock mode: the simulated prototype journey, unchanged.
      const booking = await createBookingRequest({
        memberProfileId: member.id,
        offerId: trialOffer.id,
        startsAt: slot.startsAt,
        communicationMethod: IN_APP_METHOD,
      });
      setStep('done');
      onBooked?.();
      setTimeout(() => navigate(`/conversations/${booking.id}`), 1200);
    } catch (e) {
      const msg = e instanceof RepoError || e instanceof Error
        ? e.message
        : 'We couldn’t request your trial conversation. Please try again.';
      setError(msg);
      if (e instanceof RepoError && e.kind === 'conflict') {
        setSlot(null);
        setStep('when');
        void loadSlots();
      }
      setSubmitting(false);
    }
  };

  if (eligibleMembers.length === 0) {
    return (
      <FlowModal title="Book a trial conversation" onClose={onClose}>
        <p className="muted">
          Trial conversations are for Member profiles. If you look after someone, ask for booking
          permission on their profile first.
        </p>
      </FlowModal>
    );
  }

  if (step === 'done') {
    return (
      <FlowModal title="Trial conversation requested" onClose={onClose}>
        <div className="col" style={{ gap: 12, alignItems: 'center', textAlign: 'center' }}>
          <ProfilePhoto user={companion} size={88} radius={22} />
          <h3 style={{ margin: 0 }}>{companion.firstName} will confirm your trial conversation</h3>
          <p className="muted longform" style={{ margin: 0 }}>
            {paid
              ? 'Payment received. Waiting for the Companion’s response.'
              : 'Your conversation will take place securely in the app. No payment was taken.'}
          </p>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </FlowModal>
    );
  }

  const stepIndex = step === 'when' ? 1 : step === 'who' ? 2 : 3;

  return (
    <FlowModal
      title={`Trial conversation with ${companion.firstName}`}
      onClose={onClose}
      steps={3}
      current={stepIndex}
      error={error}
      footer={
        <>
          <button
            className="btn btn-ghost"
            disabled={submitting}
            onClick={() => (step === 'when' ? onClose() : setStep(step === 'who' ? 'when' : 'who'))}
          >
            {step === 'when' ? 'Cancel' : 'Back'}
          </button>
          {step === 'when' && (
            <button className="btn btn-primary" disabled={!slot} onClick={() => setStep('who')}>
              Continue
            </button>
          )}
          {step === 'who' && (
            <button className="btn btn-primary" disabled={!member} onClick={() => setStep('pay')}>
              Continue
            </button>
          )}
          {step === 'pay' && (
            <button
              className="btn btn-primary"
              disabled={submitting || (paid && !quote)}
              onClick={() => void confirm()}
            >
              {submitting
                ? 'Processing…'
                : !paid
                  ? 'Request trial conversation'
                  : quote && quote.cardAmountMinor === 0
                    ? 'Use credit and request conversation'
                    : 'Pay and request conversation'}
            </button>
          )}
        </>
      }
    >
      {step === 'when' && (
        <section className="col" style={{ gap: 12 }} aria-label="Choose a time">
          <div className="card card-muted row" style={{ gap: 10 }}>
            <Sparkles size={18} aria-hidden="true" />
            <span className="col" style={{ gap: 2 }}>
              <span className="bold">Trial conversation</span>
              <span className="faint">
                {trialOffer.duration_minutes} minutes · {formatMinor(trialOffer.price_minor)} ·
                A one-time introduction with no ongoing commitment.
              </span>
            </span>
          </div>
          <DateTimeSlotPicker
            slots={slots}
            loading={loading}
            error={slotError}
            selected={slot}
            onSelect={setSlot}
            onRetry={() => void loadSlots()}
            emptyMessage={`${companion.firstName} has no available times for a trial conversation at the moment.`}
          />
        </section>
      )}

      {step === 'who' && (
        <section className="col" style={{ gap: 12 }} aria-label="Who is this for">
          <h3 style={{ margin: 0 }}>Who is this conversation for?</h3>
          {eligibleMembers.length === 1 && member ? (
            <div className="card card-tight col" style={{ gap: 4 }}>
              <span className="bold">{member.first_name} {member.last_name}</span>
              <span className="faint">
                The conversation is with {companion.firstName} — you’re arranging it.
              </span>
            </div>
          ) : (
            <div className="col" style={{ gap: 8 }}>
              {eligibleMembers.map((m) => (
                <label key={m.id} className="card card-tight row" style={{ gap: 10, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="test-call-member"
                    checked={memberId === m.id}
                    onChange={() => setMemberId(m.id)}
                  />
                  <span className="bold">{m.first_name} {m.last_name}</span>
                </label>
              ))}
            </div>
          )}
        </section>
      )}

      {step === 'pay' && slot && member && paid && (
        /* Supabase mode: the REAL server-derived payment summary. */
        <section className="col" style={{ gap: 10 }} aria-label="Payment summary">
          <div className="card card-tight col" style={{ gap: 4 }}>
            <div className="row between"><span className="muted">Companion</span><span>{companion.firstName}</span></div>
            <div className="row between"><span className="muted">For</span><span>{member.first_name} {member.last_name}</span></div>
            <div className="row between"><span className="muted">When</span><span>{friendlyWhen(slot.startsAt)}</span></div>
            <div className="row between"><span className="muted">Type</span><span>Trial conversation · {trialOffer.duration_minutes} minutes</span></div>
            <div className="row between"><span className="muted">How</span><span>{IN_APP_CALL_LABEL}</span></div>
          </div>
          <div className="card card-tight col" style={{ gap: 4 }}>
            {quote === null && !quoteError && (
              <span className="row" style={{ gap: 8 }}>
                <Loader2 size={16} aria-hidden="true" />
                <span className="muted">Calculating your total…</span>
              </span>
            )}
            {quoteError && (
              <div className="col" style={{ gap: 6 }}>
                <p className="small" role="alert" style={{ margin: 0, color: 'var(--color-danger-text)' }}>{quoteError}</p>
                <button className="btn btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} onClick={loadQuote}>
                  Try again
                </button>
              </div>
            )}
            {quote && (
              <>
                <div className="row between">
                  <span className="muted">Trial price</span>
                  <span className="bold">{formatMinor(quote.subtotalMinor)}</span>
                </div>
                <div className="row between">
                  <span className="muted">Service fee</span>
                  <span>
                    {quote.trialFeeWaived
                      ? <span className="pill pill-ready">Trial service fee waived</span>
                      : formatMinor(quote.serviceFeeMinor)}
                  </span>
                </div>
                {quote.creditAppliedMinor > 0 && (
                  <div className="row between">
                    <span className="muted">Account credit applied</span>
                    <span>−{formatMinor(quote.creditAppliedMinor)}</span>
                  </div>
                )}
                <div className="row between">
                  <span className="muted">Card amount</span>
                  <span className="bold">{formatMinor(quote.cardAmountMinor)}</span>
                </div>
                <div className="row between" style={{ borderTop: '1px solid var(--color-border)', paddingTop: 6 }}>
                  <span className="bold">Total</span>
                  <span className="bold">{formatMinor(quote.totalMinor)}</span>
                </div>
              </>
            )}
            {payState === 'payment_method_required' && (
              <p className="small" role="alert" style={{ margin: '6px 0 0' }}>
                A saved payment method is needed first.{' '}
                <Link to="/settings">Add payment method</Link> — your selections
                here are kept while you do.
              </p>
            )}
            {payState === 'confirming' && (
              <p className="small" role="status" style={{ margin: '6px 0 0' }}>Payment is being confirmed.</p>
            )}
          </div>
        </section>
      )}

      {step === 'pay' && slot && member && !paid && (
        /* Mock mode ONLY: the clearly-simulated prototype step. */
        <PrototypePaymentStep
          heading="Trial conversation"
          lines={[
            { label: 'Companion', value: companion.firstName },
            { label: 'For', value: `${member.first_name} ${member.last_name}` },
            { label: 'When', value: friendlyWhen(slot.startsAt) },
            { label: 'Length', value: `${trialOffer.duration_minutes} minutes` },
            { label: 'How', value: IN_APP_CALL_LABEL },
          ]}
          total={formatMinor(trialOffer.price_minor)}
          totalLabel="Trial conversation"
          note="A one-time introduction with no ongoing commitment."
        />
      )}
    </FlowModal>
  );
}

export function friendlyWhen(iso: string, tz = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}
