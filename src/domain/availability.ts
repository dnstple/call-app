import type { AvailabilityException, AvailabilityRule, Booking } from '../types';
import { hasConflict } from './bookings';

export interface Slot {
  startISO: string;
  endISO: string;
}

/**
 * Generate bookable slots for a Companion over the next `days` days from
 * recurring weekly rules, minus exceptions, minimum notice and existing bookings.
 * Slots are aligned to the hour/half-hour based on duration.
 */
export function generateSlots(
  rules: AvailabilityRule[],
  exceptions: AvailabilityException[],
  bookings: Booking[],
  companionId: string,
  durationMins: number,
  now: Date,
  days = 14,
): Slot[] {
  const myRules = rules.filter((r) => r.companionId === companionId);
  if (myRules.length === 0) return [];
  const horizon = Math.min(days, Math.max(...myRules.map((r) => r.bookingHorizonDays)));
  const slots: Slot[] = [];

  for (let d = 0; d <= horizon; d++) {
    const day = new Date(now);
    day.setDate(day.getDate() + d);
    day.setHours(0, 0, 0, 0);
    const dateStr = toDateString(day);

    const exception = exceptions.find((e) => e.companionId === companionId && e.date === dateStr);
    if (exception && !exception.available) continue;

    for (const rule of myRules) {
      if (rule.weekday !== day.getDay()) continue;
      const minNoticeMs = rule.minNoticeHours * 3600_000;
      const stepMins = durationMins <= 30 ? 30 : durationMins;

      for (
        let mins = rule.startHour * 60;
        mins + durationMins <= rule.endHour * 60;
        mins += stepMins
      ) {
        const start = new Date(day);
        start.setMinutes(mins);
        const end = new Date(start.getTime() + durationMins * 60_000);
        if (start.getTime() - now.getTime() < minNoticeMs) continue;
        if (hasConflict(bookings, companionId, start.toISOString(), end.toISOString())) continue;
        slots.push({ startISO: start.toISOString(), endISO: end.toISOString() });
      }
    }
  }
  return slots.sort((a, b) => a.startISO.localeCompare(b.startISO));
}

export function toDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function nextAvailableLabel(slots: Slot[], now: Date): string {
  if (slots.length === 0) return 'No availability';
  const first = new Date(slots[0].startISO);
  const diffDays = Math.floor((startOfDay(first).getTime() - startOfDay(now).getTime()) / 86_400_000);
  if (diffDays <= 0) return 'Available today';
  if (diffDays === 1) return 'Available tomorrow';
  return `Available ${first.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}`;
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}
