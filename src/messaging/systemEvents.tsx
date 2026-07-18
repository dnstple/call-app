/**
 * Stage 2F2C — system-event presentation.
 *
 * One copy map for the canonical lifecycle events, shared by the thread
 * and the inbox preview. Unknown future event types fall back to neutral
 * copy — never a crash, never raw JSON.
 */
import {
  CalendarCheck, CalendarClock, CalendarHeart, CalendarX2, CheckCircle2,
  CircleOff, Info, PauseCircle, PlayCircle, Repeat,
} from 'lucide-react';
import type { ChatMessage } from '../repositories/messagingRepository';
import { browserTimezone } from '../domain/timezones';

function whenFrom(payload: Record<string, unknown> | null, viewerTz: string): string | null {
  const raw = payload?.starts_at;
  if (typeof raw !== 'string') return null;
  const t = new Date(raw);
  if (Number.isNaN(t.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: viewerTz, weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(t);
}

export function systemEventCopy(
  event: string | null,
  payload: Record<string, unknown> | null,
  viewerTz: string = browserTimezone(),
): string {
  const when = whenFrom(payload, viewerTz);
  const freq = typeof payload?.frequency_per_week === 'number' ? payload.frequency_per_week : null;
  switch (event) {
    case 'booking_confirmed':
      return when ? `Your conversation is confirmed for ${when}.` : 'Your conversation is confirmed.';
    case 'booking_rescheduled':
      return when ? `The conversation was moved to ${when}.` : 'The conversation was moved to a new time.';
    case 'booking_cancelled':
      return 'The conversation was cancelled.';
    case 'booking_completed':
      return 'The conversation took place.';
    case 'plan_accepted':
      return freq
        ? `The weekly conversation plan is now active — ${freq} conversation${freq === 1 ? '' : 's'} per week.`
        : 'The weekly conversation plan is now active.';
    case 'plan_paused':
      return 'The plan has been paused.';
    case 'plan_resumed':
      return 'The plan has resumed.';
    case 'plan_schedule_changed':
      return freq
        ? `The plan schedule changed — now ${freq} conversation${freq === 1 ? '' : 's'} per week.`
        : 'The plan schedule changed.';
    case 'plan_ended':
      return 'The plan has ended.';
    default:
      // Safe fallback for event types this build doesn't know yet.
      return 'The conversation was updated.';
  }
}

const EVENT_ICONS: Record<string, typeof Info> = {
  booking_confirmed: CalendarCheck,
  booking_rescheduled: CalendarClock,
  booking_cancelled: CalendarX2,
  booking_completed: CheckCircle2,
  plan_accepted: CalendarHeart,
  plan_paused: PauseCircle,
  plan_resumed: PlayCircle,
  plan_schedule_changed: Repeat,
  plan_ended: CircleOff,
};

/** Neutral centred system-event line — never a bubble. */
export function SystemEventMessage({ message }: { message: ChatMessage }) {
  const Icon = EVENT_ICONS[message.systemEvent ?? ''] ?? Info;
  const copy = systemEventCopy(message.systemEvent, message.systemPayload);
  return (
    <div className="msg-system" role="note" aria-label={`Update: ${copy}`}>
      <Icon size={14} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 6 }} />
      {copy}
    </div>
  );
}
