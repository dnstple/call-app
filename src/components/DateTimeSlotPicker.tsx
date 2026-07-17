/**
 * Corrective Stage 2E4B — the shared date & time chooser.
 *
 * A month calendar (react-day-picker) beside a panel of real times.
 * EVERY time shown comes from the server's slot generation — the browser
 * never invents availability. Dates with no server slots are disabled, as
 * are past dates and anything outside the Companion's notice or horizon
 * (the server simply returns nothing for those).
 *
 * Mobile: calendar stacked above the times. Desktop: side by side.
 */
import { useEffect, useMemo, useState } from 'react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/style.css';
import { CalendarClock, Loader2 } from 'lucide-react';
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

function dateToKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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

export function DateTimeSlotPicker({
  slots,
  loading = false,
  error = null,
  selected,
  onSelect,
  onRetry,
  emptyMessage = 'No available times in the next few weeks.',
}: {
  /** Server-generated slots. Never fabricate these client-side. */
  slots: AvailableSlot[];
  loading?: boolean;
  error?: string | null;
  selected: AvailableSlot | null;
  onSelect: (slot: AvailableSlot) => void;
  onRetry?: () => void;
  emptyMessage?: string;
}) {
  const viewerTz = browserTimezone();
  const byDay = useMemo(() => groupSlotsByDay(slots, viewerTz), [slots, viewerTz]);
  const availableKeys = useMemo(() => [...byDay.keys()].sort(), [byDay]);
  const firstKey = availableKeys[0];

  const [dayKey, setDayKey] = useState<string | null>(null);
  const [month, setMonth] = useState<Date | undefined>(undefined);

  // Follow the data: land on the first day that genuinely has times.
  useEffect(() => {
    if (!firstKey) return;
    setDayKey((prev) => (prev && byDay.has(prev) ? prev : firstKey));
    setMonth((prev) => prev ?? keyToDate(firstKey));
  }, [firstKey, byDay]);

  // Keep the selected time consistent with the chosen day.
  useEffect(() => {
    if (selected && dayKey && dayKeyInTz(selected.startsAt, viewerTz) !== dayKey) {
      // The user moved to another date: its times are shown below.
    }
  }, [selected, dayKey, viewerTz]);

  if (loading) {
    return (
      <div className="row" style={{ gap: 10 }}>
        <Loader2 size={20} aria-hidden="true" />
        <span className="muted">Finding available times…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="col" style={{ gap: 10 }}>
        <p className="muted" role="alert">{error}</p>
        {onRetry && (
          <button className="btn btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    );
  }
  if (slots.length === 0) {
    return <p className="muted">{emptyMessage}</p>;
  }

  const dayTimes = dayKey ? byDay.get(dayKey) ?? [] : [];
  const availableDates = availableKeys.map(keyToDate);
  const nextAvailable = firstKey ? keyToDate(firstKey) : undefined;

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row wrap between" style={{ gap: 8 }}>
        <span className="faint row" style={{ gap: 6 }}>
          <CalendarClock size={14} aria-hidden="true" />
          Times shown in your timezone ({viewerTz})
        </span>
        {nextAvailable && dayKey !== firstKey && (
          <button
            className="btn btn-ghost btn-small"
            onClick={() => {
              setDayKey(firstKey);
              setMonth(nextAvailable);
            }}
          >
            Next available
          </button>
        )}
      </div>

      <div className="dtp">
        <DayPicker
          mode="single"
          month={month}
          onMonthChange={setMonth}
          selected={dayKey ? keyToDate(dayKey) : undefined}
          onSelect={(date) => date && setDayKey(dateToKey(date))}
          // Only days the SERVER offered are choosable: past dates, notice
          // and horizon are already excluded by its slot generation.
          disabled={(date) => !availableKeys.includes(dateToKey(date))}
          startMonth={availableDates[0]}
          endMonth={availableDates[availableDates.length - 1]}
          weekStartsOn={1}
          showOutsideDays={false}
          aria-label="Choose a date"
        />

        <div className="col" style={{ gap: 8 }}>
          <span className="bold">
            {dayKey
              ? new Intl.DateTimeFormat('en-GB', {
                  weekday: 'long', day: 'numeric', month: 'long',
                }).format(keyToDate(dayKey))
              : 'Choose a date'}
          </span>
          {dayTimes.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>No times left on this day — try another date.</p>
          ) : (
            <div className="dtp-times" role="group" aria-label="Available times">
              {dayTimes.map((slot) => {
                const isSelected = selected?.startsAt === slot.startsAt;
                return (
                  <button
                    key={slot.startsAt}
                    className={`btn btn-small ${isSelected ? 'btn-primary' : 'btn-secondary'}`}
                    aria-pressed={isSelected}
                    onClick={() => onSelect(slot)}
                  >
                    {timeInTz(slot.startsAt, viewerTz)}
                  </button>
                );
              })}
            </div>
          )}
          {selected && (
            <p className="faint" style={{ margin: 0 }}>
              Chosen:{' '}
              <strong style={{ color: 'var(--color-text-primary)' }}>
                {new Intl.DateTimeFormat('en-GB', {
                  timeZone: viewerTz, weekday: 'long', day: 'numeric', month: 'long',
                  hour: '2-digit', minute: '2-digit', hour12: false,
                }).format(new Date(selected.startsAt))}
              </strong>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
