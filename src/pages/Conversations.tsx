/**
 * Redesign Phase E — the unified Conversations section.
 *
 * The authoritative schedule and relationship centre: needs-attention
 * items above the agenda, a seven-day date strip, Today/Tomorrow-grouped
 * agenda rows, a compact Regular-plans area (plan management lives at
 * /conversations/plans/:planId), and month-grouped Past with outcome
 * filters. Home deliberately shows only a small action-focused slice of
 * this data — this page owns the full schedule.
 *
 * Mock mode keeps the Stage 1 fictional experience with the same
 * unified structure (no separate Plans navigation anywhere).
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, ChevronLeft, ChevronRight, Loader2, Phone } from 'lucide-react';
import { attentionItems, type ViewerRole } from '../domain/conversationAttention';
import { ProfileAvatar } from '../components/ProfileAvatar';
import { useProfileAvatars } from '../state/avatars';
import { useAppState } from '../state/store';
import { currentUser, visibleBookings } from '../state/selectors';
import { isSupabaseMode } from '../config/dataMode';
import { ConversationRow } from '../components/ConversationRow';
import { ManagingContext } from '../components/ManagingContext';
import { EmptyState, PageHeader } from '../components/ui';
import type { Booking } from '../types';
import type { MyBookingRow } from '../supabase/database.types';
import {
  canConfirmCompletion,
  derivedStatusLabel,
  listMyBookings,
  splitBookings,
} from '../repositories/bookingRepository';
import { listMyPlans } from '../repositories/planRepository';
import type { ConversationPlanRow } from '../supabase/database.types';
import { browserTimezone } from '../domain/timezones';
import { slotTimeLabel } from '../components/SupabaseBookingWizard';
import { isSupabaseConfigured } from '../supabase/client';

/* ---------------- shared helpers ---------------- */

const DAY_MS = 24 * 3_600_000;

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function dayKey(iso: string): string {
  return startOfDay(new Date(iso)).toISOString();
}

function dayHeading(iso: string, now = new Date()): string {
  const d = startOfDay(new Date(iso));
  const today = startOfDay(now);
  const diff = Math.round((d.getTime() - today.getTime()) / DAY_MS);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

function monthLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

/** Small semantic type label — payment source is deliberately NOT a type. */
function typeLabel(b: MyBookingRow): string {
  if (b.plan_id) return 'Weekly plan';
  if (b.is_trial) return 'Trial';
  return 'One-off';
}

/** Ready-to-join window mirrors the call room: 10 min before → end. */
function readyToJoin(b: MyBookingRow, now = Date.now()): boolean {
  return b.status === 'confirmed'
    && now >= new Date(b.starts_at).getTime() - 10 * 60_000
    && now <= new Date(b.ends_at).getTime();
}

function statusPill(b: MyBookingRow): { text: string; cls: string } | null {
  // Waiting on the other party is INFORMATION (dusty blue), never amber.
  if (b.status === 'requested') return { text: 'Awaiting reply', cls: 'pill-info' };
  if (b.status === 'change_proposed') return { text: 'New time proposed', cls: 'pill-attention' };
  if (b.status === 'needs_review') return { text: 'Needs review', cls: 'pill-attention' };
  if (readyToJoin(b)) return { text: 'Ready to join', cls: 'pill-ready' };
  if (b.status === 'confirmed' && new Date(b.ends_at).getTime() <= Date.now()) {
    return { text: 'Confirm outcome', cls: 'pill-attention' };
  }
  if (b.status === 'confirmed') return { text: 'Confirmed', cls: 'pill-ready' };
  if (b.status === 'cancelled' || b.status === 'declined') return { text: 'Cancelled', cls: 'pill-blocked' };
  if (b.status === 'completed') return { text: 'Completed', cls: 'pill-ready' };
  return null;
}

/* ---------------- agenda row ---------------- */

export function AgendaRow({ booking, viewerRole, needsAction, highlight, softened }: {
  booking: MyBookingRow;
  viewerRole: string;
  /** Item also appears in the attention panel: compact "Needs action" marker. */
  needsAction?: boolean;
  /** The next upcoming conversation today. */
  highlight?: boolean;
  /** Earlier today, already over — visually softened. */
  softened?: boolean;
}) {
  const navigate = useNavigate();
  const viewerTz = browserTimezone();
  const pill = statusPill(booking);
  const joinable = readyToJoin(booking);
  // Role-aware counterpart: Coordinators see the Companion's image; the
  // Companion sees the managed Member's image.
  const counterpartId = viewerRole === 'companion'
    ? booking.member_profile_id
    : booking.companion_profile_id;
  const avatarOf = useProfileAvatars([counterpartId]);
  const counterpart = viewerRole === 'companion'
    ? `${booking.member_first_name}${booking.member_last_initial ? ` ${booking.member_last_initial}.` : ''}`
    : `${booking.companion_first_name}${booking.companion_last_initial ? ` ${booking.companion_last_initial}.` : ''}`;
  return (
    <button
      className={`agenda-row${highlight ? ' agenda-next' : ''}${softened ? ' agenda-softened' : ''}`}
      onClick={() => navigate(`/conversations/${booking.id}`)}
      aria-label={`Conversation with ${counterpart}, ${slotTimeLabel(booking.starts_at, viewerTz)}`}
    >
      {highlight && <span className="agenda-next-label" aria-hidden="true">Next</span>}
      <span className="agenda-time">
        {slotTimeLabel(booking.starts_at, viewerTz)}
        <span className="agenda-duration">{booking.duration_minutes} min</span>
      </span>
      <ProfileAvatar name={counterpart} url={avatarOf(counterpartId)} size="sm" alt="" statusDot={joinable} />
      <span className="col grow" style={{ gap: 2, minWidth: 0, textAlign: 'left' }}>
        <span className="bold">{counterpart}</span>
        <span className="faint small">
          {viewerRole !== 'companion' && `For ${booking.member_first_name} · `}
          {typeLabel(booking)}
        </span>
      </span>
      {needsAction && <span className="pill pill-attention">Needs action</span>}
      {!needsAction && pill && <span className={`pill ${pill.cls}`}>{pill.text}</span>}
      {joinable && (
        <span
          className="btn btn-primary btn-small"
          role="link"
          aria-label="Join the call"
          onClick={(e) => { e.stopPropagation(); navigate(`/conversations/${booking.id}/call`); }}
        >
          Join
        </span>
      )}
    </button>
  );
}

/** Legacy row export kept for Home/BookingDetail imports. */
export function SupabaseBookingRow({ booking }: { booking: MyBookingRow }) {
  const navigate = useNavigate();
  const viewerTz = browserTimezone();
  const state = useAppState();
  const viewerRole = currentUser(state).role;
  const counterpartId = viewerRole === 'companion'
    ? booking.member_profile_id
    : booking.companion_profile_id;
  const counterpartName = viewerRole === 'companion'
    ? booking.member_first_name
    : booking.companion_first_name;
  const avatarOf = useProfileAvatars([counterpartId]);
  return (
    <button
      className="card card-tight card-click row wrap"
      style={{ gap: 12, textAlign: 'left' }}
      onClick={() => navigate(`/conversations/${booking.id}`)}
      aria-label={`View conversation between ${booking.member_first_name} and ${booking.companion_first_name}`}
    >
      <ProfileAvatar name={counterpartName} url={avatarOf(counterpartId)} size="sm" alt="" />
      <span className="col grow" style={{ gap: 2 }}>
        <span className="bold">
          {booking.member_first_name} &amp; {booking.companion_first_name}
          {booking.companion_last_initial ? ` ${booking.companion_last_initial}.` : ''}
        </span>
        <span className="muted small">
          {dayHeading(booking.starts_at)} · {slotTimeLabel(booking.starts_at, viewerTz)} ·{' '}
          {booking.duration_minutes} mins · {typeLabel(booking)}
        </span>
        <span className="faint small">{derivedStatusLabel(booking)}</span>
      </span>
    </button>
  );
}

/** Attention rows carry the same person image as the agenda (one avatar
 * system) inside the panel's distinct container. */
function AttentionItemRow({ booking: b, att, role }: {
  booking: MyBookingRow;
  att: { kind?: string; reason?: string; action?: string };
  role: string;
}) {
  const counterpartId = role === 'companion' ? b.member_profile_id : b.companion_profile_id;
  const counterpartName = role === 'companion' ? b.member_first_name : b.companion_first_name;
  const avatarOf = useProfileAvatars([counterpartId]);
  return (
    <li className={`attention-item${att.kind === 'blocked' ? ' blocked' : ''}`}>
      <ProfileAvatar name={counterpartName} url={avatarOf(counterpartId)} size="xs" alt="" />
      <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
        <span className="bold small">
          {dayHeading(b.starts_at)}’s conversation with {counterpartName}
        </span>
        <span className="muted small">{att.reason}</span>
      </span>
      <Link to={`/conversations/${b.id}`} className="btn btn-secondary btn-small">
        {att.action}
      </Link>
    </li>
  );
}

/* ---------------- Supabase mode ---------------- */

type TabKey = 'upcoming' | 'past';
type PastFilter = 'all' | 'completed' | 'cancelled' | 'needs_review';

function SupabaseConversations() {
  const state = useAppState();
  const role = currentUser(state).role as ViewerRole;
  const viewerTz = browserTimezone();
  const [tab, setTab] = useState<TabKey>('upcoming');
  const [pastFilter, setPastFilter] = useState<PastFilter>('all');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  // Visible-range model: the strip anchors on TODAY and shows today + the
  // next six days (the established product convention); prev/next move the
  // whole range by seven days. weekOffset 0 = the current week.
  const [weekOffset, setWeekOffset] = useState(0);
  const [rows, setRows] = useState<MyBookingRow[] | null>(null);
  const [plans, setPlans] = useState<ConversationPlanRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (!isSupabaseConfigured()) {
      setRows([]);
      return;
    }
    // ONE range query: my_bookings returns the account's full schedule
    // (RLS-scoped, bounded by real activity). Date navigation filters this
    // cached set client-side — never a request per day or per range hop.
    listMyBookings()
      .then((r) => live && setRows(r))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'We couldn’t load your conversations.'));
    listMyPlans()
      .then((p) => live && setPlans(p.filter((x) => ['requested', 'active', 'paused'].includes(x.status))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const { upcoming, past } = useMemo(() => splitBookings(rows ?? []), [rows]);

  // Plan-row avatars (batched with every other avatar request on the page).
  const planAvatarOf = useProfileAvatars(
    plans.map((p) => (role === 'companion' ? p.member_profile_id : p.companion_profile_id)),
  );

  // Role-aware attention: ONLY items the signed-in user can act on now.
  // "Awaiting reply" (requested, member-side) stays in the agenda.
  const attention = useMemo(
    () => attentionItems(rows ?? [], role),
    [rows, role],
  );
  const attentionIds = useMemo(() => new Set(attention.map((a) => a.booking.id)), [attention]);

  // The date pool the strip counts against (upcoming or past mode).
  const stripPool = tab === 'upcoming' ? upcoming : past;

  const rangeStart = useMemo(
    () => new Date(startOfDay(new Date()).getTime() + weekOffset * 7 * DAY_MS),
    [weekOffset],
  );
  const rangeEnd = useMemo(() => new Date(rangeStart.getTime() + 6 * DAY_MS), [rangeStart]);

  const week = useMemo(() => {
    const todayKey = startOfDay(new Date()).toISOString();
    return [...Array(7)].map((_, i) => {
      const day = new Date(rangeStart.getTime() + i * DAY_MS);
      const key = day.toISOString();
      const dayBookings = stripPool.filter((b) => dayKey(b.starts_at) === key);
      return {
        key,
        label: day.toLocaleDateString('en-GB', { weekday: 'short' }),
        date: day.getDate(),
        isToday: key === todayKey,
        count: dayBookings.length,
        // Aggregated, restrained markers: action beats waiting beats ready.
        hasAttention: dayBookings.some((b) => attentionIds.has(b.id)),
        hasAwaiting: dayBookings.some((b) => b.status === 'requested'),
        hasReady: dayBookings.some((b) => readyToJoin(b)),
      };
    });
  }, [stripPool, rangeStart, attentionIds]);

  const rangeLabel = useMemo(() => {
    const sameMonth = rangeStart.getMonth() === rangeEnd.getMonth();
    const startLabel = rangeStart.toLocaleDateString('en-GB', sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'long' });
    const endLabel = rangeEnd.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    return `${startLabel}–${endLabel}`;
  }, [rangeStart, rangeEnd]);

  // Agenda: within the visible range (or the single selected day).
  const agenda = useMemo(() => {
    const inRange = (b: MyBookingRow) => {
      const t = new Date(b.starts_at).getTime();
      return t >= rangeStart.getTime() && t < rangeEnd.getTime() + DAY_MS;
    };
    const list = selectedDay
      ? upcoming.filter((b) => dayKey(b.starts_at) === selectedDay)
      : upcoming.filter(inRange);
    const map = new Map<string, MyBookingRow[]>();
    for (const b of [...list].sort((a, z) => a.starts_at.localeCompare(z.starts_at))) {
      const key = dayKey(b.starts_at);
      map.set(key, [...(map.get(key) ?? []), b]);
    }
    return [...map.entries()];
  }, [upcoming, selectedDay, rangeStart, rangeEnd]);

  const todayKey = startOfDay(new Date()).toISOString();
  const showTodayEmpty = weekOffset === 0 && !selectedDay
    && !agenda.some(([key]) => key === todayKey);
  // The next upcoming conversation today (highlighted inside Today).
  const nextTodayId = useMemo(() => {
    const now = Date.now();
    return upcoming
      .filter((b) => dayKey(b.starts_at) === todayKey && new Date(b.ends_at).getTime() > now)
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0]?.id ?? null;
  }, [upcoming, todayKey]);

  const filteredPast = useMemo(() => {
    let list = past;
    if (pastFilter === 'completed') list = list.filter((b) => b.status === 'completed');
    if (pastFilter === 'cancelled') list = list.filter((b) => ['cancelled', 'declined'].includes(b.status));
    if (pastFilter === 'needs_review') list = list.filter((b) => b.status === 'needs_review' || canConfirmCompletion(b));
    if (selectedDay) list = list.filter((b) => dayKey(b.starts_at) === selectedDay);
    return list;
  }, [past, pastFilter, selectedDay]);

  const pastGrouped = useMemo(() => {
    const map = new Map<string, MyBookingRow[]>();
    for (const b of filteredPast) {
      const key = monthLabel(b.starts_at);
      map.set(key, [...(map.get(key) ?? []), b]);
    }
    return [...map.entries()];
  }, [filteredPast]);

  return (
    <div>
      <header className="page-header">
        <h1>Conversations</h1>
        <ManagingContext />
        <p className="faint small" style={{ margin: '2px 0 0' }}>All times shown in {viewerTz}</p>
      </header>

      <div className="tabs" role="tablist" aria-label="Conversation groups">
        <button role="tab" className="tab" aria-selected={tab === 'upcoming'} onClick={() => setTab('upcoming')}>
          Upcoming
        </button>
        <button role="tab" className="tab" aria-selected={tab === 'past'} onClick={() => setTab('past')}>
          Past
        </button>
      </div>

      {error ? (
        <p className="muted section-tight" role="alert">{error}</p>
      ) : rows === null ? (
        <div className="row section-tight" style={{ gap: 10 }}>
          <Loader2 size={20} aria-hidden="true" /> <span className="muted">Loading conversations…</span>
        </div>
      ) : tab === 'upcoming' ? (
        <div className="col section-tight" style={{ gap: 24 }}>
          {/* Needs YOUR attention — an action summary, visually distinct
              from the agenda; hidden entirely when nothing needs action. */}
          {attention.length > 0 && (
            <section className="attention-panel" aria-label="Needs your attention">
              <div className="row between wrap" style={{ gap: 8 }}>
                <h2 className="attention-title">
                  <AlertCircle size={17} aria-hidden="true" />
                  Needs your attention
                  <span className="attention-count" aria-label={`${attention.length} items`}>{attention.length}</span>
                </h2>
              </div>
              <p className="muted small" style={{ margin: '0 0 4px' }}>
                Items below need a response before they can go ahead.
              </p>
              <ul className="attention-list">
                {attention.map(({ booking: b, state: att }) => (
                  <AttentionItemRow key={`att-${b.id}`} booking={b} att={att} role={role} />
                ))}
              </ul>
            </section>
          )}

          {/* Date navigation: seven days at a time, anchored on today.
              Arrows keep FIXED positions (left/right edges); the Today
              shortcut lives on its own line below. Upcoming mode never
              navigates before the current week. */}
          <section aria-label="Date navigation">
            <div className="date-strip-nav">
              <button
                className="icon-btn date-nav-btn"
                aria-label="Previous seven days"
                disabled={weekOffset <= 0}
                onClick={() => { setWeekOffset((o) => Math.max(0, o - 1)); setSelectedDay(null); }}
              >
                <ChevronLeft size={20} aria-hidden="true" />
              </button>
              <span className="date-range-label" aria-live="polite">{rangeLabel}</span>
              <button
                className="icon-btn date-nav-btn"
                aria-label="Next seven days"
                onClick={() => { setWeekOffset((o) => o + 1); setSelectedDay(null); }}
              >
                <ChevronRight size={20} aria-hidden="true" />
              </button>
            </div>
            {weekOffset !== 0 && (
              <div className="date-nav-today">
                <button
                  className="btn btn-ghost btn-small"
                  onClick={() => { setWeekOffset(0); setSelectedDay(null); }}
                >
                  Today
                </button>
              </div>
            )}
            <div className="date-strip" role="group" aria-label="Choose a day">
              {week.map((d) => (
                <button
                  key={d.key}
                  className={`date-strip-day${selectedDay === d.key ? ' selected' : ''}${d.isToday ? ' is-today' : ''}`}
                  aria-pressed={selectedDay === d.key}
                  aria-current={d.isToday ? 'date' : undefined}
                  onClick={() => setSelectedDay(selectedDay === d.key ? null : d.key)}
                >
                  <span className="dow">{d.label}</span>
                  <span className="dom">{d.date}</span>
                  {d.count > 0 && (
                    <span
                      className={`date-strip-count${d.hasAttention ? ' attention' : d.hasReady ? ' ready' : d.hasAwaiting ? ' awaiting' : ''}`}
                      aria-label={`${d.count} conversation${d.count === 1 ? '' : 's'}${d.hasAttention ? ', action required' : ''}`}
                    >
                      {d.count}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>

          {/* Today first — the clear priority — then the rest of the range. */}
          {showTodayEmpty && (
            <section className="agenda-today" aria-label="Today">
              <h2 className="agenda-today-heading">
                Today
                <span className="agenda-today-date">
                  {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
                </span>
              </h2>
              <p className="muted" style={{ margin: 0 }}>No conversations scheduled for today.</p>
            </section>
          )}
          {agenda.length === 0 ? (
            selectedDay ? (
              <div className="col" style={{ gap: 8 }}>
                <p className="muted" style={{ margin: 0 }}>No conversations scheduled for this day.</p>
                <button className="btn btn-ghost btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => setSelectedDay(null)}>
                  Show the whole week
                </button>
              </div>
            ) : (
              <EmptyState
                icon={<Phone size={36} aria-hidden="true" />}
                title="No conversations in this week"
                body="Use the arrows to look at other weeks, or arrange a new conversation."
                action={
                  role === 'companion' ? undefined : (
                    <Link to="/explore" className="btn btn-primary">Explore Companions</Link>
                  )
                }
              />
            )
          ) : (
            agenda.map(([key, dayBookings]) => {
              const isToday = key === todayKey;
              const rowsFor = dayBookings.map((b) => (
                <AgendaRow
                  key={b.id}
                  booking={b}
                  viewerRole={role}
                  needsAction={attentionIds.has(b.id)}
                  highlight={isToday && b.id === nextTodayId}
                  softened={isToday && new Date(b.ends_at).getTime() < Date.now() && b.id !== nextTodayId}
                />
              ));
              return isToday ? (
                <section key={key} className="agenda-today" aria-label="Today">
                  <h2 className="agenda-today-heading">
                    Today
                    <span className="agenda-today-date">
                      {new Date(key).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
                    </span>
                  </h2>
                  <div className="stack-list">{rowsFor}</div>
                </section>
              ) : (
                <section key={key} aria-label={dayHeading(dayBookings[0].starts_at)}>
                  <h2 className="section-label">{dayHeading(dayBookings[0].starts_at)}</h2>
                  <div className="stack-list">{rowsFor}</div>
                </section>
              );
            })
          )}

          {/* Regular plans — compact, never duplicated as occurrence rows */}
          {plans.length > 0 && (
            <section aria-label="Regular plans">
              <h2 className="section-label">Regular plans</h2>
              <div className="stack-list">
                {plans.map((p) => {
                  // Names ride on the booking rows for the same pair.
                  const sample = (rows ?? []).find(
                    (b) => b.member_profile_id === p.member_profile_id
                      && b.companion_profile_id === p.companion_profile_id,
                  );
                  const pairLabel = sample
                    ? `${sample.member_first_name} & ${sample.companion_first_name}`
                    : 'Weekly conversation plan';
                  const planCounterpartId = role === 'companion' ? p.member_profile_id : p.companion_profile_id;
                  const planCounterpartName = sample
                    ? (role === 'companion' ? sample.member_first_name : sample.companion_first_name)
                    : '';
                  return (
                  <Link key={p.id} to={`/conversations/plans/${p.id}`} className="agenda-row" style={{ textDecoration: 'none' }}>
                    <ProfileAvatar
                      name={planCounterpartName}
                      url={planAvatarOf(planCounterpartId)}
                      size="sm"
                      alt=""
                    />
                    <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                      <span className="bold">{pairLabel}</span>
                      <span className="faint small">
                        {p.frequency_per_week}× per week · {p.duration_minutes} mins
                      </span>
                    </span>
                    <span className={`pill ${p.status === 'active' ? 'pill-ready' : p.status === 'paused' ? 'pill-neutral' : 'pill-info'}`}>
                      {p.status === 'requested' ? 'Requested' : p.status === 'paused' ? 'Paused' : 'Active'}
                    </span>
                    <span className="btn btn-ghost btn-small" aria-hidden="true">Manage plan</span>
                  </Link>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      ) : (
        <div className="col section-tight" style={{ gap: 16 }}>
          {/* Past mode keeps the same range navigation (earlier weeks) but
              never shows future-only join controls. */}
          <div className="date-strip-nav">
            <button
              className="icon-btn date-nav-btn"
              aria-label="Previous seven days"
              onClick={() => { setWeekOffset((o) => o - 1); setSelectedDay(null); }}
            >
              <ChevronLeft size={20} aria-hidden="true" />
            </button>
            <span className="date-range-label" aria-live="polite">{rangeLabel}</span>
            <button
              className="icon-btn date-nav-btn"
              aria-label="Next seven days"
              onClick={() => { setWeekOffset((o) => o + 1); setSelectedDay(null); }}
            >
              <ChevronRight size={20} aria-hidden="true" />
            </button>
          </div>
          {weekOffset !== 0 && (
            <div className="date-nav-today">
              <button className="btn btn-ghost btn-small" onClick={() => { setWeekOffset(0); setSelectedDay(null); }}>
                Today
              </button>
            </div>
          )}
          <label style={{ alignSelf: 'flex-end' }}>
            <span className="visually-hidden">Filter past conversations</span>
            <select
              className="quiet"
              value={pastFilter}
              onChange={(e) => setPastFilter(e.target.value as PastFilter)}
              aria-label="Filter past conversations"
            >
              <option value="all">All</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled or missed</option>
              <option value="needs_review">Needs review</option>
            </select>
          </label>
          {pastGrouped.length === 0 ? (
            <EmptyState title="No past conversations" body="Finished and cancelled conversations will appear here." />
          ) : (
            pastGrouped.map(([month, monthBookings]) => (
              <section key={month} aria-label={month}>
                <h2 className="section-label">{month}</h2>
                <div className="stack-list">
                  {monthBookings.map((b) => (
                    <AgendaRow key={b.id} booking={b} viewerRole={role} />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- mock mode (Stage 1 data, unified structure) ---------------- */

const UPCOMING_STATUSES = ['confirmed', 'in_progress', 'requested', 'draft', 'awaiting_completion', 'needs_review'];

export default function Conversations() {
  if (isSupabaseMode()) return <SupabaseConversations />;
  return <MockConversations />;
}

function MockConversations() {
  const state = useAppState();
  const [tab, setTab] = useState<TabKey>('upcoming');
  const [pastFilter, setPastFilter] = useState<'all' | 'completed' | 'cancelled'>('all');
  const bookings = visibleBookings(state);

  const upcoming = useMemo(
    () => bookings.filter((b) => UPCOMING_STATUSES.includes(b.status)),
    [bookings],
  );
  const past = useMemo(() => {
    let list = bookings.filter((b) => ['completed', 'cancelled', 'missed'].includes(b.status)).reverse();
    if (pastFilter === 'completed') list = list.filter((b) => b.status === 'completed');
    if (pastFilter === 'cancelled') list = list.filter((b) => b.status !== 'completed');
    return list;
  }, [bookings, pastFilter]);

  const current = tab === 'upcoming' ? upcoming : past;

  const grouped = useMemo(() => {
    const map = new Map<string, Booking[]>();
    for (const b of current) {
      const key = monthLabel(b.start);
      map.set(key, [...(map.get(key) ?? []), b]);
    }
    return [...map.entries()];
  }, [current]);

  return (
    <div>
      <header className="page-header">
        <h1>Conversations</h1>
        <ManagingContext />
        <p className="faint small" style={{ margin: '2px 0 0' }}>All times are shown in UK time.</p>
      </header>

      <div className="row wrap between" style={{ gap: 12 }}>
        <div className="tabs" role="tablist" aria-label="Conversation groups">
          <button role="tab" className="tab" aria-selected={tab === 'upcoming'} onClick={() => setTab('upcoming')}>
            Upcoming
          </button>
          <button role="tab" className="tab" aria-selected={tab === 'past'} onClick={() => setTab('past')}>
            Past
          </button>
        </div>
        {tab === 'past' && (
          <label>
            <span className="visually-hidden">Filter past conversations</span>
            <select
              className="quiet"
              value={pastFilter}
              onChange={(e) => setPastFilter(e.target.value as 'all' | 'completed' | 'cancelled')}
              aria-label="Filter past conversations"
            >
              <option value="all">All</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled or missed</option>
            </select>
          </label>
        )}
      </div>

      <div className="section-tight">
        {current.length === 0 ? (
          tab === 'upcoming' ? (
            <EmptyState
              icon={<Phone size={36} aria-hidden="true" />}
              title="No conversations scheduled"
              body="When you arrange a conversation, it will appear here."
              action={
                currentUser(state).role === 'companion' ? (
                  <Link to="/profile" className="btn btn-secondary">View my profile</Link>
                ) : (
                  <Link to="/explore" className="btn btn-primary">Explore Companions</Link>
                )
              }
            />
          ) : (
            <EmptyState
              title="No past conversations"
              body="Completed and cancelled conversations will appear here."
            />
          )
        ) : (
          <div className="col" style={{ gap: 24 }}>
            {grouped.map(([month, monthBookings]) => (
              <section key={month} aria-label={month}>
                <h3 className="muted" style={{ fontWeight: 600 }}>{month}</h3>
                <div className="stack-list">
                  {monthBookings.map((b) => (
                    <ConversationRow key={b.id} booking={b} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
