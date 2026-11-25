/**
 * Pure planning for one outreach run: which threads get which step today, which
 * are closed, and how the daily cap is applied. Shared by the edge function and
 * the local dry-run CLI so both produce the same list.
 */
import { SCHEDULE, workingDaysBetween, daysBetween, type OutreachStep } from './render.ts';

export const HARD_DAILY_MAX = 30;

export interface OutreachRow {
  id: string;
  charity_id: string;
  status: string;
  message_variant: string | null;
  queued_at: string;
  first_sent_at: string | null;
  fu1_sent_at: string | null;
  fu2_sent_at: string | null;
  graph_message_id: string | null;
  charity: { name: string; contact_name: string | null; contact_email: string; is_test: boolean };
}

export interface PlannedSend { row: OutreachRow; step: OutreachStep }
export interface Plan { sends: PlannedSend[]; close: OutreachRow[]; capacity: number; deferred: number }

export function effectiveCapacity(configCap: number, sentToday: number, requestLimit?: number | null): number {
  const cap = Math.min(Math.max(0, Math.floor(configCap)), HARD_DAILY_MAX,
    requestLimit == null ? HARD_DAILY_MAX : Math.max(0, Math.floor(requestLimit)));
  return Math.max(0, cap - Math.max(0, sentToday));
}

/** Follow-ups first (time-sensitive), oldest first; then queued initials, oldest first. */
export function planRun(rows: OutreachRow[], now: Date, capacity: number): Plan {
  const fu: PlannedSend[] = [];
  const close: OutreachRow[] = [];
  const initial: PlannedSend[] = [];

  for (const r of rows) {
    if (r.status === 'queued') initial.push({ row: r, step: 'initial' });
    else if (r.status === 'sent' && r.first_sent_at
      && workingDaysBetween(r.first_sent_at, now) >= SCHEDULE.fu1WorkingDays) fu.push({ row: r, step: 'fu1' });
    else if (r.status === 'followed_up_1' && r.first_sent_at
      && daysBetween(r.first_sent_at, now) >= SCHEDULE.fu2DaysAfterInitial
      // never two emails within 3 days, even if FU1 went out late (e.g. cap backlog)
      && (!r.fu1_sent_at || daysBetween(r.fu1_sent_at, now) >= 3)) fu.push({ row: r, step: 'fu2' });
    else if (r.status === 'followed_up_2' && r.fu2_sent_at
      && daysBetween(r.fu2_sent_at, now) >= SCHEDULE.closeDaysAfterFu2) close.push(r);
  }
  const byDate = (k: (p: PlannedSend) => string | null) => (a: PlannedSend, b: PlannedSend) =>
    (k(a) ?? '').localeCompare(k(b) ?? '');
  fu.sort(byDate((p) => p.row.first_sent_at));
  initial.sort(byDate((p) => p.row.queued_at));

  const all = [...fu, ...initial];
  return { sends: all.slice(0, capacity), close, capacity, deferred: Math.max(0, all.length - capacity) };
}
