/**
 * Stage 2E4D — /plans: the conversation-plan dashboard.
 *
 * Plans are the product. Each card answers: who with, how often, which
 * weekly times, when the next conversation is, what state the plan is in
 * and whether anything needs attention. No package/credit vocabulary.
 *
 * Sorting: requests needing action → active plans → paused → ended.
 * Mock mode keeps its simpler prototype view; Supabase data never falls
 * back to mock records.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarHeart, Loader2 } from 'lucide-react';
import { isSupabaseMode } from '../config/dataMode';
import { useAppState } from '../state/store';
import { currentUser, purchasesForMember, activeMember } from '../state/selectors';
import { remainingCredits } from '../domain/packages';
import { formatDate } from '../domain/format';
import { useAuthSnapshot } from '../state/authBridge';
import { browserTimezone } from '../domain/timezones';
import {
  getPlanGenerationLog,
  getPlanMemberProfile,
  getPlanSlots,
  listMyPlans,
  listPlanBookings,
  nextConversation,
  retriableSkips,
} from '../repositories/planRepository';
import { loadMarketplaceProfile } from '../state/marketplace';
import { scheduleSummary } from '../components/PlanWizard';
import { PLAN_STATUS_LABELS } from '../components/PlanCards';
import { EmptyState, PageHeader } from '../components/ui';
import { PackageDashboard } from '../components/PackageDashboard';
import type {
  ConversationPlanRow,
  MyBookingRow,
  PlanScheduleSlotRow,
} from '../supabase/database.types';

const STATUS_BADGE: Record<ConversationPlanRow['status'], string> = {
  requested: 'badge-pending',
  active: 'badge-success',
  paused: 'badge-neutral',
  ended: 'badge-neutral',
  declined: 'badge-neutral',
};

const SORT_ORDER: Record<ConversationPlanRow['status'], number> = {
  requested: 0, active: 1, paused: 2, ended: 3, declined: 3,
};

export interface PlanOverview {
  plan: ConversationPlanRow;
  slots: PlanScheduleSlotRow[];
  bookings: MyBookingRow[];
  /** Safe display name of the other person (or the Member, for Companions). */
  counterpartName: string;
  /** Coordinator context: the managed Member this plan belongs to. */
  memberName: string | null;
  issueCount: number;
  viewerSide: 'member' | 'companion';
}

export function nextConversationLabel(bookings: MyBookingRow[], viewerTz: string): string | null {
  const next = nextConversation(bookings);
  if (!next) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: viewerTz, weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(next.starts_at));
}

/** Load everything a plan card or detail header needs. Exported for reuse. */
export async function loadPlanOverview(
  plan: ConversationPlanRow,
  viewerSide: 'member' | 'companion',
): Promise<PlanOverview> {
  const [slots, bookings, log] = await Promise.all([
    getPlanSlots(plan.id).catch(() => [] as PlanScheduleSlotRow[]),
    listPlanBookings(plan.id).catch(() => [] as MyBookingRow[]),
    getPlanGenerationLog(plan.id).catch(() => []),
  ]);
  let counterpartName = '';
  let memberName: string | null = null;
  const fromBooking = bookings[0];
  if (viewerSide === 'companion') {
    const member = await getPlanMemberProfile(plan.id).catch(() => null);
    counterpartName = member
      ? `${member.first_name}${member.last_initial ? ` ${member.last_initial}.` : ''}`
      : fromBooking
        ? `${fromBooking.member_first_name} ${fromBooking.member_last_initial ?? ''}`.trim()
        : 'your Member';
  } else {
    memberName = fromBooking?.member_first_name ?? null;
    counterpartName = fromBooking
      ? `${fromBooking.companion_first_name} ${fromBooking.companion_last_initial ?? ''}`.trim()
      : (await loadMarketplaceProfile(plan.companion_profile_id).catch(() => null))
          ?.firstName ?? 'your Companion';
  }
  const issueCount = retriableSkips(log).filter(
    (l) => new Date(l.intended_start) > new Date()
      && (l.outcome === 'skipped_conflict' || l.outcome === 'skipped_availability'),
  ).length;
  return { plan, slots, bookings, counterpartName, memberName, issueCount, viewerSide };
}

function PlanCard({ view, viewerTz, coordinator }: {
  view: PlanOverview;
  viewerTz: string;
  coordinator: boolean;
}) {
  const { plan, slots, bookings, counterpartName, memberName, issueCount, viewerSide } = view;
  const companionTz = slots[0]?.timezone ?? 'Europe/London';
  const next = nextConversationLabel(bookings, viewerTz);
  const title = viewerSide === 'companion'
    ? `Regular conversations with ${counterpartName}`
    : coordinator && memberName
      ? `${memberName}’s regular conversations with ${counterpartName}`
      : `Regular conversations with ${counterpartName}`;

  return (
    <div className="card col" style={{ gap: 8, minWidth: 0 }}>
      <div className="row between wrap" style={{ gap: 8 }}>
        <span className="row bold longform" style={{ gap: 8, minWidth: 0 }}>
          <CalendarHeart size={18} aria-hidden="true" />
          {title}
        </span>
        <span className={`badge ${STATUS_BADGE[plan.status]}`}>{PLAN_STATUS_LABELS[plan.status]}</span>
      </div>
      <span className="muted">
        {plan.frequency_per_week} conversation{plan.frequency_per_week === 1 ? '' : 's'} per week ·{' '}
        {plan.duration_minutes} minutes each
      </span>
      {slots.length > 0 && (
        <span className="faint longform">
          {scheduleSummary(
            slots.map((s) => ({ day: s.iso_day, time: s.local_time.slice(0, 5) })),
            companionTz,
            viewerTz,
          )}{' '}
          (your timezone)
        </span>
      )}
      {plan.status === 'active' && (
        <span className="muted">
          {next ? <>Next conversation: <strong>{next}</strong></> : 'No conversations scheduled yet'}
        </span>
      )}
      {plan.status === 'requested' && (
        <span className="faint">
          {viewerSide === 'companion' ? 'Waiting for your decision.' : 'Waiting for the Companion to confirm.'}
        </span>
      )}
      {plan.status === 'paused' && <span className="faint">Paused — no conversations are being arranged.</span>}
      {issueCount > 0 && plan.status === 'active' && (
        <span className="row badge badge-pending" style={{ gap: 6, alignSelf: 'flex-start' }}>
          <AlertTriangle size={14} aria-hidden="true" />
          {issueCount} conversation{issueCount === 1 ? '' : 's'} need{issueCount === 1 ? 's' : ''} a new time
        </span>
      )}
      <div className="row wrap" style={{ gap: 8 }}>
        <Link to={`/plans/${plan.id}`} className="btn btn-primary btn-small">View plan</Link>
        {viewerSide === 'companion' ? (
          <Link to={`/plans/${plan.id}/member`} className="btn btn-secondary btn-small">
            View {counterpartName.split(' ')[0]}’s profile
          </Link>
        ) : (
          <Link to={`/people/${plan.companion_profile_id}`} className="btn btn-secondary btn-small">
            View {counterpartName.split(' ')[0]}’s profile
          </Link>
        )}
      </div>
    </div>
  );
}

function SupabasePlans() {
  const auth = useAuthSnapshot();
  const viewerTz = browserTimezone();
  const [views, setViews] = useState<PlanOverview[] | null>(null);
  const [failed, setFailed] = useState(false);

  const companionIds = auth.profiles
    .filter((p) => p.profile.role === 'companion' && p.access.can_edit)
    .map((p) => p.profile.id);
  const memberIds = auth.profiles
    .filter((p) => p.profile.role === 'member' && p.access.can_book)
    .map((p) => p.profile.id);
  const isCoordinator = auth.profiles.some(
    (p) => p.profile.role === 'coordinator' && p.access.access_role === 'owner',
  );
  const key = [...companionIds, ...memberIds].join(',');

  const load = useCallback(async () => {
    try {
      const plans = await listMyPlans();
      const loaded = await Promise.all(
        plans.map((plan) =>
          loadPlanOverview(
            plan,
            companionIds.includes(plan.companion_profile_id) ? 'companion' : 'member',
          ),
        ),
      );
      loaded.sort((a, b) =>
        SORT_ORDER[a.plan.status] - SORT_ORDER[b.plan.status]
        || a.plan.created_at.localeCompare(b.plan.created_at));
      setViews(loaded);
    } catch {
      setFailed(true);
      setViews([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const grouped = useMemo(() => views ?? [], [views]);

  if (views === null) {
    return (
      <div className="row" style={{ gap: 10, padding: 32 }}>
        <Loader2 size={20} aria-hidden="true" />
        <span className="muted">Loading your conversation plans…</span>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Conversation plans"
        subtitle="Your regular conversations — who with, how often, and what needs attention."
      />
      {failed && (
        <div className="banner banner-danger" role="alert">
          We couldn’t load your plans just now. Please try again.
        </div>
      )}
      {!failed && grouped.length === 0 && (
        <EmptyState
          icon={<CalendarHeart size={36} aria-hidden="true" />}
          title="No conversation plans yet"
          body="When you arrange regular conversations with a Companion, the plan lives here."
          action={<Link className="btn btn-primary" to="/explore">Explore Companions</Link>}
        />
      )}
      <div className="stack-list">
        {grouped.map((v) => (
          <PlanCard key={v.plan.id} view={v} viewerTz={viewerTz} coordinator={isCoordinator} />
        ))}
      </div>

      {/* Legacy compatibility, deliberately last: earlier standalone test
          bundles stay reachable so previously created data isn't hidden. */}
      <PackageDashboard />
    </div>
  );
}

/** Mock mode keeps its lightweight prototype equivalent. */
function MockPlans() {
  const state = useAppState();
  const me = currentUser(state);
  const focus = activeMember(state);
  const target = focus ?? me;
  const purchases = purchasesForMember(state, target.id).filter((p) => p.status === 'active');

  return (
    <div>
      <PageHeader title="Conversation plans" subtitle="Your regular conversations." />
      {purchases.length === 0 ? (
        <EmptyState
          icon={<CalendarHeart size={36} aria-hidden="true" />}
          title="No conversation plans yet"
          body="Arrange regular conversations with a Companion from their profile."
          action={<Link className="btn btn-primary" to="/explore">Explore Companions</Link>}
        />
      ) : (
        <div className="stack-list">
          {purchases.map((p) => {
            const comp = state.users.find((u) => u.id === p.companionId);
            if (!comp) return null;
            return (
              <div key={p.id} className="card col" style={{ gap: 6 }}>
                <span className="bold">Regular conversations with {comp.firstName}</span>
                <span className="muted">
                  {remainingCredits(p)} of {p.callsTotal} conversations remaining · until {formatDate(p.expiresAt)}
                </span>
                <Link to={`/people/${comp.id}`} className="btn btn-secondary btn-small" style={{ alignSelf: 'flex-start' }}>
                  View {comp.firstName}’s profile
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function PlansPage() {
  return isSupabaseMode() ? <SupabasePlans /> : <MockPlans />;
}
