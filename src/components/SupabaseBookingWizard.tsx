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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
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

  const submit = useCallback(async () => {
    if (!selection || !slot || !member || submitting) return; // duplicate-click protection
    setSubmitting(true);
    setError(null);
    try {
      const booking =
        selection.kind === 'offer'
          ? await createBookingRequest({
              memberProfileId: member.id,
              offerId: selection.offer.id,
              startsAt: slot.startsAt,
              communicationMethod: method,
            })
          : await createPackageBookingRequest(selection.pack.purchase.id, slot.startsAt, method);
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
              <span className="faint">Checking your packages…</span>
            </div>
          ) : packages.length > 0 ? (
            <div>
              <div className="bold mb-2">Use a package credit</div>
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
                    <span className="badge badge-neutral">1 credit</span>
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
            <div className="card card-tight col" style={{ gap: 4 }}>
              <div className="row between">
                <span className="muted">Conversation price</span>
                <span className="bold">{formatMinor(selection.offer.price_minor)}</span>
              </div>
              {fee && (
                <div className="row between">
                  <span className="muted">Estimated platform fee ({fee.ratePct}%)</span>
                  <span>{formatMinor(fee.feeMinor)}</span>
                </div>
              )}
              <p className="faint" style={{ margin: '6px 0 0' }}>
                No payment will be taken yet. Payments will be added in a later stage.
              </p>
            </div>
          ) : (
            <div className="card card-tight col" style={{ gap: 4 }}>
              <div className="row between">
                <span className="muted">{selection.pack.purchase.title}</span>
                <span className="badge badge-neutral">1 package credit will be reserved</span>
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
            <button className="btn btn-primary" onClick={() => void submit()} disabled={submitting || !method}>
              {submitting ? 'Sending…' : 'Send request'}
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
