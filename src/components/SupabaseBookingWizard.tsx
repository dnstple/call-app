/**
 * Supabase-mode booking wizard (Stage 2D, extended in 2E3B2B).
 *
 * Books REAL conversations either pay-per-conversation (a live offer) or
 * with a PACKAGE CREDIT (Stage 2E3B2B): eligible packages for the chosen
 * Member appear beside the offers, slots follow the package duration, and
 * confirming reserves exactly one credit server-side. The browser never
 * sends members, companions, durations or prices as authority — only ids,
 * a start time and a method. No payment is taken anywhere.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  checkPaymentOrder,
  createPaidRequest,
  createSetupSession,
  getBillingStatus,
  getPaymentOrderState,
  quotePaidRequest,
  type PaidRequestQuote,
} from '../repositories/billingRepository';
import { clearPaymentSession, savePaymentSession } from '../payments/paymentSession';
import { clearBookingDraft, saveBookingDraft } from '../payments/bookingDraft';
import { getTrialState } from '../repositories/planRepository';
import { ArrowLeft, CalendarDays, Loader2, Package, X } from 'lucide-react';
import type { ConversationOfferRow, TrialState } from '../supabase/database.types';
import type { User } from '../types';
import {
  createBookingRequest,
  getAllAvailableSlots,
  type AvailableSlot,
} from '../repositories/bookingRepository';
import {
  createPackageBookingRequest,
  getAllAvailablePackageSlots,
  getUsablePackagePurchases,
  PackageError,
  type UsablePackagePurchase,
} from '../repositories/packageRepository';
import { RepoError } from '../repositories/profileRepository';
import {
  calculateFeePreview,
  formatMinor,
  getPublicCommissionSettings,
} from '../repositories/availabilityRepository';
import { browserTimezone } from '../domain/timezones';
import { DateTimeSlotPicker, SLOT_WINDOW_DAYS } from './DateTimeSlotPicker';
import { MEDIUM_LABELS } from '../domain/format';
import { useAppState } from '../state/store';
import { useAuthSnapshot } from '../state/authBridge';

/* ---------------- viewer-timezone display helpers ---------------- */

export function slotDayKey(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

export function slotDayLabel(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date(iso));
}

export function slotTimeLabel(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

/* ---------------- reusable real-slot picker ---------------- */

export function SlotPicker({
  companionProfileId,
  offerId,
  purchaseId,
  onSelect,
  selected,
  reloadKey = 0,
}: {
  companionProfileId: string;
  /** Pay-per-conversation slots (offer duration). */
  offerId?: string;
  /** Package-credit slots (purchase duration) — Stage 2E3B2B. */
  purchaseId?: string;
  onSelect: (slot: AvailableSlot) => void;
  selected?: AvailableSlot | null;
  reloadKey?: number;
}) {
  const viewerTz = browserTimezone();
  const [slots, setSlots] = useState<AvailableSlot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setSlots(null);
    setError(null);
    // Full horizon (server rules still clamp) — every future date is viewable.
    const from = new Date().toISOString();
    const to = new Date(Date.now() + SLOT_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    const request = purchaseId
      ? getAllAvailablePackageSlots(purchaseId, from, to)
      : getAllAvailableSlots({ companionProfileId, offerId: offerId ?? '', from, to });
    request
      .then((s) => live && setSlots(s))
      .catch((e) => live && setError(e instanceof RepoError ? e.message : 'We couldn’t load available times.'));
    return () => {
      live = false;
    };
  }, [companionProfileId, offerId, purchaseId, reloadKey]);

  void viewerTz; // timezone display now lives inside the shared picker

  // Redesign: ONE shared multi-step chooser everywhere. This wrapper only
  // keeps its data-fetching contract; the wall-of-pills grid is gone.
  return (
    <DateTimeSlotPicker
      slots={slots ?? []}
      loading={slots === null && !error}
      error={error}
      selected={selected ?? null}
      onSelect={onSelect}
      emptyMessage="No available dates found. This companion may be fully booked or their diary may open later."
    />
  );
}

/* ---------------- the wizard ---------------- */

type Step = 'offer' | 'time' | 'review';

type Selection =
  | { kind: 'offer'; offer: ConversationOfferRow }
  | { kind: 'package'; pack: UsablePackagePurchase };

export function SupabaseBookingWizard({
  companion,
  offers,
  onClose,
  resume,
}: {
  companion: User;
  offers: ConversationOfferRow[];
  onClose: () => void;
  /** Block 9: restore a saved draft after the Stripe setup redirect. */
  resume?: { offerId: string; memberId: string; startsAt: string } | null;
}) {
  const state = useAppState();
  const auth = useAuthSnapshot();
  const navigate = useNavigate();
  const viewerTz = browserTimezone();

  // Members this account may genuinely book for (server re-verifies can_book).
  const bookableMembers = useMemo(() => {
    return auth.profiles
      .filter((p) => p.profile.role === 'member' && p.access.can_book && p.access.consent_status !== 'withdrawn')
      .map((p) => p.profile);
  }, [auth.profiles]);

  const [step, setStep] = useState<Step>('offer');
  const [selection, setSelection] = useState<Selection | null>(
    offers[0] ? { kind: 'offer', offer: offers[0] } : null,
  );
  const [memberId, setMemberId] = useState<string>(bookableMembers[0]?.id ?? '');
  const [packages, setPackages] = useState<UsablePackagePurchase[] | null>(null);
  const [slot, setSlot] = useState<AvailableSlot | null>(null);
  // All conversations happen through the app — one method, never chosen.
  const method = 'in_app';
  const [rates, setRates] = useState<{ trialPct: number; standardPct: number }>({ trialPct: 0, standardPct: 2 });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const member = bookableMembers.find((m) => m.id === memberId);
  const isCoordinator = state.users.find((u) => u.id === state.session.currentUserId)?.role === 'coordinator';

  // Block 9 — payment-method-first booking. `cardReady` is server-derived
  // (billing_status for THIS authenticated customer); null while loading.
  const [cardReady, setCardReady] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    getBillingStatus()
      .then((s) => live && setCardReady(s.paymentMethodReady))
      .catch(() => live && setCardReady(false));
    return () => { live = false; };
  }, []);

  // Restore a draft after returning from Stripe setup: re-select the exact
  // offer + slot and land on review, where the price is RE-QUOTED server-side.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!resume || restoredRef.current) return;
    const offer = offers.find((o) => o.id === resume.offerId);
    if (!offer) return; // offer withdrawn since — fall back to a fresh booking
    restoredRef.current = true;
    setMemberId(resume.memberId);
    setSelection({ kind: 'offer', offer });
    setSlot({
      startsAt: resume.startsAt,
      endsAt: new Date(new Date(resume.startsAt).getTime() + offer.duration_minutes * 60000).toISOString(),
    });
    setStep('review');
  }, [resume, offers]);

  // Eligible packages for THIS member with THIS companion (Stage 2E3B2B).
  const loadPackages = useCallback(async () => {
    if (!memberId) {
      setPackages([]);
      return;
    }
    try {
      setPackages(await getUsablePackagePurchases(memberId, companion.id));
    } catch {
      setPackages([]); // packages are an extra option, never a blocker
    }
  }, [memberId, companion.id]);

  useEffect(() => {
    setPackages(null);
    void loadPackages();
  }, [loadPackages]);

  // Real trial state for THIS member↔Companion pair, so the trial option is
  // disabled up front (not just rejected on submit) once it's used/pending.
  const [trialState, setTrialState] = useState<TrialState | null>(null);
  useEffect(() => {
    if (!memberId) { setTrialState(null); return; }
    let live = true;
    getTrialState(memberId, companion.id)
      .then((s) => { if (live) setTrialState(s); })
      .catch(() => { if (live) setTrialState(null); });
    return () => { live = false; };
  }, [memberId, companion.id]);

  // If a used/pending trial is currently selected, fall back to a standard offer.
  useEffect(() => {
    if (selection?.kind === 'offer' && selection.offer.offer_type === 'trial'
        && trialState !== null && trialState !== 'available') {
      const alt = offers.find((o) => o.offer_type !== 'trial');
      setSelection(alt ? { kind: 'offer', offer: alt } : null);
      setSlot(null);
    }
  }, [trialState, selection, offers]);

  useEffect(() => {
    getPublicCommissionSettings().then(setRates).catch(() => undefined);
  }, []);

  const fee =
    selection?.kind === 'offer'
      ? calculateFeePreview(selection.offer.price_minor, selection.offer.offer_type, rates)
      : null;

  const durationMinutes =
    selection?.kind === 'offer' ? selection.offer.duration_minutes : selection?.pack.purchase.duration_minutes;

  // 2G2: server-derived quote for offer selections at the review step.
  const [quote, setQuote] = useState<PaidRequestQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [payState, setPayState] = useState<string | null>(null);
  // ONE idempotency key per attempt (member+offer+slot): refresh, double
  // click and Stripe returns all reuse it — one order, one charge.
  const idempotencyRef = useRef<string>('');
  useEffect(() => {
    if (step !== 'review' || !selection || selection.kind !== 'offer' || !slot || !member) return;
    idempotencyRef.current = `req-${member.id}-${selection.offer.id}-${slot.startsAt}`;
    setQuote(null);
    setQuoteError(null);
    setPayState(null);
    quotePaidRequest(member.id, companion.id, selection.offer.id)
      .then(setQuote)
      .catch((e) => setQuoteError(e instanceof Error ? e.message : 'We couldn’t price this conversation just now.'));
  }, [step, selection, slot, member, companion.id]);

  const submitPaid = useCallback(async () => {
    if (!selection || selection.kind !== 'offer' || !slot || !member) return;
    const result = await createPaidRequest({
      memberProfileId: member.id,
      companionProfileId: companion.id,
      offerId: selection.offer.id,
      startsAt: slot.startsAt,
      idempotencyKey: idempotencyRef.current,
    });
    if (result.state === 'payment_method_required') {
      setPayState('payment_method_required');
      setSubmitting(false);
      return;
    }
    if (result.state === 'requires_action' && result.url) {
      // 3D-C: persist the durable recovery session BEFORE leaving the app so
      // the banking-app/browser return (and any reload) can resume this exact
      // order; navigate exactly once.
      if (redirectedRef.current) return;
      redirectedRef.current = true;
      savePaymentSession({ orderId: result.orderId, kind: 'one_off', returnTo: '/conversations' });
      setPayState('redirecting');
      window.location.href = result.url; // Stripe-hosted authentication
      return;
    }
    if (result.state === 'failed') {
      clearPaymentSession();
      setError('Your payment didn’t go through. No request was sent — please try again.');
      setSubmitting(false);
      return;
    }
    // Poll the safe order state until the WEBHOOK confirms funding (bounded;
    // a timeout is DELAYED CONFIRMATION, never treated as failure).
    savePaymentSession({ orderId: result.orderId, kind: 'one_off', returnTo: '/conversations' });
    lastOrderRef.current = result.orderId;
    setPayState('confirming');
    for (let i = 0; i < 20; i += 1) {
      const status = await getPaymentOrderState(result.orderId);
      if (status === 'succeeded') {
        clearPaymentSession();
        clearBookingDraft(); // draft is terminal once the order is placed
        setPayState('succeeded');
        setSubmitting(false);
        setTimeout(() => {
          onClose();
          navigate('/conversations');
        }, 1600);
        return;
      }
      if (status === 'failed' || status === 'expired') {
        clearPaymentSession();
        setPayState(null);
        setError('Your payment didn’t go through. No request was sent — please try again.');
        setSubmitting(false);
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    // Still pending: honest delayed-confirmation state with manual recovery
    // (the durable session is KEPT — money may already have moved).
    setPayState('delayed');
    setSubmitting(false);
  }, [selection, slot, member, companion.id, navigate, onClose]);

  // 3D-C: single-navigation guard + last order for manual status checks.
  const redirectedRef = useRef(false);
  const lastOrderRef = useRef<string | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const checkStatusNow = useCallback(async () => {
    const orderId = lastOrderRef.current;
    if (!orderId || checkingStatus) return;
    setCheckingStatus(true);
    try {
      const p = await checkPaymentOrder(orderId);
      if (p.found && p.customerStatus === 'completed') {
        clearPaymentSession();
        setPayState('succeeded');
        setTimeout(() => {
          onClose();
          navigate('/conversations');
        }, 1600);
      } else if (p.found && (p.customerStatus === 'failed' || p.customerStatus === 'cancelled')) {
        clearPaymentSession();
        setPayState(null);
        setError('Your payment didn’t go through. No request was sent — please try again.');
      }
      // Any other state: stay in the honest delayed view; session kept.
    } finally {
      setCheckingStatus(false);
    }
  }, [checkingStatus, navigate, onClose]);

  // Block 9 — no saved card yet: launch Stripe hosted setup FIRST. This creates
  // no order, reserves nothing and takes no payment; it only saves the draft so
  // the exact wizard resumes on return. Order creation stays at its authoritative
  // point (createPaidRequest), reached only once a card exists.
  const launchCardSetup = useCallback(async () => {
    if (!selection || selection.kind !== 'offer' || !slot || !member || submitting || redirectedRef.current) return;
    if (!auth.userId) return;
    setSubmitting(true);
    setError(null);
    saveBookingDraft({
      accountId: auth.userId,
      companionId: companion.id,
      memberId: member.id,
      offerId: selection.offer.id,
      offerType: selection.offer.offer_type,
      startsAt: slot.startsAt,
    });
    const url = await createSetupSession(`/people/${companion.id}`);
    if (!url) {
      // Setup couldn't start: no order was created and the draft is kept intact
      // (the wizard is still open) so the customer can simply try again.
      setError('We couldn’t start card setup just now. Please try again.');
      setSubmitting(false);
      return;
    }
    redirectedRef.current = true;
    window.location.href = url; // Stripe-hosted card setup
  }, [selection, slot, member, submitting, auth.userId, companion.id]);

  const submit = useCallback(async () => {
    if (!selection || !slot || !member || submitting) return; // duplicate-click protection
    // Paid offer that needs a card, with none saved → set the card up first (no
    // order created). Credit-only bookings (cardAmountMinor === 0) need no card.
    if (selection.kind === 'offer' && cardReady === false && !!quote && quote.cardAmountMinor > 0) {
      await launchCardSetup();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (selection.kind === 'offer') {
        await submitPaid();
        return;
      }
      const booking = await createPackageBookingRequest(selection.pack.purchase.id, slot.startsAt, method);
      clearBookingDraft();
      onClose();
      navigate(`/conversations/${booking.id}`);
    } catch (e) {
      const msg = e instanceof RepoError ? e.message : 'We couldn’t send your request. Please try again.';
      if (e instanceof PackageError && e.code === 'no_credit') {
        // The final credit went to a simultaneous booking: refresh the
        // options and fall back to pay-per-conversation booking.
        setError(`${msg} You can still book a pay-per-conversation time below.`);
        setSelection(offers[0] ? { kind: 'offer', offer: offers[0] } : null);
        setSlot(null);
        setStep('offer');
        void loadPackages();
      } else {
        setError(msg);
        if (e instanceof RepoError && e.kind === 'conflict' && msg.includes('taken')) {
          setSlot(null);
          setReloadKey((k) => k + 1);
          setStep('time');
        }
      }
      setSubmitting(false);
    }
  }, [selection, slot, member, method, submitting, cardReady, quote, launchCardSetup, navigate, onClose, offers, loadPackages]);

  // Whether the primary action will divert to card setup rather than pay now.
  const needsCardSetup =
    selection?.kind === 'offer' && cardReady === false && !!quote && quote.cardAmountMinor > 0;

  if (bookableMembers.length === 0) {
    return (
      <Dialog title="Request a conversation" onClose={onClose}>
        <p className="muted">
          Only Member profiles can request conversations. If you look after someone, ask for booking permission
          on their profile first.
        </p>
      </Dialog>
    );
  }

  return (
    <Dialog title={`Request a conversation with ${companion.firstName}`} onClose={onClose}>
      {error && <p role="alert" className="badge badge-danger" style={{ display: 'block', marginBottom: 12 }}>{error}</p>}

      {step === 'offer' && (
        <div className="col" style={{ gap: 18 }}>
          {isCoordinator && (
            <div>
              <div className="bold mb-2">Who is this conversation for?</div>
              <div className="col" style={{ gap: 8 }}>
                {bookableMembers.map((m) => (
                  <label key={m.id} className="card card-tight row" style={{ cursor: 'pointer', gap: 10 }}>
                    <input
                      type="radio"
                      name="booking-member"
                      checked={memberId === m.id}
                      onChange={() => {
                        setMemberId(m.id);
                        setSlot(null);
                      }}
                    />
                    <span className="bold">{m.first_name} {m.last_name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="bold mb-2">Pay per conversation</div>
            <div className="col" style={{ gap: 8 }}>
              {offers.length === 0 && <p className="muted" style={{ margin: 0 }}>No single conversations on offer.</p>}
              {offers.map((o) => {
                const trialBlocked = o.offer_type === 'trial' && trialState !== null && trialState !== 'available';
                return (
                <label key={o.id} className="card card-tight row between"
                  style={{ cursor: trialBlocked ? 'not-allowed' : 'pointer', opacity: trialBlocked ? 0.55 : 1 }}>
                  <span className="row" style={{ gap: 10 }}>
                    <input
                      type="radio"
                      name="booking-choice"
                      disabled={trialBlocked}
                      checked={selection?.kind === 'offer' && selection.offer.id === o.id}
                      onChange={() => {
                        if (trialBlocked) return;
                        setSelection({ kind: 'offer', offer: o });
                        setSlot(null);
                      }}
                    />
                    <span className="col" style={{ gap: 2 }}>
                      <span className="bold">{o.offer_type === 'trial' ? 'Trial conversation' : 'Standard conversation'}</span>
                      <span className="faint">
                        {o.duration_minutes} minutes
                        {trialBlocked && (trialState === 'pending' ? ' · trial already requested' : ' · trial already used')}
                      </span>
                    </span>
                  </span>
                  <span className="bold">{formatMinor(o.price_minor)}</span>
                </label>
                );
              })}
            </div>
          </div>

          {/* Package credits (Stage 2E3B2B) */}
          {packages === null ? (
            <div className="row" style={{ gap: 10 }}>
              <Loader2 size={16} aria-hidden="true" />
              <span className="faint">Checking your remaining conversations…</span>
            </div>
          ) : packages.length > 0 ? (
            <div>
              <div className="bold mb-2">Use a conversation you already have</div>
              <div className="col" style={{ gap: 8 }}>
                {packages.map((p) => (
                  <label key={p.purchase.id} className="card card-tight row between" style={{ cursor: 'pointer' }}>
                    <span className="row" style={{ gap: 10 }}>
                      <input
                        type="radio"
                        name="booking-choice"
                        checked={selection?.kind === 'package' && selection.pack.purchase.id === p.purchase.id}
                        onChange={() => {
                          setSelection({ kind: 'package', pack: p });
                          setSlot(null);
                        }}
                      />
                      <span className="col" style={{ gap: 2 }}>
                        <span className="bold row" style={{ gap: 6 }}>
                          <Package size={16} aria-hidden="true" /> {p.purchase.title}
                        </span>
                        <span className="faint">
                          {p.remaining} of {p.purchase.conversation_count} conversations left ·{' '}
                          {p.purchase.duration_minutes} minutes each
                        </span>
                      </span>
                    </span>
                    <span className="badge badge-neutral">1 conversation</span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}

          <button className="btn btn-primary" disabled={!selection || !member} onClick={() => setStep('time')}>
            Choose a time
          </button>
        </div>
      )}

      {step === 'time' && selection && (
        <div className="col" style={{ gap: 18 }}>
          <SlotPicker
            companionProfileId={companion.id}
            offerId={selection.kind === 'offer' ? selection.offer.id : undefined}
            purchaseId={selection.kind === 'package' ? selection.pack.purchase.id : undefined}
            selected={slot}
            onSelect={setSlot}
            reloadKey={reloadKey}
          />
          <div className="row" style={{ gap: 10 }}>
            <button className="btn btn-ghost" onClick={() => setStep('offer')}>
              <ArrowLeft size={16} aria-hidden="true" /> Back
            </button>
            <button className="btn btn-primary" disabled={!slot} onClick={() => setStep('review')}>
              Review request
            </button>
          </div>
        </div>
      )}

      {step === 'review' && selection && slot && member && (
        <div className="col" style={{ gap: 14 }}>
          <div className="card card-muted col" style={{ gap: 6 }}>
            <div className="row" style={{ gap: 8 }}>
              <CalendarDays size={18} aria-hidden="true" />
              <span className="bold">
                {slotDayLabel(slot.startsAt, viewerTz)}, {slotTimeLabel(slot.startsAt, viewerTz)}–{slotTimeLabel(slot.endsAt, viewerTz)}
              </span>
            </div>
            <span className="muted">Shown in your timezone ({viewerTz}) · {durationMinutes} minutes</span>
            <span className="muted">
              For {member.first_name} {member.last_name} · with {companion.firstName}
            </span>
          </div>

          {selection.kind === 'offer' ? (
            /* 2G2: the complete SERVER-derived quote before any submission. */
            <div className="card card-tight col" style={{ gap: 4 }} aria-label="Payment summary">
              {quote === null && !quoteError && (
                <span className="row" style={{ gap: 8 }}>
                  <Loader2 size={16} aria-hidden="true" />
                  <span className="muted">Calculating your total…</span>
                </span>
              )}
              {quoteError && <p className="small" role="alert" style={{ margin: 0, color: 'var(--color-danger-text)' }}>{quoteError}</p>}
              {quote && (
                <>
                  <div className="row between">
                    <span className="muted">Conversation price</span>
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
              {needsCardSetup && payState === null && (
                <p className="small" style={{ margin: '6px 0 0' }}>
                  You’ll add a card on Stripe’s secure page, then come straight back
                  here to confirm this conversation — nothing is charged until you do.
                </p>
              )}
              {payState === 'payment_method_required' && (
                <p className="small" role="alert" style={{ margin: '6px 0 0' }}>
                  A saved payment method is needed first.{' '}
                  <Link to="/settings">Add payment method</Link> — your selections
                  here are kept while you do.
                </p>
              )}
              {payState === 'confirming' && (
                <p className="small" role="status" style={{ margin: '6px 0 0' }}>
                  Your payment was received. We’re confirming your conversation.
                </p>
              )}
              {payState === 'redirecting' && (
                <p className="small" role="status" style={{ margin: '6px 0 0' }}>
                  Your bank needs a quick security check. Taking you to their secure
                  page now — you’ll come straight back here afterwards.
                </p>
              )}
              {payState === 'delayed' && (
                <div className="col" style={{ gap: 6, margin: '6px 0 0' }} role="status">
                  <p className="small" style={{ margin: 0 }}>
                    Your payment was received, but confirmation is taking longer than
                    expected. You will not be charged again.
                  </p>
                  <div className="row" style={{ gap: 8 }}>
                    <button className="btn" type="button" disabled={checkingStatus}
                      onClick={() => void checkStatusNow()}>
                      {checkingStatus ? 'Checking…' : 'Check payment status'}
                    </button>
                    {lastOrderRef.current && (
                      <Link className="btn" to={`/payment/return?order=${lastOrderRef.current}`}>
                        Open payment status page
                      </Link>
                    )}
                  </div>
                </div>
              )}
              {payState === 'succeeded' && (
                <p className="small" role="status" style={{ margin: '6px 0 0', color: 'var(--color-success-text)' }}>
                  Payment received. Waiting for the Companion’s response.
                </p>
              )}
            </div>
          ) : (
            <div className="card card-tight col" style={{ gap: 4 }}>
              <div className="row between">
                <span className="muted">{selection.pack.purchase.title}</span>
                <span className="badge badge-neutral">One of your remaining conversations will be reserved</span>
              </div>
              <p className="faint" style={{ margin: '6px 0 0' }}>
                This uses one credit from your simulated package. No payment will be taken.
              </p>
            </div>
          )}

          <div className="row" style={{ gap: 10 }}>
            <button className="btn btn-ghost" onClick={() => setStep('time')} disabled={submitting}>
              <ArrowLeft size={16} aria-hidden="true" /> Back
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void submit()}
              disabled={
                submitting || !method ||
                (selection.kind === 'offer' && (!quote || (quote.cardAmountMinor > 0 && cardReady === null)))
              }
            >
              {submitting
                ? (needsCardSetup ? 'Taking you to add a card…' : 'Processing…')
                : selection.kind !== 'offer'
                  ? 'Send request'
                  : quote && quote.cardAmountMinor === 0
                    ? 'Use credit and request conversation'
                    : needsCardSetup
                      ? 'Add a card to continue'
                      : 'Pay and request conversation'}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/* ---------------- minimal dialog shell ---------------- */

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal card"
        style={{ maxWidth: 560, width: '100%', maxHeight: '86vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row between mb-4">
          <h2 style={{ margin: 0, fontSize: '1.15em' }}>{title}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
