/**
 * The ONE shared date & time chooser — calm, multi-step, reusable.
 *
 * Redesign: one decision at a time. Step 1 shows EVERY available date in
 * the horizon as a scrollable grid (Today/Tomorrow labelled in the
 * viewer's timezone) so the flow's action buttons keep a fixed position.
 * Step 2 shows ONLY that date's times, grouped Morning/Afternoon/Evening
 * with progressive "Show more times". A persistent summary line and Back
 * keep the choice visible; the parent flow provides the confirm step and
 * ALL business logic — every slot here is server-generated, and the
 * emitted value is the untouched authoritative slot.
 *
 * Used by: TestCallWizard, SupabaseBookingWizard/SlotPicker (booking +
 * proposals), BookingDetail reschedule, PlanDetail.
 */
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CalendarClock, Loader2 } from 'lucide-react';
import type { AvailableSlot } from '../repositories/bookingRepository';
import { browserTimezone } from '../domain/timezones';

/** How far ahead we ask the server for slots (its horizon still wins). */
export const SLOT_WINDOW_DAYS = 60;

export function dayKeyInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

export function timeInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

function keyToDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Group real slots by their calendar day in the viewer's timezone. */
export function groupSlotsByDay(slots: AvailableSlot[], tz: string): Map<string, AvailableSlot[]> {
  const map = new Map<string, AvailableSlot[]>();
  for (const s of slots) {
    const key = dayKeyInTz(s.startsAt, tz);
    map.set(key, [...(map.get(key) ?? []), s]);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }
  return map;
}

/** Today/Tomorrow in the DISPLAYED timezone, else "Mon 20 July". */
function friendlyDay(key: string, tz: string): string {
  const todayKey = dayKeyInTz(new Date().toISOString(), tz);
  const tomorrowKey = dayKeyInTz(new Date(Date.now() + 24 * 3600_000).toISOString(), tz);
  if (key === todayKey) return 'Today';
  if (key === tomorrowKey) return 'Tomorrow';
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
    .format(keyToDate(key));
}

/** Morning < 12:00 ≤ afternoon < 17:00 ≤ evening (displayed timezone). */
function daypartOf(iso: string, tz: string): 'Morning' | 'Afternoon' | 'Evening' {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', hour12: false,
  }).format(new Date(iso)));
  return hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
}

const INITIAL_TIMES_PER_PART = 8;

export function DateTimeSlotPicker({
  slots,
  loading = false,
  error = null,
  selected,
  onSelect,
  onRetry,
  emptyMessage = 'No available dates found.',
  dateHeading = 'Choose a date',
  timeHeading = 'Choose a time',
}: {
  /** Server-generated slots. Never fabricate these client-side. */
  slots: AvailableSlot[];
  loading?: boolean;
  error?: string | null;
  selected: AvailableSlot | null;
  onSelect: (slot: AvailableSlot) => void;
  onRetry?: () => void;
  emptyMessage?: string;
  /** Context copy, e.g. "Choose a new date" for rescheduling. */
  dateHeading?: string;
  timeHeading?: string;
}) {
  const viewerTz = browserTimezone();
  const byDay = useMemo(() => groupSlotsByDay(slots, viewerTz), [slots, viewerTz]);
  const availableKeys = useMemo(() => [...byDay.keys()].sort(), [byDay]);

  const [dayKey, setDayKey] = useState<string | null>(
    selected ? dayKeyInTz(selected.startsAt, viewerTz) : null,
  );
  const [expandedParts, setExpandedParts] = useState<Record<string, boolean>>({});

  // A vanished day (stale availability) drops back to the date step.
  useEffect(() => {
    if (dayKey && availableKeys.length > 0 && !byDay.has(dayKey)) setDayKey(null);
  }, [dayKey, byDay, availableKeys.length]);

  if (loading) {
    return (
      <div className="dtp2 row" style={{ gap: 10 }}>
        <Loader2 size={20} aria-hidden="true" />
        <span className="muted">Finding available times…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="dtp2 col" style={{ gap: 10 }}>
        <p className="muted" role="alert" style={{ margin: 0 }}>{error}</p>
        {onRetry && (
          <button className="btn btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    );
  }
  if (slots.length === 0) {
    return <p className="muted dtp2">{emptyMessage}</p>;
  }

  const summary = (
    <p className="dtp2-summary" aria-live="polite">
      {dayKey ? (
        <>
          <strong>
            {new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
              .format(keyToDate(dayKey))}
          </strong>
          {' · '}
          {selected && dayKeyInTz(selected.startsAt, viewerTz) === dayKey
            ? <strong>{timeInTz(selected.startsAt, viewerTz)}</strong>
            : 'Select a time'}
        </>
      ) : 'Select a date'}
    </p>
  );

  /* ---------------- Step 1: choose a date ---------------- */
  if (!dayKey) {
    return (
      <div className="dtp2 col" style={{ gap: 10 }}>
        <div className="row between wrap" style={{ gap: 8 }}>
          <h4 className="dtp2-heading">{dateHeading}</h4>
          <span className="dtp2-steps" aria-label="Step 1 of 3: date">Date → Time → Confirm</span>
        </div>
        {/* EVERY future date with real availability, in one scrollable
            grid — the flow's action buttons keep their fixed place below. */}
        <div className="dtp2-dates" role="group" aria-label="Available dates">
          {availableKeys.map((key) => (
            <button
              key={key}
              className="dtp2-date"
              aria-label={`${new Intl.DateTimeFormat('en-GB', {
                weekday: 'long', day: 'numeric', month: 'long',
              }).format(keyToDate(key))}, ${byDay.get(key)!.length} times available`}
              onClick={() => setDayKey(key)}
            >
              <span className="dtp2-date-day">{friendlyDay(key, viewerTz)}</span>
              <span className="faint small">
                {byDay.get(key)!.length} time{byDay.get(key)!.length === 1 ? '' : 's'}
              </span>
            </button>
          ))}
        </div>
        <span className="faint row" style={{ gap: 6 }}>
          <CalendarClock size={14} aria-hidden="true" /> Times shown in {viewerTz}
        </span>
      </div>
    );
  }

  /* ---------------- Step 2: choose a time ---------------- */
  const dayTimes = byDay.get(dayKey) ?? [];
  const parts: ['Morning' | 'Afternoon' | 'Evening', AvailableSlot[]][] =
    (['Morning', 'Afternoon', 'Evening'] as const)
      .map((p) => [p, dayTimes.filter((s) => daypartOf(s.startsAt, viewerTz) === p)] as
        ['Morning' | 'Afternoon' | 'Evening', AvailableSlot[]])
      .filter(([, list]) => list.length > 0);

  return (
    <div className="dtp2 col" style={{ gap: 10 }}>
      <div className="row between wrap" style={{ gap: 8 }}>
        <h4 className="dtp2-heading">{timeHeading}</h4>
        <span className="dtp2-steps" aria-label="Step 2 of 3: time">Date → Time → Confirm</span>
      </div>
      {summary}
      {dayTimes.length === 0 ? (
        <div className="col" style={{ gap: 8 }}>
          <p className="muted" style={{ margin: 0 }}>No times are available on this date.</p>
          <button className="btn btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => setDayKey(null)}>
            Choose another date
          </button>
        </div>
      ) : (
        parts.map(([part, list]) => {
          const expanded = expandedParts[part];
          const shown = expanded ? list : list.slice(0, INITIAL_TIMES_PER_PART);
          return (
            <div key={part} className="col" style={{ gap: 6 }}>
              <span className="dtp2-part">{part}</span>
              <div className="dtp2-times" role="group" aria-label={`${part} times`}>
                {shown.map((slot) => {
                  const isSelected = selected?.startsAt === slot.startsAt;
                  return (
                    <button
                      key={slot.startsAt}
                      className={`dtp2-time${isSelected ? ' selected' : ''}`}
                      aria-pressed={isSelected}
                      aria-label={`${new Intl.DateTimeFormat('en-GB', {
                        timeZone: viewerTz, weekday: 'long', day: 'numeric', month: 'long',
                      }).format(new Date(slot.startsAt))} at ${timeInTz(slot.startsAt, viewerTz)} ${viewerTz}`}
                      onClick={() => onSelect(slot)}
                    >
                      {timeInTz(slot.startsAt, viewerTz)}
                    </button>
                  );
                })}
              </div>
              {!expanded && list.length > INITIAL_TIMES_PER_PART && (
                <button
                  className="btn btn-ghost btn-small"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => setExpandedParts((e) => ({ ...e, [part]: true }))}
                >
                  Show more times
                </button>
              )}
            </div>
          );
        })
      )}
      <div className="row between wrap" style={{ gap: 8 }}>
        <button className="btn btn-ghost btn-small" onClick={() => setDayKey(null)}>
          <ArrowLeft size={16} aria-hidden="true" /> Back to dates
        </button>
        <span className="faint row" style={{ gap: 6 }}>
          <CalendarClock size={14} aria-hidden="true" /> Times shown in {viewerTz}
        </span>
      </div>
    </div>
  );
}
