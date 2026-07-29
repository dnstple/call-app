/**
 * Stage 2E4B — the top of a Supabase Companion profile.
 *
 * Two cards, in this order of prominence:
 *  1. The one-time TEST CALL (only while the server says it's available)
 *  2. START REGULAR CONVERSATIONS — the primary action of the product
 *
 * Trial state comes from Supabase (`get_trial_state`) — never browser
 * state — so a used test call disappears permanently for that pair.
 * No package, credit or purchase language appears here.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarHeart, Loader2, Sparkles } from 'lucide-react';
import type { ConversationOfferRow, ConversationPlanRow, TrialState } from '../supabase/database.types';
import type { User } from '../types';
import { getTrialState, listMyPlans } from '../repositories/planRepository';
import { listMyBookings } from '../repositories/bookingRepository';
import { MessageActionButton } from '../messaging/MessageAction';
import { formatMinor } from '../repositories/availabilityRepository';
import { useAuthSnapshot } from '../state/authBridge';
import { PlanWizard } from './PlanWizard';
import { TestCallWizard } from './TestCallWizard';
import { IN_APP_CALL_EXPLAINER } from './FlowModal';
import { PLAN_STATUS_LABELS, frequencyLabel } from './PlanCards';

export function CompanionPlanHero({
  companion,
  offers,
  acceptingNewMembers,
  onBookOneOff = () => undefined,
}: {
  companion: User;
  offers: ConversationOfferRow[];
  acceptingNewMembers: boolean;
  /** Opens the existing one-off booking flow (SupabaseBookingWizard). */
  onBookOneOff?: () => void;
}) {
  const auth = useAuthSnapshot();

  const bookableMembers = useMemo(
    () =>
      auth.profiles
        .filter((p) => p.profile.role === 'member' && p.access.can_book && p.access.consent_status !== 'withdrawn')
        .map((p) => p.profile),
    [auth.profiles],
  );
  const member = bookableMembers[0];

  const [trial, setTrial] = useState<TrialState | null>(null);
  const [plan, setPlan] = useState<ConversationPlanRow | null>(null);
  const [messagingEligible, setMessagingEligible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [planOpen, setPlanOpen] = useState(false);
  const [trialOpen, setTrialOpen] = useState(false);
  // Shared booking-type selector: Regular is the recommended default; One-off
  // is the secondary choice. Trial is offered separately (above) while eligible.
  const [bookingType, setBookingType] = useState<'regular' | 'oneoff'>('regular');

  const trialOffer = offers.find((o) => o.offer_type === 'trial' && o.active) ?? null;
  const singleOffers = offers.filter((o) => o.offer_type === 'single' && o.active);

  const load = useCallback(async () => {
    if (!member) {
      setLoading(false);
      return;
    }
    const [state, plans, bookings] = await Promise.all([
      getTrialState(member.id, companion.id).catch(() => null),
      listMyPlans().catch(() => []),
      listMyBookings().catch(() => []),
    ]);
    setTrial(state);
    setPlan(
      plans.find(
        (p) =>
          p.member_profile_id === member.id &&
          p.companion_profile_id === companion.id &&
          ['requested', 'active', 'paused'].includes(p.status),
      ) ?? null,
    );
    // 2F2B: messaging opens for a qualifying relationship — a
    // confirmed/completed booking or an accepted plan. This is only a UI
    // hint; the server re-checks on get_or_create_conversation.
    setMessagingEligible(
      bookings.some(
        (b) =>
          b.member_profile_id === member.id &&
          b.companion_profile_id === companion.id &&
          ['confirmed', 'completed'].includes(b.status),
      ) ||
      plans.some(
        (p) =>
          p.member_profile_id === member.id &&
          p.companion_profile_id === companion.id &&
          ['active', 'paused', 'ended'].includes(p.status),
      ),
    );
    setLoading(false);
  }, [member, companion.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!member) return null; // companions/visitors see the story, not actions

  if (loading) {
    return (
      <div className="row mt-4" style={{ gap: 10 }}>
        <Loader2 size={18} aria-hidden="true" />
        <span className="muted">Loading options…</span>
      </div>
    );
  }

  const canPlan = singleOffers.length > 0 && acceptingNewMembers && !plan;
  const showTrialCard = trial !== 'used' && trialOffer !== null && acceptingNewMembers && !plan;
  // ONE authoritative price source: the cheapest single offer drives the "from
  // £X per conversation" fact for both Regular and One-off (regular is built
  // from the same per-conversation unit). Shown only when reliably available.
  const cheapestSingleMinor = singleOffers.reduce(
    (min, o) => Math.min(min, o.price_minor), Number.POSITIVE_INFINITY,
  );
  const fromLabel = Number.isFinite(cheapestSingleMinor) ? formatMinor(cheapestSingleMinor) : null;
  // Real conversation duration, only when the offers agree or give a clear range.
  const durations = Array.from(new Set(singleOffers.map((o) => o.duration_minutes))).sort((a, b) => a - b);
  const durationLabel =
    durations.length === 1
      ? `${durations[0]}-minute conversations`
      : durations.length > 1
        ? `${durations[0]}–${durations[durations.length - 1]} minute conversations`
        : null;

  return (
    <div className="col mt-4" style={{ gap: 12 }}>
      {!acceptingNewMembers && (
        <span className="badge badge-neutral" style={{ alignSelf: 'flex-start' }}>
          Not taking new members right now
        </span>
      )}

      {/* 2F2B: message an eligible relationship right from the profile.
          The server stays authoritative; ineligible members see concise
          guidance instead of an active button. */}
      {messagingEligible ? (
        <MessageActionButton
          small
          memberProfileId={member.id}
          companionProfileId={companion.id}
          label={`Message ${companion.firstName}`}
        />
      ) : (
        <span className="col" style={{ gap: 2, alignSelf: 'flex-start' }}>
          <button className="btn btn-secondary btn-small" disabled>
            Message {companion.firstName}
          </button>
          <span className="faint">Book a conversation before messaging</span>
        </span>
      )}

      {/* 1. The one-time test call — no commitment, disappears once used. */}
      {showTrialCard && (
        <div className="card card-tight row between wrap" style={{ gap: 10 }} aria-label="Trial conversation">
          <div className="col" style={{ gap: 2 }}>
            <span className="row bold" style={{ gap: 8 }}>
              <Sparkles size={16} aria-hidden="true" /> Book a trial conversation
            </span>
            <span className="faint">
              {trialOffer!.duration_minutes} minutes · {formatMinor(trialOffer!.price_minor)} · No commitment
            </span>
          </div>
          {trial === 'pending' ? (
            <span className="badge badge-neutral">Trial conversation requested</span>
          ) : (
            <button className="btn btn-secondary btn-small" onClick={() => setTrialOpen(true)}>
              Book a trial conversation
            </button>
          )}
        </div>
      )}

      {/* 2. The primary action: ongoing companionship. */}
      {plan ? (
        <div className="card card-feature col" style={{ gap: 6 }} aria-label="Your plan">
          <span className="row bold" style={{ gap: 8, fontSize: '1.05em' }}>
            <CalendarHeart size={18} aria-hidden="true" />
            Your regular conversations with {companion.firstName}
          </span>
          <span className="muted">
            {frequencyLabel(plan)} · {PLAN_STATUS_LABELS[plan.status]}
          </span>
          <span className="faint">See your plan and next conversation on your home page.</span>
        </div>
      ) : canPlan ? (
        <div className="card card-feature col" style={{ gap: 12 }} aria-label="Book a conversation">
          <div className="col" style={{ gap: 4 }}>
            <h2 style={{ margin: 0, fontSize: '1.15em' }}>Book a conversation with {companion.firstName}</h2>
            <p className="muted" style={{ margin: 0 }}>Choose how you’d like to talk with {companion.firstName}.</p>
          </div>

          {/* One selector, two clear choices. Regular is recommended and
              selected by default; one-off is secondary but plainly available. */}
          <div className="booking-type-group" role="group" aria-label="Conversation type">
            <button
              type="button"
              className="card card-tight card-selectable col booking-type-option"
              aria-pressed={bookingType === 'regular'}
              onClick={() => setBookingType('regular')}
            >
              <span className="row between" style={{ gap: 8 }}>
                <span className="bold">Regular conversations</span>
                <span className="badge badge-success">Recommended</span>
              </span>
              <span className="faint">Arrange an ongoing schedule with the same Companion.</span>
              <ul className="booking-facts faint">
                {durationLabel && <li>{durationLabel}</li>}
                <li>Choose how often you would like to talk</li>
                {fromLabel && <li>From {fromLabel} per conversation</li>}
              </ul>
            </button>
            <button
              type="button"
              className="card card-tight card-selectable col booking-type-option"
              aria-pressed={bookingType === 'oneoff'}
              onClick={() => setBookingType('oneoff')}
            >
              <span className="bold">One-off conversation</span>
              <span className="faint">A single conversation, with no ongoing commitment.</span>
              <ul className="booking-facts faint">
                {durationLabel && <li>{durationLabel}</li>}
                {fromLabel && <li>From {fromLabel} per conversation</li>}
              </ul>
            </button>
          </div>

          {bookingType === 'regular' ? (
            <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => setPlanOpen(true)}>
              Set up regular conversations
            </button>
          ) : (
            <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={onBookOneOff}>
              Book a one-off conversation
            </button>
          )}
          <span className="faint longform">{IN_APP_CALL_EXPLAINER}</span>
        </div>
      ) : (
        acceptingNewMembers && (
          <p className="faint">{companion.firstName} hasn’t set their conversation rates yet.</p>
        )
      )}

      {planOpen && (
        <PlanWizard
          companion={companion}
          offers={singleOffers}
          memberProfileId={member.id}
          onClose={() => setPlanOpen(false)}
          onCreated={() => void load()}
        />
      )}
      {trialOpen && trialOffer && (
        <TestCallWizard
          companion={companion}
          trialOffer={trialOffer}
          onBooked={() => void load()}
          onClose={() => {
            setTrialOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
