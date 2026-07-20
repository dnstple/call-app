/**
 * Stage 2E4D — /plans/:planId: everything about one conversation plan.
 *
 * Shows both people, the consent messages, the weekly schedule, honest
 * prototype billing, the next four weeks of real conversations, and any
 * scheduling issues — each resolvable through a controlled server
 * function that re-checks availability, both diaries and the two-hour
 * cutoff. Management actions (change / pause / resume / end / skip)
 * respect the approved consent rules. No package or credit vocabulary.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, CalendarDays, CalendarHeart, Loader2, PauseCircle,
  PlayCircle, XCircle,
} from 'lucide-react';
import { isSupabaseMode } from '../config/dataMode';
import type {
  ConversationPlanRow,
  MyBookingRow,
  PlanGenerationLogRow,
  PlanScheduleSlotRow,
} from '../supabase/database.types';
import {
  acceptPlanChange,
  declinePlanChange,
  endPlan,
  getPlan,
  getPlanGenerationLog,
  pausePlan,
  PLAN_MESSAGE_MAX,
  PlanError,
  resolvePlanOccurrence,
  resumePlan,
  retriableSkips,
  skipPlanOccurrence,
  updatePlanRequestMessage,
} from '../repositories/planRepository';
import { getAllAvailablePackageSlots } from '../repositories/packageRepository';
import { formatMinor } from '../repositories/availabilityRepository';
import { RESCHEDULE_OPEN_COPY } from '../repositories/bookingRepository';
import type { AvailableSlot } from '../repositories/bookingRepository';
import { useAuthSnapshot } from '../state/authBridge';
import { browserTimezone } from '../domain/timezones';
import { scheduleSummary } from '../components/PlanWizard';
import { PLAN_STATUS_LABELS } from '../components/PlanCards';
import { PlanChangeWizard } from '../components/PlanChangeWizard';
import { DateTimeSlotPicker, SLOT_WINDOW_DAYS } from '../components/DateTimeSlotPicker';
import { EmptyState, Modal } from '../components/ui';
import { IN_APP_CALL_LABEL } from '../components/FlowModal';
import { loadPlanOverview, nextConversationLabel, type PlanOverview } from './PlansPage';
import { MessageActionButton } from '../messaging/MessageAction';

const BILLING_NOTICE = 'Prototype weekly plan — no payment is currently taken.';
const BILLING_FUTURE = 'When payments are introduced, this plan will renew weekly.';

function fmt(iso: string, viewerTz: string, withTime = true): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: viewerTz, weekday: 'long', day: 'numeric', month: 'long',
    ...(withTime ? { hour: '2-digit' as const, minute: '2-digit' as const, hour12: false } : {}),
  }).format(new Date(iso));
}

/* ---------------- scheduling issues ---------------- */

function issueReason(log: PlanGenerationLogRow, memberName: string, companionName: string): string {
  if (log.outcome === 'skipped_conflict') {
    return `This conversation could not be scheduled because ${memberName} or ${companionName} already has another conversation at that time.`;
  }
  return `This conversation could not be scheduled because the time is outside ${companionName}’s current availability.`;
}

function SchedulingIssues({ view, onResolved }: { view: PlanOverview; onResolved: () => void }) {
  const viewerTz = browserTimezone();
  const [log, setLog] = useState<PlanGenerationLogRow[] | null>(null);
  const [resolving, setResolving] = useState<PlanGenerationLogRow | null>(null);
  const [slots, setSlots] = useState<AvailableSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [picked, setPicked] = useState<AvailableSlot | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getPlanGenerationLog(view.plan.id)
      .then((rows) => setLog(
        retriableSkips(rows).filter(
          (r) => new Date(r.intended_start) > new Date()
            // Pause-cancelled rows retry automatically on resume; only
            // conflict/availability issues need a human replacement.
            && (r.outcome === 'skipped_conflict' || r.outcome === 'skipped_availability'),
        ),
      ))
      .catch(() => setLog([]));
  }, [view.plan.id]);

  useEffect(() => {
    load();
  }, [load]);

  const loadSlots = useCallback((keepError = false) => {
    setSlotsLoading(true);
    if (!keepError) setError(null);
    const from = new Date(Date.now() + 2 * 3600_000).toISOString();
    const to = new Date(Date.now() + SLOT_WINDOW_DAYS * 86400_000).toISOString();
    getAllAvailablePackageSlots(view.plan.allowance_purchase_id, from, to)
      .then((s) => setSlots(s.map((x) => ({ startsAt: x.startsAt, endsAt: x.endsAt }))))
      .catch(() => setError('We couldn’t load available times. Please try again.'))
      .finally(() => setSlotsLoading(false));
  }, [view.plan.allowance_purchase_id]);

  const openResolver = (row: PlanGenerationLogRow) => {
    setResolving(row);
    setPicked(null);
    loadSlots();
  };

  const submit = async () => {
    if (!resolving || !picked || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await resolvePlanOccurrence(view.plan.id, resolving.intended_start, picked.startsAt);
      setResolving(null);
      load();
      onResolved();
    } catch (e) {
      if (e instanceof PlanError && e.code === 'slot_unavailable') {
        setError('That time has just become unavailable. Please choose another.');
        setPicked(null);
        loadSlots(true); // refresh the picker, keep the explanation visible
      } else if (e instanceof PlanError && e.code === 'already_resolved') {
        setError('This conversation has already been rearranged.');
        load();
      } else {
        setError(e instanceof PlanError ? e.message : 'That didn’t work. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (!log || log.length === 0) return null;
  const memberName = view.viewerSide === 'companion' ? view.counterpartName : (view.memberName ?? 'you');
  const companionName = view.viewerSide === 'companion' ? 'you' : view.counterpartName;

  return (
    <section className="card col" style={{ gap: 10 }} aria-label="Scheduling issues">
      <h2 className="row" style={{ gap: 8, margin: 0 }}>
        <AlertTriangle size={18} aria-hidden="true" /> Needs a new time
      </h2>
      {log.map((row) => (
        <div key={row.id} className="card card-muted col" style={{ gap: 6, minWidth: 0 }}>
          <span className="bold longform">{fmt(row.intended_start, viewerTz)}</span>
          <span className="muted longform">{issueReason(row, memberName, companionName)}</span>
          <span className="faint">Not yet rearranged — no allowance is held for it.</span>
          {view.plan.status === 'active' && (
            <button
              className="btn btn-primary btn-small"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => openResolver(row)}
            >
              Choose another time
            </button>
          )}
        </div>
      ))}

      {resolving && (
        <Modal title="Choose another time" onClose={() => setResolving(null)} wide>
          <div className="col" style={{ gap: 12 }}>
            <p className="muted longform" style={{ margin: 0 }}>
              Replacing the conversation intended for{' '}
              <strong>{fmt(resolving.intended_start, viewerTz)}</strong>. Only genuinely free
              times are shown. {RESCHEDULE_OPEN_COPY}
            </p>
            {error && <div className="banner banner-danger" role="alert">{error}</div>}
            <DateTimeSlotPicker
              slots={slots}
              loading={slotsLoading}
              selected={picked}
              onSelect={setPicked}
              onRetry={loadSlots}
              emptyMessage="No free times found — try again after the schedule changes."
            />
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setResolving(null)}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={!picked || submitting}
                onClick={() => void submit()}
              >
                {submitting ? 'Saving…' : 'Confirm new time'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

/* ---------------- consent messages ---------------- */

function MessagesCard({ view, requesterCanEdit, onSaved }: {
  view: PlanOverview;
  requesterCanEdit: boolean;
  onSaved: () => void;
}) {
  const { plan } = view;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(plan.request_message ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!plan.request_message && !plan.response_message && !requesterCanEdit) return null;

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await updatePlanRequestMessage(plan.id, draft.trim() || null);
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(e instanceof PlanError ? e.message : 'We couldn’t save your message. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const decisionLabel = plan.status === 'declined'
    ? 'Sent with their decline'
    : plan.status === 'requested'
      ? null
      : 'Sent with their acceptance';

  return (
    <section className="card col" style={{ gap: 8 }} aria-label="Messages">
      <h2 style={{ margin: 0 }}>Messages</h2>
      {plan.request_message && !editing && (
        <div className="col" style={{ gap: 4 }}>
          <span className="muted">Request message</span>
          <blockquote className="card card-muted longform" style={{ margin: 0, fontStyle: 'italic' }}>
            “{plan.request_message}”
          </blockquote>
        </div>
      )}
      {requesterCanEdit && plan.status === 'requested' && !editing && (
        <button className="btn btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => {
          setDraft(plan.request_message ?? '');
          setEditing(true);
        }}>
          {plan.request_message ? 'Edit message' : 'Add a message'}
        </button>
      )}
      {editing && (
        <div className="field col" style={{ gap: 4, marginBottom: 0 }}>
          <label htmlFor="edit-request-message" className="bold">Your message</label>
          <textarea
            id="edit-request-message"
            rows={4}
            maxLength={PLAN_MESSAGE_MAX}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <span className="faint" aria-live="polite" style={{ alignSelf: 'flex-end' }}>
            {draft.length}/{PLAN_MESSAGE_MAX} characters
          </span>
          {error && <div className="banner banner-danger" role="alert">{error}</div>}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-primary btn-small" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save message'}
            </button>
            <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {!editing && plan.status !== 'requested' && plan.request_message && (
        <span className="faint">This message is now locked — the plan has been decided.</span>
      )}
      {plan.response_message && (
        <div className="col" style={{ gap: 4 }}>
          <span className="muted">
            Reply from the Companion{decisionLabel ? ` · ${decisionLabel}` : ''}
          </span>
          <blockquote className="card card-muted longform" style={{ margin: 0, fontStyle: 'italic' }}>
            “{plan.response_message}”
          </blockquote>
        </div>
      )}
      <span className="faint">Messaging between Members and Companions will be added later.</span>
    </section>
  );
}

/* ---------------- pending change (comparison + consent) ---------------- */

function PendingChangeCard({ view, companionCanDecide, onDecided }: {
  view: PlanOverview;
  companionCanDecide: boolean;
  onDecided: () => void;
}) {
  const { plan, slots } = view;
  const viewerTz = browserTimezone();
  const companionTz = slots[0]?.timezone ?? 'Europe/London';
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const c = plan.pending_change;
  if (!c) return null;

  const act = async (kind: 'accept' | 'decline') => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'accept') await acceptPlanChange(plan.id, message.trim() || undefined);
      else await declinePlanChange(plan.id, message.trim() || undefined);
      onDecided();
    } catch (e) {
      setError(e instanceof PlanError ? e.message : 'That didn’t work. Please try again.');
      setBusy(null);
    }
  };

  return (
    <section className="card col" style={{ gap: 10 }} aria-label="Requested change">
      <h2 style={{ margin: 0 }}>Requested change</h2>
      <div className="grid-2" style={{ gap: 10 }}>
        <div className="card card-muted col" style={{ gap: 4, minWidth: 0 }}>
          <span className="muted">Current plan</span>
          <span className="bold">
            {plan.frequency_per_week} per week · {plan.duration_minutes} minutes
          </span>
          <span className="faint longform">
            {scheduleSummary(
              slots.map((s) => ({ day: s.iso_day, time: s.local_time.slice(0, 5) })),
              companionTz,
              viewerTz,
            )}
          </span>
          <span className="muted">{formatMinor(plan.weekly_price_minor)} per week</span>
        </div>
        <div className="card card-tight col" style={{ gap: 4, minWidth: 0 }}>
          <span className="muted">Requested change</span>
          <span className="bold">
            {c.frequency_per_week} per week · {c.duration_minutes} minutes
          </span>
          {c.slots && (
            <span className="faint longform">
              {scheduleSummary(c.slots, companionTz, viewerTz)}
            </span>
          )}
          <span className="muted">{formatMinor(c.weekly_price_minor)} per week</span>
        </div>
      </div>
      <span className="faint">
        The current plan continues under its existing terms until the Companion approves.
      </span>
      {companionCanDecide ? (
        <div className="col" style={{ gap: 8 }}>
          {error && <div className="banner banner-danger" role="alert">{error}</div>}
          <div className="field col" style={{ gap: 4, marginBottom: 0 }}>
            <label htmlFor="change-response" className="bold">Add a short reply (optional)</label>
            <textarea
              id="change-response"
              rows={2}
              maxLength={PLAN_MESSAGE_MAX}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn btn-primary btn-small" disabled={busy !== null} onClick={() => void act('accept')}>
              {busy === 'accept' ? 'Saving…' : 'Accept change'}
            </button>
            <button className="btn btn-ghost btn-small" disabled={busy !== null} onClick={() => void act('decline')}>
              {busy === 'decline' ? 'Saving…' : 'Decline change'}
            </button>
          </div>
        </div>
      ) : (
        <span className="badge badge-pending" style={{ alignSelf: 'flex-start' }}>
          Companion approval required
        </span>
      )}
    </section>
  );
}

/* ---------------- the page ---------------- */

export default function PlanDetail() {
  const { planId } = useParams<{ planId: string }>();
  const auth = useAuthSnapshot();
  const viewerTz = browserTimezone();

  const [view, setView] = useState<PlanOverview | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [modal, setModal] = useState<null | 'change' | 'pause' | 'end'>(null);
  const [pauseReason, setPauseReason] = useState('');
  const [resumeOn, setResumeOn] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmSkip, setConfirmSkip] = useState<MyBookingRow | null>(null);

  const companionIds = auth.profiles
    .filter((p) => p.profile.role === 'companion' && p.access.can_edit)
    .map((p) => p.profile.id);

  const load = useCallback(async () => {
    if (!planId) {
      setState('unavailable');
      return;
    }
    try {
      const plan = await getPlan(planId);
      if (!plan) {
        setState('unavailable');
        return;
      }
      const side = companionIds.includes(plan.companion_profile_id) ? 'companion' : 'member';
      setView(await loadPlanOverview(plan, side));
      setState('ready');
    } catch {
      setState('unavailable');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId, companionIds.join(',')]);

  useEffect(() => {
    void load();
  }, [load]);

  const upcoming = useMemo(
    () => (view?.bookings ?? [])
      .filter((b) => ['requested', 'confirmed', 'change_proposed'].includes(b.status)
        && new Date(b.starts_at) > new Date())
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
    [view],
  );

  if (!isSupabaseMode()) {
    return (
      <EmptyState
        title="Plan details live in Supabase mode"
        body="The prototype’s mock mode shows plans on the Home page instead."
        action={<Link className="btn btn-primary" to="/plans">Back to plans</Link>}
      />
    );
  }

  if (state === 'loading') {
    return (
      <div className="row" style={{ gap: 10, padding: 32 }}>
        <Loader2 size={20} aria-hidden="true" />
        <span className="muted">Loading plan…</span>
      </div>
    );
  }

  if (state === 'unavailable' || !view) {
    return (
      <EmptyState
        title="This plan isn’t available"
        body="It may have been removed, or you may not have access to it."
        action={<Link className="btn btn-primary" to="/plans">Back to plans</Link>}
      />
    );
  }

  const { plan, slots, counterpartName, memberName, viewerSide } = view;
  const companionTz = slots[0]?.timezone ?? 'Europe/London';
  const isRequester = plan.created_by_account_id === auth.userId;
  const canManage = viewerSide === 'member'; // owners/coordinators with can_book loaded this side
  const next = nextConversationLabel(view.bookings, viewerTz);

  const runAction = (label: string, fn: () => Promise<unknown>) => async () => {
    if (busy) return;
    setBusy(label);
    setActionError(null);
    try {
      await fn();
      setModal(null);
      setConfirmSkip(null);
      await load();
    } catch (e) {
      setActionError(e instanceof PlanError ? e.message : 'That didn’t work. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="col" style={{ gap: 14, maxWidth: 720 }}>
      <Link to="/plans" className="btn btn-ghost btn-small" style={{ alignSelf: 'flex-start' }}>
        <ArrowLeft size={16} aria-hidden="true" /> All plans
      </Link>

      <header className="card col" style={{ gap: 6 }}>
        <div className="row between wrap" style={{ gap: 8 }}>
          <h1 className="row longform" style={{ gap: 10, margin: 0, fontSize: 22, minWidth: 0 }}>
            <CalendarHeart size={22} aria-hidden="true" />
            {viewerSide === 'companion'
              ? `Regular conversations with ${counterpartName}`
              : memberName && !isRequesterMember(auth, plan)
                ? `${memberName}’s regular conversations with ${counterpartName}`
                : `Regular conversations with ${counterpartName}`}
          </h1>
          <span className="badge badge-neutral">{PLAN_STATUS_LABELS[plan.status]}</span>
        </div>
        <span className="muted">
          {plan.frequency_per_week} conversation{plan.frequency_per_week === 1 ? '' : 's'} per week ·{' '}
          {plan.duration_minutes} minutes · {IN_APP_CALL_LABEL}
        </span>
        {slots.length > 0 && (
          <span className="faint row longform" style={{ gap: 6 }}>
            <CalendarDays size={14} aria-hidden="true" />
            {scheduleSummary(
              slots.map((s) => ({ day: s.iso_day, time: s.local_time.slice(0, 5) })),
              companionTz,
              viewerTz,
            )}{' '}
            (your timezone, {viewerTz})
          </span>
        )}
        {plan.status === 'active' && next && (
          <span className="muted">Next conversation: <strong>{next}</strong></span>
        )}
        {plan.status === 'paused' && (
          <span className="faint">
            Paused{plan.pause_reason ? ` — ${plan.pause_reason}` : ''}
            {plan.resume_on ? ` · planned resume ${fmt(plan.resume_on, viewerTz, false)}` : ''}
          </span>
        )}
        <div className="row wrap" style={{ gap: 8 }}>
          {viewerSide === 'companion' ? (
            <Link to={`/plans/${plan.id}/member`} className="btn btn-secondary btn-small">
              View {counterpartName.split(' ')[0]}’s profile
            </Link>
          ) : (
            <Link to={`/people/${plan.companion_profile_id}`} className="btn btn-secondary btn-small">
              View {counterpartName.split(' ')[0]}’s profile
            </Link>
          )}
          {/* 2F2B: accepted plans (active/paused/ended) qualify for messaging. */}
          {['active', 'paused', 'ended'].includes(plan.status) && (
            <MessageActionButton
              small
              memberProfileId={plan.member_profile_id}
              companionProfileId={plan.companion_profile_id}
              label={`Message ${counterpartName.split(' ')[0]}`}
            />
          )}
        </div>
      </header>

      <section className="card col" style={{ gap: 4 }} aria-label="Weekly price">
        <div className="row between wrap" style={{ gap: 8 }}>
          <span className="muted">Weekly plan</span>
          <span className="bold">{formatMinor(plan.weekly_price_minor)} per week</span>
        </div>
        <span className="faint">{BILLING_NOTICE}</span>
        <span className="faint">{BILLING_FUTURE}</span>
      </section>

      <MessagesCard view={view} requesterCanEdit={isRequester && canManage} onSaved={() => void load()} />

      <PendingChangeCard
        view={view}
        companionCanDecide={viewerSide === 'companion'}
        onDecided={() => void load()}
      />

      <SchedulingIssues view={view} onResolved={() => void load()} />

      {upcoming.length > 0 && (
        <section className="card col" style={{ gap: 8 }} aria-label="Next four weeks">
          <h2 style={{ margin: 0 }}>Your next four weeks</h2>
          <div className="col" style={{ gap: 8 }}>
            {upcoming.map((b) => (
              <div key={b.id} className="card card-muted row between wrap" style={{ gap: 8, minWidth: 0 }}>
                <span className="col" style={{ gap: 2, minWidth: 0 }}>
                  <span className="bold longform">{fmt(b.starts_at, viewerTz)}</span>
                  <span className="faint">{b.duration_minutes} minutes · {IN_APP_CALL_LABEL}</span>
                </span>
                <span className="row wrap" style={{ gap: 6 }}>
                  <Link to={`/conversations/${b.id}`} className="btn btn-secondary btn-small">
                    Change this conversation only
                  </Link>
                  {canManage && (
                    <button className="btn btn-ghost btn-small" onClick={() => setConfirmSkip(b)}>
                      Skip
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
          <span className="faint">
            “Change this conversation only” keeps your weekly schedule unchanged. {RESCHEDULE_OPEN_COPY}
          </span>
        </section>
      )}

      {canManage && ['active', 'paused'].includes(plan.status) && (
        <section className="card col" style={{ gap: 8 }} aria-label="Manage plan">
          <h2 style={{ margin: 0 }}>Manage this plan</h2>
          {actionError && !modal && !confirmSkip && (
            <div className="banner banner-danger" role="alert">{actionError}</div>
          )}
          <div className="row wrap" style={{ gap: 8 }}>
            {plan.status === 'active' && !plan.pending_change && (
              <button className="btn btn-secondary btn-small" onClick={() => setModal('change')}>
                Change this and future conversations
              </button>
            )}
            {plan.status === 'active' && (
              <button className="btn btn-secondary btn-small" onClick={() => { setActionError(null); setModal('pause'); }}>
                <PauseCircle size={16} aria-hidden="true" /> Pause plan
              </button>
            )}
            {plan.status === 'paused' && (
              <button
                className="btn btn-primary btn-small"
                disabled={busy === 'resume'}
                onClick={runAction('resume', () => resumePlan(plan.id))}
              >
                <PlayCircle size={16} aria-hidden="true" /> {busy === 'resume' ? 'Resuming…' : 'Resume plan'}
              </button>
            )}
            <button className="btn btn-danger btn-small" onClick={() => { setActionError(null); setModal('end'); }}>
              <XCircle size={16} aria-hidden="true" /> End plan
            </button>
          </div>
        </section>
      )}

      {modal === 'change' && (
        <PlanChangeWizard
          plan={plan}
          currentSlots={slots}
          companionName={counterpartName.split(' ')[0]}
          onClose={() => setModal(null)}
          onProposed={() => { setModal(null); void load(); }}
        />
      )}

      {modal === 'pause' && (
        <Modal title="Pause plan" onClose={() => setModal(null)}>
          <div className="col" style={{ gap: 12 }}>
            <p className="muted longform" style={{ margin: 0 }}>
              Pausing stops future conversations from being arranged. Conversations starting within
              the next two hours happen as planned. Your schedule and price are kept for when you resume.
            </p>
            {actionError && <div className="banner banner-danger" role="alert">{actionError}</div>}
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="pause-resume">Planned resume date (optional)</label>
              <input
                id="pause-resume"
                type="date"
                min={new Date(Date.now() + 86400_000).toISOString().slice(0, 10)}
                value={resumeOn}
                onChange={(e) => setResumeOn(e.target.value)}
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="pause-reason">Reason (optional)</label>
              <input
                id="pause-reason"
                type="text"
                maxLength={200}
                value={pauseReason}
                onChange={(e) => setPauseReason(e.target.value)}
                placeholder="e.g. Away for two weeks"
              />
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setModal(null)}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={busy === 'pause'}
                onClick={runAction('pause', () => pausePlan(plan.id, pauseReason, resumeOn || undefined))}
              >
                {busy === 'pause' ? 'Pausing…' : 'Pause plan'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {modal === 'end' && (
        <Modal title="End plan" onClose={() => setModal(null)}>
          <div className="col" style={{ gap: 12 }}>
            <p className="muted longform" style={{ margin: 0 }}>
              Ending the plan stops future regular conversations. Existing conversations beginning
              within two hours will remain. Your conversation history and ratings are kept.
            </p>
            {actionError && <div className="banner banner-danger" role="alert">{actionError}</div>}
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setModal(null)}>Keep the plan</button>
              <button
                className="btn btn-danger"
                disabled={busy === 'end'}
                onClick={runAction('end', () => endPlan(plan.id))}
              >
                {busy === 'end' ? 'Ending…' : 'End plan'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {confirmSkip && (
        <Modal title="Skip this conversation" onClose={() => setConfirmSkip(null)}>
          <div className="col" style={{ gap: 12 }}>
            <p className="muted longform" style={{ margin: 0 }}>
              Skip the conversation on <strong>{fmt(confirmSkip.starts_at, viewerTz)}</strong>?
              Your regular schedule will continue afterwards, and nothing is charged for a
              skipped conversation.
            </p>
            {actionError && <div className="banner banner-danger" role="alert">{actionError}</div>}
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setConfirmSkip(null)}>Keep it</button>
              <button
                className="btn btn-danger"
                disabled={busy === 'skip'}
                onClick={runAction('skip', () => skipPlanOccurrence(confirmSkip.id))}
              >
                {busy === 'skip' ? 'Skipping…' : 'Skip this conversation'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Did the signed-in account request this plan as the Member themselves? */
function isRequesterMember(
  auth: ReturnType<typeof useAuthSnapshot>,
  plan: ConversationPlanRow,
): boolean {
  return auth.profiles.some(
    (p) => p.profile.id === plan.member_profile_id && p.access.access_role === 'owner'
      && p.profile.role === 'member',
  );
}
