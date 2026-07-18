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
  PlanMemberProfilePayload,
  PlanScheduleSlotRow,
  SlotPreviewPayload,
} from '../supabase/database.types';
import {
  acceptPlan,
  declinePlan,
  extendPlanBookings,
  getPlanMemberProfile,
  getPlanSlots,
  hasRecurringConflict,
  listMyPlans,
  listPlanBookings,
  nextConversation,
  oneOffConflicts,
  PLAN_MESSAGE_MAX,
  PlanError,
  previewPlanSchedule,
} from '../repositories/planRepository';
import { avatarUrl } from '../repositories/profileRepository';
import { formatMinor } from '../repositories/availabilityRepository';
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

/** Everything a Companion needs to decide on one plan request. */
interface RequestView extends PlanView {
  member: PlanMemberProfilePayload | null;
  photo?: string;
  preview: SlotPreviewPayload[] | null;
  /** Interests the Companion also has come first; three at most are shown. */
  interests: string[];
}

function requestDateLabel(iso: string, viewerTz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: viewerTz, day: 'numeric', month: 'long',
  }).format(new Date(iso));
}

/**
 * Companion view: rich plan-request cards. The Companion sees who the
 * Member is (safe, plan-scoped profile), what is being asked, the price,
 * any schedule conflicts, and can respond with an optional message.
 * Accepting generates the conversations automatically (Stage 2E4A backend).
 */
export function CompanionPlanRequests() {
  const auth = useAuthSnapshot();
  const viewerTz = browserTimezone();
  const [views, setViews] = useState<RequestView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** planId → open response box ('accept' | 'decline') and its message. */
  const [responding, setResponding] = useState<{ planId: string; kind: 'accept' | 'decline' } | null>(null);
  const [responseMessage, setResponseMessage] = useState('');

  const companionProfiles = auth.profiles.filter(
    (p) => p.profile.role === 'companion' && p.access.can_edit,
  );
  const companionIds = companionProfiles.map((p) => p.profile.id);
  const key = companionIds.join(',');

  const load = useCallback(async () => {
    try {
      const plans = (await listMyPlans()).filter(
        (p) => companionIds.includes(p.companion_profile_id) && p.status === 'requested',
      );
      const myInterests = new Set(
        companionProfiles.flatMap((p) => p.profile.interests ?? []).map((i) => i.toLowerCase()),
      );
      const loaded = await Promise.all(
        plans.map(async (plan): Promise<RequestView> => {
          const [slots, member] = await Promise.all([
            getPlanSlots(plan.id).catch(() => [] as PlanScheduleSlotRow[]),
            getPlanMemberProfile(plan.id).catch(() => null),
          ]);
          const preview = slots.length > 0
            ? await previewPlanSchedule(
                plan.member_profile_id,
                plan.companion_profile_id,
                plan.duration_minutes,
                slots.map((s) => ({ day: s.iso_day, time: s.local_time.slice(0, 5) })),
              ).catch(() => null)
            : null;
          const photo = member?.avatar_path
            ? await avatarUrl(member.avatar_path).catch(() => undefined)
            : undefined;
          const all = member?.interests ?? [];
          const shared = all.filter((i) => myInterests.has(i.toLowerCase()));
          const interests = [...shared, ...all.filter((i) => !shared.includes(i))].slice(0, 3);
          return { plan, slots, bookings: [] as MyBookingRow[], member, photo, preview, interests };
        }),
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
      setResponding(null);
      setResponseMessage('');
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
        {views.map(({ plan, slots, member, photo, preview, interests }) => {
          const companionTz = slots[0]?.timezone ?? 'Europe/London';
          const name = member
            ? `${member.first_name}${member.last_initial ? ` ${member.last_initial}.` : ''}`
            : 'A member';
          const requestedBy = member
            ? member.requested_by_is_member
              ? `Requested by ${member.first_name} on ${requestDateLabel(member.requested_at, viewerTz)}`
              : `Requested by ${member.requested_by_first_name} for ${member.first_name} on ${requestDateLabel(member.requested_at, viewerTz)}`
            : null;
          const recurringBlocked = preview ? hasRecurringConflict(preview) : false;
          const oneOffs = preview ? oneOffConflicts(preview) : [];
          const isResponding = responding?.planId === plan.id ? responding.kind : null;
          return (
            <div key={plan.id} className="card col" style={{ gap: 10 }}>
              <div className="row between wrap" style={{ gap: 8 }}>
                <div className="row" style={{ gap: 12 }}>
                  {photo ? (
                    <img src={photo} alt="" width={52} height={52} style={{ borderRadius: 14, objectFit: 'cover' }} />
                  ) : (
                    <span
                      className="avatar"
                      aria-hidden="true"
                      style={{ width: 52, height: 52, borderRadius: 14, background: member?.avatar_color ?? 'var(--surface-muted)', fontSize: 20 }}
                    >
                      {name[0]}
                    </span>
                  )}
                  <div className="col" style={{ gap: 2 }}>
                    <span className="bold">{name}</span>
                    <span className="faint">
                      {[member?.age_band, member?.region].filter(Boolean).join(' · ') || 'Prefers not to say'}
                    </span>
                  </div>
                </div>
                <span className="badge badge-neutral">{PLAN_STATUS_LABELS[plan.status]}</span>
              </div>

              {member?.bio && (
                <p className="muted longform" style={{ margin: 0 }}>
                  {member.bio.length > 220 ? `${member.bio.slice(0, 220)}…` : member.bio}
                </p>
              )}

              {interests.length > 0 && (
                <div className="row wrap" style={{ gap: 6 }}>
                  {interests.map((i) => (
                    <span key={i} className="chip">{i}</span>
                  ))}
                </div>
              )}

              <div className="col" style={{ gap: 4 }}>
                <span className="bold">{frequencyLabel(plan)} · {plan.duration_minutes} minutes each</span>
                {slots.length > 0 && (
                  <span className="muted">
                    {scheduleSummary(
                      slots.map((s) => ({ day: s.iso_day, time: s.local_time.slice(0, 5) })),
                      companionTz,
                      viewerTz,
                    )}
                  </span>
                )}
                <span className="faint">Times shown in your timezone ({viewerTz}) · In-app conversations</span>
                <span className="muted">
                  You’d receive <strong>{formatMinor(plan.weekly_price_minor)}</strong> per week
                </span>
              </div>

              {plan.request_message && (
                <blockquote className="card card-muted longform" style={{ margin: 0, fontStyle: 'italic' }}>
                  “{plan.request_message}”
                </blockquote>
              )}

              {requestedBy && <span className="faint">{requestedBy}</span>}

              {recurringBlocked && (
                <div className="banner banner-danger" role="alert">
                  These weekly times clash with your existing diary every week over the next four weeks,
                  so this plan can’t be accepted as requested. Ask for a different weekly time.
                </div>
              )}
              {!recurringBlocked && oneOffs.length > 0 && (
                <div className="banner banner-warning">
                  {oneOffs.length === 1 ? 'The first occurrence conflicts' : `${oneOffs.length} occurrences conflict`} with
                  an existing conversation. If you accept, {oneOffs.length === 1 ? 'that occurrence' : 'those occurrences'} will
                  be skipped (never double-booked, never charged) and a replacement can be arranged.
                </div>
              )}

              {isResponding && (
                <div className="field col" style={{ gap: 4, marginBottom: 0 }}>
                  <label htmlFor={`plan-response-${plan.id}`} className="bold">
                    {isResponding === 'accept'
                      ? `Add a short reply for ${member?.requested_by_first_name ?? name} (optional)`
                      : 'Let them know why (optional)'}
                  </label>
                  <textarea
                    id={`plan-response-${plan.id}`}
                    rows={3}
                    maxLength={PLAN_MESSAGE_MAX}
                    value={responseMessage}
                    onChange={(e) => setResponseMessage(e.target.value)}
                    placeholder={isResponding === 'accept'
                      ? `e.g. “I’d be very happy to speak with ${member?.first_name ?? 'them'}.”`
                      : 'e.g. “I’m sorry, but these regular times do not work for me.”'}
                  />
                  <span className="faint" style={{ alignSelf: 'flex-end' }}>
                    {responseMessage.length}/{PLAN_MESSAGE_MAX}
                  </span>
                </div>
              )}

              <div className="row wrap" style={{ gap: 8 }}>
                <Link to={`/plans/${plan.id}/member`} className="btn btn-secondary btn-small">
                  View {member ? `${member.first_name}’s` : 'the'} profile
                </Link>
                {!isResponding && (
                  <>
                    <button
                      className="btn btn-primary btn-small"
                      disabled={busy === plan.id || recurringBlocked}
                      onClick={() => {
                        setResponding({ planId: plan.id, kind: 'accept' });
                        setResponseMessage('');
                      }}
                    >
                      Accept plan
                    </button>
                    <button
                      className="btn btn-ghost btn-small"
                      disabled={busy === plan.id}
                      onClick={() => {
                        setResponding({ planId: plan.id, kind: 'decline' });
                        setResponseMessage('');
                      }}
                    >
                      Decline
                    </button>
                  </>
                )}
                {isResponding === 'accept' && (
                  <button
                    className="btn btn-primary btn-small"
                    disabled={busy === plan.id || recurringBlocked}
                    onClick={act(plan.id, () => acceptPlan(plan.id, responseMessage.trim() || undefined))}
                  >
                    {busy === plan.id ? 'Saving…' : 'Confirm and accept'}
                  </button>
                )}
                {isResponding === 'decline' && (
                  <button
                    className="btn btn-danger btn-small"
                    disabled={busy === plan.id}
                    onClick={act(plan.id, () => declinePlan(plan.id, responseMessage.trim() || undefined))}
                  >
                    {busy === plan.id ? 'Saving…' : 'Confirm decline'}
                  </button>
                )}
                {isResponding && (
                  <button className="btn btn-ghost btn-small" onClick={() => setResponding(null)}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
