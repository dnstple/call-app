/**
 * Timezone utilities — IANA names only, no manual offset arithmetic.
 * Built on Intl so daylight-saving transitions (e.g. Europe/London) are
 * handled by the platform's timezone database.
 */

export const COMMON_TIMEZONES = [
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Madrid',
  'Europe/Berlin',
  'Europe/Rome',
  'Europe/Warsaw',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Kolkata',
  'Asia/Karachi',
  'Australia/Sydney',
];

export const ISO_DAY_NAMES: Record<number, string> = {
  1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday',
  5: 'Friday', 6: 'Saturday', 7: 'Sunday',
};

export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function browserTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimezone(tz) ? tz : 'Europe/London';
  } catch {
    return 'Europe/London';
  }
}

/** Wall-clock parts of an instant in a given timezone. */
function partsInTz(date: Date, tz: string): { y: number; m: number; d: number; h: number; min: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const map = new Map(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    y: Number(map.get('year')),
    m: Number(map.get('month')),
    d: Number(map.get('day')),
    h: Number(map.get('hour')) % 24,
    min: Number(map.get('minute')),
  };
}

/**
 * Convert a wall-clock time in a timezone to a UTC Date (DST-safe).
 * Standard two-pass estimation via Intl — no manual offset tables.
 */
export function wallTimeToUtc(
  y: number, m: number, d: number, h: number, min: number, tz: string,
): Date {
  if (!isValidTimezone(tz)) throw new Error(`Invalid timezone: ${tz}`);
  let utc = Date.UTC(y, m - 1, d, h, min);
  // Two correction passes converge across DST transitions.
  for (let i = 0; i < 2; i++) {
    const p = partsInTz(new Date(utc), tz);
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    const want = Date.UTC(y, m - 1, d, h, min);
    utc += want - seen;
  }
  return new Date(utc);
}

/** Next calendar date (from a reference) that falls on the ISO weekday in tz. */
export function nextDateForIsoDay(isoDay: number, tz: string, from = new Date()): { y: number; m: number; d: number } {
  for (let offset = 0; offset < 7; offset++) {
    const candidate = new Date(from.getTime() + offset * 86_400_000);
    const p = partsInTz(candidate, tz);
    // Determine ISO weekday of that tz-local date.
    const weekdayName = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(candidate);
    const iso = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[weekdayName as 'Mon'];
    if (iso === isoDay) return { y: p.y, m: p.m, d: p.d };
  }
  throw new Error('Unreachable weekday search');
}

/**
 * Display a Companion's recurring window in the viewer's timezone.
 * Uses the next occurrence of that weekday, so DST is respected.
 * Returns e.g. { start: "09:00", end: "12:00", sameAsLocal: true }.
 */
export function windowInViewerTz(
  isoDay: number,
  startHHMM: string,
  endHHMM: string,
  companionTz: string,
  viewerTz: string = browserTimezone(),
): { start: string; end: string; sameAsLocal: boolean } {
  const [sh, sm] = startHHMM.split(':').map(Number);
  const [eh, em] = endHHMM.split(':').map(Number);
  const date = nextDateForIsoDay(isoDay, companionTz);
  const startUtc = wallTimeToUtc(date.y, date.m, date.d, sh, sm, companionTz);
  const endUtc = wallTimeToUtc(date.y, date.m, date.d, eh, em, companionTz);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: viewerTz, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const startLocal = fmt.format(startUtc);
  const endLocal = fmt.format(endUtc);
  return {
    start: startLocal,
    end: endLocal,
    sameAsLocal: startLocal === `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}` &&
      endLocal === `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`,
  };
}

/** "HH:MM:SS" or "HH:MM" → "HH:MM". */
export function toHHMM(t: string): string {
  return t.slice(0, 5);
}

/** Daypart classification — must match the discovery view logic. */
export function daypartsForWindow(startHHMM: string, endHHMM: string): string[] {
  const start = Number(startHHMM.slice(0, 2)) * 60 + Number(startHHMM.slice(3, 5));
  const end = Number(endHHMM.slice(0, 2)) * 60 + Number(endHHMM.slice(3, 5));
  const parts: string[] = [];
  if (start < 12 * 60) parts.push('morning');
  if (start < 17 * 60 && end > 12 * 60) parts.push('afternoon');
  if (end > 17 * 60) parts.push('evening');
  return parts;
}

export interface WindowInput {
  day: number;
  start: string; // "HH:MM"
  end: string;
}

/** Client-side validation matching the database rules. */
export function validateWindows(windows: WindowInput[]): string | null {
  for (const w of windows) {
    if (!Number.isInteger(w.day) || w.day < 1 || w.day > 7) return 'Invalid day of week.';
    if (!/^\d{2}:\d{2}$/.test(w.start) || !/^\d{2}:\d{2}$/.test(w.end)) return 'Times must look like 09:00.';
    if (w.start >= w.end) return 'Each window must start before it ends.';
  }
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      const a = windows[i];
      const b = windows[j];
      if (a.day === b.day && a.start < b.end && b.start < a.end) {
        return `Two windows overlap on ${ISO_DAY_NAMES[a.day]}. Adjust the times so they don’t clash.`;
      }
    }
  }
  return null;
}
