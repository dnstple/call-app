/**
 * Supabase-mode booking wizard (Stage 2D) — REAL booking requests.
 *
 * Slots come from the database (recurring availability + exceptions, notice,
 * horizon, conflicts); prices and fees shown here are display copies of what
 * the SERVER will snapshot — nothing money-related is sent from the browser.
 * No payment is taken yet. Entirely separate from the mock BookingWizard.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CalendarDays, Loader2, X } from 'lucide-react';
import type { ConversationOfferRow } from '../supabase/database.types';
import type { User } from '../types';
import {
  createBookingRequest,
  getAvailableSlots,
  type AvailableSlot,
} from '../repositories/bookingRepository';
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
  onSelect,
  selected,
  reloadKey = 0,
}: {
  companionProfileId: string;
  offerId: string;
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
    getAvailableSlots({ companionProfileId, offerId, from, to })
      .then((s) => live && setSlots(s))
      .catch((e) => live && setError(e instanceof RepoError ? e.message : 'We couldn’t load available times.'));
    return () => {
      live = false;
    };
  }, [companionProfileId, offerId, reloadKey]);

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
  const [offerId, setOfferId] = useState<string>(offers[0]?.id ?? '');
  const [memberId, setMemberId] = useState<string>(bookableMembers[0]?.id ?? '');
  const [slot, setSlot] = useState<AvailableSlot | null>(null);
  const [method, setMethod] = useState<string>('');
  const [rates, setRates] = useState<{ trialPct: number; standardPct: number }>({ trialPct: 0, standardPct: 2 });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const offer = offers.find((o) => o.id === offerId);
  const member = bookableMembers.find((m) => m.id === memberId);
  const isCoordinator = state.users.find((u) => u.id === state.session.currentUserId)?.role === 'coordinator';

  useEffect(() => {
    getPublicCommissionSettings().then(setRates).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (offer && !offer.supported_methods.includes(method)) {
      setMethod(offer.supported_methods[0] ?? 'phone');
    }
  }, [offer, method]);

  const fee = offer ? calculateFeePreview(offer.price_minor, offer.offer_type, rates) : null;

  const submit = useCallback(async () => {
    if (!offer || !slot || !member) return;
    setSubmitting(true);
    setError(null);
    try {
      const booking = await createBookingRequest({
        memberProfileId: member.id,
        offerId: offer.id,
        startsAt: slot.startsAt,
        communicationMethod: method,
      });
      onClose();
      navigate(`/conversations/${booking.id}`);
    } catch (e) {
      const msg = e instanceof RepoError ? e.message : 'We couldn’t send your request. Please try again.';
      setError(msg);
      // Slot-taken conflicts: return to the time step with fresh slots.
      if (e instanceof RepoError && e.kind === 'conflict' && msg.includes('taken')) {
        setSlot(null);
        setReloadKey((k) => k + 1);
        setStep('time');
      }
      setSubmitting(false);
    }
  }, [offer, slot, member, method, navigate, onClose]);

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
                      onChange={() => setMemberId(m.id)}
                    />
                    <span className="bold">{m.first_name} {m.last_name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div>
            <div className="bold mb-2">Choose a conversation</div>
            <div className="col" style={{ gap: 8 }}>
              {offers.map((o) => (
                <label key={o.id} className="card card-tight row between" style={{ cursor: 'pointer' }}>
                  <span className="row" style={{ gap: 10 }}>
                    <input
                      type="radio"
                      name="booking-offer"
                      checked={offerId === o.id}
                      onChange={() => {
                        setOfferId(o.id);
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
          <button className="btn btn-primary" disabled={!offer || !member} onClick={() => setStep('time')}>
            Choose a time
          </button>
        </div>
      )}

      {step === 'time' && offer && (
        <div className="col" style={{ gap: 18 }}>
          <SlotPicker
            companionProfileId={companion.id}
            offerId={offer.id}
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

      {step === 'review' && offer && slot && member && (
        <div className="col" style={{ gap: 14 }}>
          <div className="card card-muted col" style={{ gap: 6 }}>
            <div className="row" style={{ gap: 8 }}>
              <CalendarDays size={18} aria-hidden="true" />
              <span className="bold">
                {slotDayLabel(slot.startsAt, viewerTz)}, {slotTimeLabel(slot.startsAt, viewerTz)}–{slotTimeLabel(slot.endsAt, viewerTz)}
              </span>
            </div>
            <span className="muted">Shown in your timezone ({viewerTz}) · {offer.duration_minutes} minutes</span>
            <span className="muted">
              For {member.first_name} {member.last_name} · with {companion.firstName}
            </span>
          </div>

          <div>
            <div className="bold mb-2">How should the call happen?</div>
            <div className="row wrap" style={{ gap: 8 }}>
              {offer.supported_methods.map((m) => (
                <button
                  key={m}
                  className={`btn btn-small ${method === m ? 'btn-primary' : 'btn-secondary'}`}
                  aria-pressed={method === m}
                  onClick={() => setMethod(m)}
                >
                  {MEDIUM_LABELS[m as keyof typeof MEDIUM_LABELS] ?? m}
                </button>
              ))}
            </div>
          </div>

          <div className="card card-tight col" style={{ gap: 4 }}>
            <div className="row between">
              <span className="muted">Conversation price</span>
              <span className="bold">{formatMinor(offer.price_minor)}</span>
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
