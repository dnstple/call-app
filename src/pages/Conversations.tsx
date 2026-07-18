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
import { CalendarHeart, Loader2, Phone } from 'lucide-react';
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

function statusPill(b: MyBookingRow): { text: string; cls: string } | null {
  if (b.status === 'requested') return { text: 'Awaiting reply', cls: 'pill-neutral' };
  if (b.status === 'change_proposed') return { text: 'New time proposed', cls: 'pill-attention' };
  if (b.status === 'needs_review') return { text: 'Needs review', cls: 'pill-attention' };
  if (b.status === 'confirmed' && new Date(b.ends_at).getTime() <= Date.now()) {
    return { text: 'Confirm outcome', cls: 'pill-attention' };
  }
  if (b.status === 'confirmed') return { text: 'Confirmed', cls: 'pill-ready' };
  if (b.status === 'cancelled' || b.status === 'declined') return { text: 'Cancelled', cls: 'pill-blocked' };
  if (b.status === 'completed') return { text: 'Completed', cls: 'pill-ready' };
  return null;
}

/* ---------------- agenda row ---------------- */

export function AgendaRow({ booking, viewerRole }: { booking: MyBookingRow; viewerRole: string }) {
  const navigate = useNavigate();
  const viewerTz = browserTimezone();
  const pill = statusPill(booking);
  const counterpart = viewerRole === 'companion'
    ? `${booking.member_first_name}${booking.member_last_initial ? ` ${booking.member_last_initial}.` : ''}`
    : `${booking.companion_first_name}${booking.companion_last_initial ? ` ${booking.companion_last_initial}.` : ''}`;
  return (
    <button
      className="agenda-row"
      onClick={() => navigate(`/conversations/${booking.id}`)}
      aria-label={`Conversation with ${counterpart}, ${slotTimeLabel(booking.starts_at, viewerTz)}`}
    >
      <span className="agenda-time">
        {slotTimeLabel(booking.starts_at, viewerTz)}
        <span className="agenda-duration">{booking.duration_minutes} min</span>
      </span>
      <span className="avatar msg-avatar" aria-hidden="true">{counterpart.slice(0, 1)}</span>
      <span className="col grow" style={{ gap: 2, minWidth: 0, textAlign: 'left' }}>
        <span className="bold">{counterpart}</span>
        <span className="faint small">
          {viewerRole !== 'companion' && `For ${booking.member_first_name} · `}
          {typeLabel(booking)}
        </span>
      </span>
      {pill && <span className={`pill ${pill.cls}`}>{pill.text}</span>}
    </button>
  );
}

/** Legacy row export kept for Home/BookingDetail imports. */
export function SupabaseBookingRow({ booking }: { booking: MyBookingRow }) {
  const navigate = useNavigate();
  const viewerTz = browserTimezone();
  return (
    <button
      className="card card-tight card-click row wrap"
      style={{ gap: 12, textAlign: 'left' }}
      onClick={() => navigate(`/conversations/${booking.id}`)}
      aria-label={`View conversation between ${booking.member_first_name} and ${booking.companion_first_name}`}
    >
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

/* ---------------- Supabase mode ---------------- */

type TabKey = 'upcoming' | 'past';
type PastFilter = 'all' | 'completed' | 'cancelled' | 'needs_review';

function SupabaseConversations() {
  const state = useAppState();
  const role = currentUser(state).role;
  const viewerTz = browserTimezone();
  const [tab, setTab] = useState<TabKey>('upcoming');
  const [pastFilter, setPastFilter] = useState<PastFilter>('all');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [rows, setRows] = useState<MyBookingRow[] | null>(null);
  const [plans, setPlans] = useState<ConversationPlanRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (!isSupabaseConfigured()) {
      setRows([]);
      return;
    }
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

  // Attention items float ABOVE the agenda — never buried in it.
  const attention = useMemo(() => {
    const list = (rows ?? []).filter(
      (b) => ['requested', 'change_proposed', 'needs_review'].includes(b.status) || canConfirmCompletion(b),
    );
    return list.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }, [rows]);

  // Seven-day date strip.
  const week = useMemo(() => {
    const today = startOfDay(new Date());
    return [...Array(7)].map((_, i) => {
      const day = new Date(today.getTime() + i * DAY_MS);
      const key = day.toISOString();
      const dayBookings = upcoming.filter((b) => dayKey(b.starts_at) === key);
      return {
        key,
        label: day.toLocaleDateString('en-GB', { weekday: 'short' }),
        date: day.getDate(),
        count: dayBookings.length,
        hasAttention: dayBookings.some((b) => ['requested', 'change_proposed'].includes(b.status)),
      };
    });
  }, [upcoming]);

  // Agenda grouped by day (optionally filtered to a chosen strip day).
  const agenda = useMemo(() => {
    const list = selectedDay
      ? upcoming.filter((b) => dayKey(b.starts_at) === selectedDay)
      : upcoming;
    const map = new Map<string, MyBookingRow[]>();
    for (const b of [...list].sort((a, z) => a.starts_at.localeCompare(z.starts_at))) {
      const key = dayKey(b.starts_at);
      map.set(key, [...(map.get(key) ?? []), b]);
    }
    return [...map.entries()];
  }, [upcoming, selectedDay]);

  const filteredPast = useMemo(() => {
    let list = past;
    if (pastFilter === 'completed') list = list.filter((b) => b.status === 'completed');
    if (pastFilter === 'cancelled') list = list.filter((b) => ['cancelled', 'declined'].includes(b.status));
    if (pastFilter === 'needs_review') list = list.filter((b) => b.status === 'needs_review' || canConfirmCompletion(b));
    return list;
  }, [past, pastFilter]);

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
          {/* Needs attention — always above the schedule */}
          {attention.length > 0 && (
            <section aria-label="Needs attention">
              <h2 className="section-label">Needs attention</h2>
              <div className="stack-list">
                {attention.map((b) => (
                  <AgendaRow key={`att-${b.id}`} booking={b} viewerRole={role} />
                ))}
              </div>
            </section>
          )}

          {/* Seven-day strip */}
          <section aria-label="Next seven days">
            <div className="date-strip" role="group" aria-label="Choose a day">
              {week.map((d) => (
                <button
                  key={d.key}
                  className={`date-strip-day${selectedDay === d.key ? ' selected' : ''}`}
                  aria-pressed={selectedDay === d.key}
                  onClick={() => setSelectedDay(selectedDay === d.key ? null : d.key)}
                >
                  <span className="dow">{d.label}</span>
                  <span className="dom">{d.date}</span>
                  {d.count > 0 && (
                    <span className={`date-strip-count${d.hasAttention ? ' attention' : ''}`}>{d.count}</span>
                  )}
                </button>
              ))}
            </div>
          </section>

          {/* Agenda */}
          {agenda.length === 0 ? (
            <EmptyState
              icon={<Phone size={36} aria-hidden="true" />}
              title={selectedDay ? 'Nothing on this day' : 'No conversations scheduled'}
              body={selectedDay ? 'Pick another day, or clear the day filter.' : 'When you arrange a conversation, it will appear here.'}
              action={
                role === 'companion' || selectedDay ? undefined : (
                  <Link to="/explore" className="btn btn-primary">Explore Companions</Link>
                )
              }
            />
          ) : (
            agenda.map(([key, dayBookings]) => (
              <section key={key} aria-label={dayHeading(dayBookings[0].starts_at)}>
                <h2 className="section-label">{dayHeading(dayBookings[0].starts_at)}</h2>
                <div className="stack-list">
                  {dayBookings.map((b) => (
                    <AgendaRow key={b.id} booking={b} viewerRole={role} />
                  ))}
                </div>
              </section>
            ))
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
                  return (
                  <Link key={p.id} to={`/conversations/plans/${p.id}`} className="agenda-row" style={{ textDecoration: 'none' }}>
                    <CalendarHeart size={20} aria-hidden="true" style={{ color: 'var(--color-brand-strong)' }} />
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
