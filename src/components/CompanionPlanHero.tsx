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
import { getMemberPlanPreferences, recommendedFrequency } from '../repositories/planRepository';
import { formatMinor } from '../repositories/availabilityRepository';
import { useAuthSnapshot } from '../state/authBridge';
import { PlanWizard } from './PlanWizard';
import { SupabaseBookingWizard } from './SupabaseBookingWizard';
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
    const [state, plans, prefs] = await Promise.all([
      getTrialState(member.id, companion.id).catch(() => null),
      listMyPlans().catch(() => []),
      getMemberPlanPreferences(member.id).catch(() => ({
        preferredDays: [], preferredDayparts: [], preferredDurationMinutes: null,
      })),
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

      {/* 1. The one-time test call — no commitment, disappears once used. */}
      {showTrialCard && (
        <div className="card card-tight row between wrap" style={{ gap: 10 }} aria-label="Test call">
          <div className="col" style={{ gap: 2 }}>
            <span className="row bold" style={{ gap: 8 }}>
              <Sparkles size={16} aria-hidden="true" /> Book a test call
            </span>
            <span className="faint">
              {trialOffer!.duration_minutes} minutes · {formatMinor(trialOffer!.price_minor)} · No commitment
            </span>
          </div>
          {trial === 'pending' ? (
            <span className="badge badge-neutral">Test call requested</span>
          ) : (
            <button className="btn btn-secondary btn-small" onClick={() => setTrialOpen(true)}>
              Book a test call
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
          <span className="faint">Prototype plan — no payment will be taken.</span>
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
        <SupabaseBookingWizard
          companion={companion}
          offers={[trialOffer]}
          onClose={() => {
            setTrialOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
