/**
 * Corrective Stage 2E4B — the dedicated one-time TEST CALL journey.
 *
 * Deliberately NOT the generic booking modal: no pay-per-conversation
 * choices, no package credits, no bundles. A test call is one thing —
 * a single introductory conversation with one Companion.
 *
 * Steps: date & time → who it's for → payment (prototype) → confirm.
 * All conversations happen in the app; there is no method to choose.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import type { ConversationOfferRow } from '../supabase/database.types';
import type { User } from '../types';
import {
  createBookingRequest,
  getAvailableSlots,
  IN_APP_METHOD,
  type AvailableSlot,
} from '../repositories/bookingRepository';
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

  // The participant is always a MEMBER profile. A Coordinator books for
  // the Members they're authorised for — they are not the participant.
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

  const confirm = async () => {
    if (!slot || !member || submitting) return; // duplicate-click protection
    setSubmitting(true);
    setError(null);
    try {
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
      const msg = e instanceof RepoError ? e.message : 'We couldn’t request your test call. Please try again.';
      setError(msg);
      if (e instanceof RepoError && e.kind === 'conflict') {
        // Someone took that time: refresh real availability and try again.
        setSlot(null);
        setStep('when');
        void loadSlots();
      }
      setSubmitting(false);
    }
  };

  if (eligibleMembers.length === 0) {
    return (
      <FlowModal title="Book a test call" onClose={onClose}>
        <p className="muted">
          Test calls are for Member profiles. If you look after someone, ask for booking permission on
          their profile first.
        </p>
      </FlowModal>
    );
  }

  if (step === 'done') {
    return (
      <FlowModal title="Test call requested" onClose={onClose}>
        <div className="col" style={{ gap: 12, alignItems: 'center', textAlign: 'center' }}>
          <ProfilePhoto user={companion} size={88} radius={22} />
          <h3 style={{ margin: 0 }}>{companion.firstName} will confirm your test call</h3>
          <p className="muted longform" style={{ margin: 0 }}>
            Your conversation will take place securely in the app. No payment was taken.
          </p>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </FlowModal>
    );
  }

  const stepIndex = step === 'when' ? 1 : step === 'who' ? 2 : 3;

  return (
    <FlowModal
      title={`Test call with ${companion.firstName}`}
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
            <button className="btn btn-primary" disabled={submitting} onClick={() => void confirm()}>
              {submitting ? 'Requesting…' : 'Request test call'}
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
              <span className="bold">One-time test call</span>
              <span className="faint">
                {trialOffer.duration_minutes} minutes · {formatMinor(trialOffer.price_minor)} · No commitment
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
            emptyMessage={`${companion.firstName} has no available times for a test call at the moment.`}
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

      {step === 'pay' && slot && member && (
        <PrototypePaymentStep
          heading="One-time test call"
          lines={[
            { label: 'Companion', value: companion.firstName },
            { label: 'For', value: `${member.first_name} ${member.last_name}` },
            { label: 'When', value: friendlyWhen(slot.startsAt) },
            { label: 'Length', value: `${trialOffer.duration_minutes} minutes` },
            { label: 'How', value: IN_APP_CALL_LABEL },
          ]}
          total={formatMinor(trialOffer.price_minor)}
          totalLabel="Test call"
          note="No commitment — this is a one-time introduction."
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
