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
import { getTrialState, listMyPlans, PLAN_FREQUENCY_MIN } from '../repositories/planRepository';
import { listMyBookings } from '../repositories/bookingRepository';
import { MessageActionButton } from '../messaging/MessageAction';
import { getMemberPlanPreferences, recommendedFrequency } from '../repositories/planRepository';
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
}: {
  companion: User;
  offers: ConversationOfferRow[];
  acceptingNewMembers: boolean;
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
  const [recommended, setRecommended] = useState(3);
  const [loading, setLoading] = useState(true);
  const [planOpen, setPlanOpen] = useState(false);
  const [trialOpen, setTrialOpen] = useState(false);

  const trialOffer = offers.find((o) => o.offer_type === 'trial' && o.active) ?? null;
  const singleOffers = offers.filter((o) => o.offer_type === 'single' && o.active);

  const load = useCallback(async () => {
    if (!member) {
      setLoading(false);
      return;
    }
    const [state, plans, prefs, bookings] = await Promise.all([
      getTrialState(member.id, companion.id).catch(() => null),
      listMyPlans().catch(() => []),
      getMemberPlanPreferences(member.id).catch(() => ({
        preferredDays: [], preferredDayparts: [], preferredDurationMinutes: null,
      })),
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
    setRecommended(recommendedFrequency(prefs));
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
        <div className="card card-feature col" style={{ gap: 10 }} aria-label="Start regular conversations">
          <div className="col" style={{ gap: 4 }}>
            <h2 style={{ margin: 0, fontSize: '1.15em' }}>
              Start regular conversations with {companion.firstName}
            </h2>
            <p className="muted" style={{ margin: 0 }}>
              A weekly rhythm at times that suit {member.first_name} — same companion, every week.
            </p>
            <p className="faint" style={{ margin: 0 }}>
              Recommended for {member.first_name}: {recommended} conversation
              {recommended === 1 ? '' : 's'} per week · from {PLAN_FREQUENCY_MIN} per week
            </p>
          </div>
          <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => setPlanOpen(true)}>
            Start regular conversations
          </button>
          <span className="faint longform">
            {IN_APP_CALL_EXPLAINER} Prototype plan — no payment will be taken.
          </span>
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
