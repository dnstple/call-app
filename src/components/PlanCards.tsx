/**
 * Stage 2E4B — "Your conversation plans" (Supabase mode).
 *
 * Members and Coordinators see their ongoing companionship arrangements;
 * Companions see plan requests to accept or decline. Nothing here mentions
 * packages, credits or purchases — that engine stays hidden.
 * planRepository is the only data path.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarHeart, Loader2 } from 'lucide-react';
import type {
  ConversationPlanRow,
  MyBookingRow,
  PlanScheduleSlotRow,
} from '../supabase/database.types';
import {
  acceptPlan,
  declinePlan,
  extendPlanBookings,
  getPlanSlots,
  listMyPlans,
  listPlanBookings,
  nextConversation,
  PlanError,
} from '../repositories/planRepository';
import { useAuthSnapshot } from '../state/authBridge';
import { browserTimezone } from '../domain/timezones';
import { scheduleSummary } from './PlanWizard';

export const PLAN_STATUS_LABELS: Record<ConversationPlanRow['status'], string> = {
  requested: 'Pending approval',
  active: 'Active',
  paused: 'Paused',
  ended: 'Ended',
  declined: 'Not taken up',
};

const STATUS_BADGE: Record<ConversationPlanRow['status'], string> = {
  requested: 'badge-neutral',
  active: 'badge-success',
  paused: 'badge-neutral',
  ended: 'badge-neutral',
  declined: 'badge-neutral',
};

export function frequencyLabel(plan: Pick<ConversationPlanRow, 'frequency_per_week'>): string {
  return `${plan.frequency_per_week} conversation${plan.frequency_per_week === 1 ? '' : 's'} per week`;
}

interface PlanView {
  plan: ConversationPlanRow;
  slots: PlanScheduleSlotRow[];
  bookings: MyBookingRow[];
}

function nextLabel(view: PlanView, viewerTz: string): string | null {
  const next = nextConversation(view.bookings);
  if (!next) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: viewerTz, weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(next.starts_at));
}

/**
 * Member/Coordinator view: the plans they hold with Companions.
 * Opportunistically tops up the rolling window on load (idempotent).
 */
export function ConversationPlans() {
  const auth = useAuthSnapshot();
  const viewerTz = browserTimezone();
  const [views, setViews] = useState<PlanView[] | null>(null);

  const memberIds = auth.profiles
    .filter((p) => p.profile.role === 'member' && p.access.can_book)
    .map((p) => p.profile.id);
  const key = memberIds.join(',');

  const load = useCallback(async () => {
    try {
      const plans = (await listMyPlans()).filter(
        (p) => memberIds.includes(p.member_profile_id) && ['requested', 'active', 'paused'].includes(p.status),
      );
      const loaded = await Promise.all(
        plans.map(async (plan) => {
          if (plan.status === 'active') {
            // Rolling 4-week window: safe, idempotent, cheap to retry.
            await extendPlanBookings(plan.id).catch(() => undefined);
          }
          const [slots, bookings] = await Promise.all([
            getPlanSlots(plan.id).catch(() => []),
            listPlanBookings(plan.id).catch(() => []),
          ]);
          return { plan, slots, bookings };
        }),
      );
      setViews(loaded);
    } catch {
      setViews([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (memberIds.length === 0) {
      setViews([]);
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (memberIds.length === 0) return null;
  if (views === null) {
    return (
      <section className="section-tight" aria-label="Conversation plans">
        <h2>Your conversation plans</h2>
        <div className="row" style={{ gap: 10 }}>
          <Loader2 size={18} aria-hidden="true" />
          <span className="muted">Loading your plans…</span>
        </div>
      </section>
    );
  }
  if (views.length === 0) return null; // Explore prompt already covers this

  return (
    <section className="section-tight" aria-label="Conversation plans">
      <h2>Your conversation plans</h2>
      <div className="stack-list">
        {views.map((view) => {
          const member = auth.profiles.find((p) => p.profile.id === view.plan.member_profile_id)?.profile;
          const isCoordinatorView = auth.profiles.some(
            (p) => p.profile.role === 'coordinator' && p.access.access_role === 'owner',
          );
          const next = nextLabel(view, viewerTz);
          const companionTz = view.slots[0]?.timezone ?? 'Europe/London';
          return (
            <div key={view.plan.id} className="card card-tight col" style={{ gap: 8 }}>
              <div className="row between wrap" style={{ gap: 8 }}>
                <span className="row bold" style={{ gap: 8 }}>
                  <CalendarHeart size={18} aria-hidden="true" />
                  {isCoordinatorView && member
                    ? `${member.first_name}’s conversation plan`
                    : 'Regular conversations'}
                </span>
                <span className={`badge ${STATUS_BADGE[view.plan.status]}`}>
                  {PLAN_STATUS_LABELS[view.plan.status]}
                </span>
              </div>
              <span className="muted">{frequencyLabel(view.plan)}</span>
              {view.slots.length > 0 && (
                <span className="faint">
                  {scheduleSummary(
                    view.slots.map((s) => ({ day: s.iso_day, time: s.local_time.slice(0, 5) })),
                    companionTz,
                    viewerTz,
                  )}
                </span>
              )}
              {view.plan.status === 'active' && (
                <span className="muted">
                  {next ? <>Next conversation: <strong>{next}</strong></> : 'No conversations scheduled yet'}
                </span>
              )}
              {view.plan.status === 'requested' && (
                <span className="faint">Waiting for the companion to confirm.</span>
              )}
              {view.plan.status === 'paused' && (
                <span className="faint">Paused — no conversations are scheduled.</span>
              )}
              <Link
                to={`/people/${view.plan.companion_profile_id}`}
                className="btn btn-secondary btn-small"
                style={{ alignSelf: 'flex-start' }}
              >
                View profile
              </Link>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Companion view: plan requests to accept once. Accepting generates the
 * conversations automatically (Stage 2E4A backend).
 */
export function CompanionPlanRequests() {
  const auth = useAuthSnapshot();
  const viewerTz = browserTimezone();
  const [views, setViews] = useState<PlanView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const companionIds = auth.profiles
    .filter((p) => p.profile.role === 'companion' && p.access.can_edit)
    .map((p) => p.profile.id);
  const key = companionIds.join(',');

  const load = useCallback(async () => {
    try {
      const plans = (await listMyPlans()).filter(
        (p) => companionIds.includes(p.companion_profile_id) && p.status === 'requested',
      );
      const loaded = await Promise.all(
        plans.map(async (plan) => ({
          plan,
          slots: await getPlanSlots(plan.id).catch(() => []),
          bookings: [] as MyBookingRow[],
        })),
      );
      setViews(loaded);
    } catch {
      setViews([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (companionIds.length === 0) {
      setViews([]);
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const act = (planId: string, fn: () => Promise<unknown>) => async () => {
    if (busy) return; // duplicate-click protection
    setBusy(planId);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof PlanError ? e.message : 'That didn’t work. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  if (companionIds.length === 0 || !views || views.length === 0) return null;

  return (
    <section className="section-tight" aria-label="Plan requests">
      <h2>Requests for regular conversations</h2>
      {error && <p role="alert" className="badge badge-danger" style={{ display: 'block', marginBottom: 10 }}>{error}</p>}
      <div className="stack-list">
        {views.map(({ plan, slots }) => {
          const companionTz = slots[0]?.timezone ?? 'Europe/London';
          return (
            <div key={plan.id} className="card card-tight col" style={{ gap: 8 }}>
              <span className="bold">{frequencyLabel(plan)}</span>
              {slots.length > 0 && (
                <span className="muted">
                  {scheduleSummary(
                    slots.map((s) => ({ day: s.iso_day, time: s.local_time.slice(0, 5) })),
                    companionTz,
                    viewerTz,
                  )}
                </span>
              )}
              <span className="faint">
                {plan.duration_minutes} minutes each · you’ll confirm this once, then the conversations
                appear in your diary.
              </span>
              <div className="row wrap" style={{ gap: 8 }}>
                <button
                  className="btn btn-primary btn-small"
                  disabled={busy === plan.id}
                  onClick={act(plan.id, () => acceptPlan(plan.id))}
                >
                  {busy === plan.id ? 'Saving…' : 'Accept plan'}
                </button>
                <button
                  className="btn btn-secondary btn-small"
                  disabled={busy === plan.id}
                  onClick={act(plan.id, () => declinePlan(plan.id))}
                >
                  Decline
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
