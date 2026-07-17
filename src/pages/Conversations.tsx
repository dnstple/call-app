import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, Phone } from 'lucide-react';
import { useAppState } from '../state/store';
import { currentUser, visibleBookings } from '../state/selectors';
import { isSupabaseMode } from '../config/dataMode';
import { ConversationRow } from '../components/ConversationRow';
import { EmptyState, PageHeader } from '../components/ui';
import type { Booking } from '../types';
import type { MyBookingRow } from '../supabase/database.types';
import {
  derivedStatusLabel,
  listMyBookings,
  splitBookings,
} from '../repositories/bookingRepository';
import { formatMinor } from '../repositories/availabilityRepository';
import { browserTimezone } from '../domain/timezones';
import { slotDayLabel, slotTimeLabel } from '../components/SupabaseBookingWizard';
import { IN_APP_CALL_LABEL } from '../components/FlowModal';
import { isSupabaseConfigured } from '../supabase/client';

/* ---------------- Supabase mode: REAL bookings ---------------- */

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
          {slotDayLabel(booking.starts_at, viewerTz)} · {slotTimeLabel(booking.starts_at, viewerTz)} ({viewerTz}) ·{' '}
          {booking.duration_minutes} mins · {IN_APP_CALL_LABEL}
        </span>
        <span className="faint small">
          {booking.booking_source === 'package_credit'
            ? 'Package credit — no payment'
            : `${booking.is_trial ? 'Trial' : 'Standard'} · ${formatMinor(booking.price_minor, booking.currency)}`}{' '}
          · {derivedStatusLabel(booking)}
        </span>
      </span>
    </button>
  );
}

function SupabaseConversations() {
  const state = useAppState();
  const [tab, setTab] = useState<TabKey>('upcoming');
  const [rows, setRows] = useState<MyBookingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // Unconfigured client (e.g. tests): a fresh account is simply empty.
    if (!isSupabaseConfigured()) {
      setRows([]);
      return;
    }
    listMyBookings()
      .then((r) => live && setRows(r))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'We couldn’t load your conversations.'));
    return () => {
      live = false;
    };
  }, []);

  const { upcoming, past } = useMemo(() => splitBookings(rows ?? []), [rows]);
  const current = tab === 'upcoming' ? upcoming : past;

  return (
    <div>
      <PageHeader title="Conversations" subtitle={`All times are shown in your timezone (${browserTimezone()}).`} />

      <div className="tabs" role="tablist" aria-label="Conversation groups">
        <button role="tab" className="tab" aria-selected={tab === 'upcoming'} onClick={() => setTab('upcoming')}>
          Upcoming
        </button>
        <button role="tab" className="tab" aria-selected={tab === 'past'} onClick={() => setTab('past')}>
          Past
        </button>
      </div>

      <div className="section-tight">
        {error ? (
          <p className="muted" role="alert">{error}</p>
        ) : rows === null ? (
          <div className="row" style={{ gap: 10 }}>
            <Loader2 size={20} aria-hidden="true" /> <span className="muted">Loading conversations…</span>
          </div>
        ) : current.length === 0 ? (
          tab === 'upcoming' ? (
            <EmptyState
              icon={<Phone size={36} aria-hidden="true" />}
              title="No conversations scheduled"
              body="When you arrange a conversation, it will appear here."
              action={
                currentUser(state).role === 'companion' ? undefined : (
                  <Link to="/explore" className="btn btn-primary">Explore Companions</Link>
                )
              }
            />
          ) : (
            <EmptyState
              title="No past conversations"
              body="Declined, cancelled and finished conversations will appear here."
            />
          )
        ) : (
          <div className="stack-list">
            {current.map((b) => (
              <SupabaseBookingRow key={b.id} booking={b} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type TabKey = 'upcoming' | 'past';
type PastFilter = 'all' | 'completed' | 'cancelled';

const UPCOMING_STATUSES = ['confirmed', 'in_progress', 'requested', 'draft', 'awaiting_completion', 'needs_review'];

function monthLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

export default function Conversations() {
  if (isSupabaseMode()) return <SupabaseConversations />;
  return <MockConversations />;
}

/** The complete Stage 1 mock experience — unchanged. */
function MockConversations() {
  const state = useAppState();
  const [tab, setTab] = useState<TabKey>('upcoming');
  const [pastFilter, setPastFilter] = useState<PastFilter>('all');
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

  // Group rows by month for a calm, scannable schedule.
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
      <PageHeader title="Conversations" subtitle="All times are shown in UK time." />

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
              onChange={(e) => setPastFilter(e.target.value as PastFilter)}
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
                  isSupabaseMode() ? undefined : (
                    <Link to="/profile" className="btn btn-secondary">View my profile</Link>
                  )
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
