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
  createPaidRequest,
  getPaymentOrderState,
  quotePaidRequest,
  type PaidRequestQuote,
} from '../repositories/billingRepository';
import { ArrowLeft, CalendarDays, Loader2, Package, X } from 'lucide-react';
import type { ConversationOfferRow } from '../supabase/database.types';
import type { User } from '../types';
import {
  createBookingRequest,
  getAvailableSlots,
  type AvailableSlot,
} from '../repositories/bookingRepository';
import {
  createPackageBookingRequest,
  getAvailablePackageSlots,
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
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
    const request = purchaseId
      ? getAvailablePackageSlots(purchaseId, from, to)
      : getAvailableSlots({ companionProfileId, offerId: offerId ?? '', from, to });
    request
      .then((s) => live && setSlots(s))
      .catch((e) => live && setError(e instanceof RepoError ? e.message : 'We couldn’t load available times.'));
    return () => {
      live = false;
    };
  }, [companionProfileId, offerId, purchaseId, reloadKey]);

  const byDay = useMemo(() => {
    const map = new Map<string, AvailableSlot[]>();
    for (const s of slots ?? []) {
      const k = slotDayKey(s.startsAt, viewerTz);
      map.set(k, [...(map.get(k) ?? []), s]);
    }
    return [...map.entries()];
  }, [slots, viewerTz]);

  if (error) return <p className="muted" role="alert">{error}</p>;
  if (slots === null) {
    return (
      <div className="row" style={{ gap: 10 }}>
        <Loader2 size={20} aria-hidden="true" /> <span className="muted">Finding available times…</span>
      </div>
    );
  }
  if (slots.length === 0) {
    return (
      <p className="muted">
        No available times in the next two weeks. This companion may be fully booked or their diary may open later.
      </p>
    );
  }
  return (
    <div className="col" style={{ gap: 16 }}>
      <p className="faint" style={{ margin: 0 }}>All times are shown in your timezone ({viewerTz}).</p>
      {byDay.map(([day, daySlots]) => (
        <div key={day}>
          <div className="bold mb-2">{slotDayLabel(daySlots[0].startsAt, viewerTz)}</div>
          <div className="row wrap" style={{ gap: 8 }}>
            {daySlots.map((s) => (
              <button
                key={s.startsAt}
                className={`btn btn-small ${selected?.startsAt === s.startsAt ? 'btn-primary' : 'btn-secondary'}`}
                aria-pressed={selected?.startsAt === s.startsAt}
                onClick={() => onSelect(s)}
              >
                {slotTimeLabel(s.startsAt, viewerTz)}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
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
}: {
  companion: User;
  offers: ConversationOfferRow[];
  onClose: () => void;
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
      setPayState('redirecting');
      window.location.href = result.url; // Stripe-hosted authentication
      return;
    }
    if (result.state === 'failed') {
      setError('Your payment didn’t go through. No request was sent — please try again.');
      setSubmitting(false);
      return;
    }
    // Poll the safe order state until the WEBHOOK confirms funding.
    setPayState('confirming');
    for (let i = 0; i < 20; i += 1) {
      const status = await getPaymentOrderState(result.orderId);
      if (status === 'succeeded') {
        setPayState('succeeded');
        setSubmitting(false);
        setTimeout(() => {
          onClose();
          navigate('/conversations');
        }, 1600);
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
    // Still pending: honest holding state (webhook may land shortly).
    setSubmitting(false);
  }, [selection, slot, member, companion.id, navigate, onClose]);

  const submit = useCallback(async () => {
    if (!selection || !slot || !member || submitting) return; // duplicate-click protection
    setSubmitting(true);
    setError(null);
    try {
      if (selection.kind === 'offer') {
        await submitPaid();
        return;
      }
      const booking = await createPackageBookingRequest(selection.pack.purchase.id, slot.startsAt, method);
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
  }, [selection, slot, member, method, submitting, navigate, onClose, offers, loadPackages]);

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
              {offers.map((o) => (
                <label key={o.id} className="card card-tight row between" style={{ cursor: 'pointer' }}>
                  <span className="row" style={{ gap: 10 }}>
                    <input
                      type="radio"
                      name="booking-choice"
                      checked={selection?.kind === 'offer' && selection.offer.id === o.id}
                      onChange={() => {
                        setSelection({ kind: 'offer', offer: o });
                        setSlot(null);
                      }}
                    />
                    <span className="col" style={{ gap: 2 }}>
                      <span className="bold">{o.offer_type === 'trial' ? 'Trial conversation' : 'Standard conversation'}</span>
                      <span className="faint">{o.duration_minutes} minutes</span>
                    </span>
                  </span>
                  <span className="bold">{formatMinor(o.price_minor)}</span>
                </label>
              ))}
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
              disabled={submitting || !method || (selection.kind === 'offer' && !quote)}
            >
              {submitting
                ? 'Processing…'
                : selection.kind !== 'offer'
                  ? 'Send request'
                  : quote && quote.cardAmountMinor === 0
                    ? 'Use credit and request conversation'
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
