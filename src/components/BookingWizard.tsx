import { useMemo, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { Medium, PackageOffer, User } from '../types';
import { useAppState } from '../state/store';
import { currentUser, managedMembers, purchasesForMember } from '../state/selectors';
import { purchasePackage, requestBooking } from '../state/actions';
import { trialEligible } from '../domain/bookings';
import { availableCredits } from '../domain/packages';
import { generateSlots, toDateString, type Slot } from '../domain/availability';
import { computeFee, formatPence } from '../domain/commission';
import { MEDIUM_LABELS, formatDateTime, formatTime } from '../domain/format';
import { Modal, Stepper } from './ui';

type Step = 'offer' | 'member' | 'slot' | 'review' | 'done';

export function BookingWizard({ companion, onClose }: { companion: User; onClose: () => void }) {
  const state = useAppState();
  const me = currentUser(state);
  const isCoordinator = me.role === 'coordinator';
  const managed = isCoordinator ? managedMembers(state, me.id) : [];

  const [step, setStep] = useState<Step>('offer');
  const [offer, setOffer] = useState<PackageOffer | null>(null);
  const [memberId, setMemberId] = useState<string>(
    isCoordinator ? (state.session.activeMemberId ?? managed[0]?.id ?? '') : me.id,
  );
  const [slot, setSlot] = useState<Slot | null>(null);
  // All conversations happen through the app; there is no method to choose.
  const medium: Medium = 'in_app';
  const [usePurchaseId, setUsePurchaseId] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const offers = state.offers.filter((o) => o.companionId === companion.id && o.active);
  const trialOk = memberId ? trialEligible(state.bookings, memberId, companion.id) : true;

  const myPurchases = memberId
    ? purchasesForMember(state, memberId).filter(
        (p) => p.companionId === companion.id && availableCredits(p, state.bookings, new Date()) > 0,
      )
    : [];

  const slots = useMemo(
    () =>
      offer
        ? generateSlots(
            state.availabilityRules,
            state.availabilityExceptions,
            state.bookings,
            companion.id,
            offer.durationMins,
            new Date(),
            14,
          )
        : [],
    [offer, state.availabilityRules, state.availabilityExceptions, state.bookings, companion.id],
  );

  const slotsByDay = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const s of slots) {
      const key = toDateString(new Date(s.startISO));
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return [...map.entries()].slice(0, 7);
  }, [slots]);

  const steps: Step[] = isCoordinator
    ? ['offer', 'member', 'slot', 'review']
    : ['offer', 'slot', 'review'];
  const stepIndex = steps.indexOf(step === 'done' ? 'review' : step) + 1;

  function next() {
    const i = steps.indexOf(step);
    setStep(steps[Math.min(i + 1, steps.length - 1)]);
    setError(null);
  }
  function back() {
    const i = steps.indexOf(step);
    if (i <= 0) onClose();
    else setStep(steps[i - 1]);
    setError(null);
  }

  function submit() {
    if (!offer || !slot || !medium || submitting) return;
    setSubmitting(true);
    const result = requestBooking({
      memberId,
      companionId: companion.id,
      coordinatorId: isCoordinator ? me.id : undefined,
      offerId: offer.id,
      startISO: slot.startISO,
      medium,
      usePackagePurchaseId: usePurchaseId,
    });
    if (!result.ok) {
      setError(result.error ?? 'Something went wrong');
      setSubmitting(false);
      return;
    }
    setStep('done');
  }

  const fee = offer ? computeFee(offer.pricePence, offer.kind === 'trial', state.config) : null;

  return (
    <Modal title={`Schedule with ${companion.firstName}`} onClose={onClose} wide>
      {step !== 'done' && <Stepper total={steps.length} current={stepIndex} />}
      {error && <div className="banner banner-danger mb-4" role="alert">{error}</div>}

      {step === 'offer' && (
        <div className="col">
          <p className="muted">Choose a conversation type.</p>
          {offers.map((o) => {
            const disabled = o.kind === 'trial' && !trialOk;
            return (
              <button
                key={o.id}
                className="card card-tight card-click card-selectable row between"
                style={{ opacity: disabled ? 0.5 : 1 }}
                disabled={disabled}
                onClick={() => {
                  setOffer(o);
                  setUsePurchaseId(undefined);
                }}
                aria-pressed={offer?.id === o.id}
              >
                <span className="col" style={{ gap: 2, textAlign: 'left' }}>
                  <span className="bold">{o.title}</span>
                  <span className="faint">
                    {o.durationMins} mins · {o.callCount} call{o.callCount > 1 ? 's' : ''}
                    {o.kind === 'trial' && ' · one per pairing'}
                    {disabled && ' · trial already used'}
                  </span>
                </span>
                <span className="bold">{formatPence(o.pricePence)}</span>
              </button>
            );
          })}
          {myPurchases.length > 0 && (
            <div className="banner">
              <div>
                <div className="bold">Use a plan credit instead?</div>
                {myPurchases.map((p) => {
                  const o = state.offers.find((x) => x.id === p.offerId);
                  return (
                    <label key={p.id} className="row mt-2" style={{ gap: 10 }}>
                      <input
                        type="checkbox"
                        checked={usePurchaseId === p.id}
                        onChange={(e) => {
                          setUsePurchaseId(e.target.checked ? p.id : undefined);
                          if (e.target.checked && o) setOffer(o);
                        }}
                        style={{ width: 22, height: 22 }}
                      />
                      <span>
                        {o?.title} — {availableCredits(p, state.bookings, new Date())} credit(s) available
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          <WizardNav onBack={back} onNext={next} nextDisabled={!offer} />
        </div>
      )}

      {step === 'member' && (
        <div className="col">
          <p className="muted">Who will receive this conversation?</p>
          {managed.map((m) => (
            <button
              key={m.id}
              className="card card-tight card-click card-selectable row"
              onClick={() => setMemberId(m.id)}
              aria-pressed={memberId === m.id}
            >
              <span className="bold">{m.firstName} {m.lastName}</span>
              <span className="faint">· {m.region}</span>
            </button>
          ))}
          <WizardNav onBack={back} onNext={next} nextDisabled={!memberId} />
        </div>
      )}

      {step === 'slot' && (
        <div className="col">
          <p className="muted">Pick a time. All times are shown in UK time.</p>
          {slotsByDay.length === 0 && (
            <div className="banner">
              No bookable times in the next two weeks. {companion.firstName} may have paused availability.
            </div>
          )}
          {slotsByDay.map(([day, daySlots]) => (
            <div key={day}>
              <h4>{new Date(day).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</h4>
              <div className="slot-grid">
                {daySlots.slice(0, 8).map((s) => (
                  <button
                    key={s.startISO}
                    className="slot-btn"
                    aria-pressed={slot?.startISO === s.startISO}
                    onClick={() => setSlot(s)}
                  >
                    {formatTime(s.startISO)}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <WizardNav onBack={back} onNext={next} nextDisabled={!slot} />
        </div>
      )}

      {step === 'review' && offer && slot && medium && (
        <div className="col">
          <div className="card card-tight col" style={{ gap: 10 }}>
            <Row label="People" value={`${state.users.find((u) => u.id === memberId)?.firstName ?? ''} & ${companion.firstName}`} />
            <Row label="When" value={formatDateTime(slot.startISO)} />
            <Row label="Duration" value={`${offer.durationMins} minutes`} />
            <Row label="Method" value={MEDIUM_LABELS[medium]} />
            <Row label="Type" value={offer.title} />
            {usePurchaseId ? (
              <Row label="Price" value="1 plan credit (used when the call completes)" />
            ) : (
              <>
                <Row label="Price" value={formatPence(offer.pricePence)} />
                {fee && (
                  <Row
                    label="Platform fee"
                    value={
                      fee.platformFeePence === 0
                        ? `None — ${fee.commissionPct}% on trials`
                        : `${formatPence(fee.platformFeePence)} (${fee.commissionPct}%), included`
                    }
                  />
                )}
              </>
            )}
          </div>
          <div className="banner small">
            Cancelling more than 24 hours before the call: full simulated refund. Later cancellations are
            reviewed under the (simulated) cancellation policy. Payment here is <strong>simulated</strong> —
            no real money moves in this prototype.
          </div>
          <WizardNav
            onBack={back}
            onNext={submit}
            nextLabel={submitting ? 'Sending…' : 'Confirm and send request'}
            nextDisabled={submitting}
          />
        </div>
      )}

      {step === 'done' && (
        <div className="empty-state">
          <div className="icon"><CheckCircle2 size={36} aria-hidden="true" style={{ color: 'var(--success)' }} /></div>
          <h3>Request sent</h3>
          <p>
            {companion.firstName} has been notified and can accept, decline or suggest another time.
            You’ll get a notification either way.
          </p>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      )}
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row between" style={{ gap: 16 }}>
      <span className="muted">{label}</span>
      <span className="bold" style={{ textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function WizardNav({
  onBack,
  onNext,
  nextDisabled,
  nextLabel = 'Continue',
}: {
  onBack: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
  nextLabel?: string;
}) {
  return (
    <div className="row between mt-4">
      <button className="btn btn-ghost" onClick={onBack}>Back</button>
      <button className="btn btn-primary" onClick={onNext} disabled={nextDisabled}>{nextLabel}</button>
    </div>
  );
}

/** Simulated plan checkout, launched from a Companion profile. */
export function PackagePurchaseDialog({
  offer,
  companion,
  onClose,
}: {
  offer: PackageOffer;
  companion: User;
  onClose: () => void;
}) {
  const state = useAppState();
  const me = currentUser(state);
  const isCoordinator = me.role === 'coordinator';
  const managed = isCoordinator ? managedMembers(state, me.id) : [];
  const [memberId, setMemberId] = useState(
    isCoordinator ? (state.session.activeMemberId ?? managed[0]?.id ?? '') : me.id,
  );
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const fee = computeFee(offer.pricePence, false, state.config);

  return (
    <Modal title="Buy plan (simulated)" onClose={onClose}>
      {done ? (
        <div className="empty-state">
          <div className="icon"><CheckCircle2 size={36} aria-hidden="true" style={{ color: 'var(--success)' }} /></div>
          <h3>Plan purchased</h3>
          <p>Credits are ready to use — schedule a conversation any time within the validity period.</p>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      ) : (
        <div className="col">
          <div className="card card-tight col" style={{ gap: 10 }}>
            <Row label="Plan" value={offer.title} />
            <Row label="Companion" value={companion.firstName} />
            <Row label="Calls" value={`${offer.callCount} × ${offer.durationMins} mins`} />
            <Row label="Valid for" value={`${offer.validityDays} days`} />
            <Row label="Price" value={formatPence(offer.pricePence)} />
            <Row label="Platform fee" value={`${formatPence(fee.platformFeePence)} (${fee.commissionPct}%), included`} />
          </div>
          {isCoordinator && (
            <div className="field">
              <label htmlFor="pkg-member">Who is this plan for?</label>
              <select id="pkg-member" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
                {managed.map((m) => (
                  <option key={m.id} value={m.id}>{m.firstName} {m.lastName}</option>
                ))}
              </select>
            </div>
          )}
          <div className="banner small">This is a simulated purchase — no real payment is taken in the prototype.</div>
          <div className="row between">
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button
              className="btn btn-primary"
              disabled={busy || !memberId}
              onClick={() => {
                if (busy) return;
                setBusy(true);
                const res = purchasePackage(offer.id, memberId, me.id);
                if (res.ok) setDone(true);
                else setBusy(false);
              }}
            >
              Confirm simulated purchase
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
