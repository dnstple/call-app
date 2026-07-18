/**
 * Recurring conversation plans (Supabase mode, Stage 2E4A).
 *
 * A plan is an ongoing relationship: one Member ↔ one Companion, a weekly
 * rhythm and a weekly SIMULATED price (frequency × the snapshotted
 * per-conversation rate). The Companion accepts the plan once; occurrences
 * generate as CONFIRMED bookings inside a rolling 4-week window.
 *
 * The credit ledger is hidden infrastructure — this layer speaks only of
 * plans, schedules and conversations. All writes go through controlled
 * database functions; the browser never sends prices, credits, buyers or
 * statuses. NO payment is taken. Never falls back to mock data.
 */
import { getSupabaseClient } from '../supabase/client';
import type {
  ConversationPlanRow,
  MyBookingRow,
  PlanActionResultPayload,
  PlanGenerationLogRow,
  PlanGenerationResultPayload,
  PlanMemberProfilePayload,
  PlanScheduleSlotRow,
  SlotPreviewPayload,
  TrialState,
} from '../supabase/database.types';
import { RepoError, type RepoErrorKind } from './profileRepository';

/* ---------------- Domain types ---------------- */

/** A weekly rhythm entry: ISO weekday (1 = Monday) + Companion-local time. */
export interface PlanSlotInput {
  day: number;
  time: string; // "HH:MM"
}

export interface PlanInput {
  frequencyPerWeek: number;
  durationMinutes: number;
  communicationMethod: string;
  slots: PlanSlotInput[];
}

export interface PlanGenerationResult {
  planId: string;
  generated: number;
  skipped: number;
  retried: number;
  generatedUntil: string;
}

export const PLAN_FREQUENCY_OPTIONS = [1, 2, 3, 4] as const;
export const PLAN_FREQUENCY_MIN = 1;
export const PLAN_FREQUENCY_MAX = 7;
export const PLAN_DURATIONS = [15, 30, 45, 60];
/** Rolling window: occurrences are generated this far ahead, never further. */
export const PLAN_WINDOW_DAYS = 28;

export type PlanErrorCode =
  | 'unauthorised'
  | 'plan_exists'
  | 'plan_not_found'
  | 'plan_not_active'
  | 'invalid_frequency'
  | 'invalid_slots'
  | 'invalid_method'
  | 'slot_unavailable'
  | 'price_unavailable'
  | 'no_pending_change'
  | 'trial_used'
  | 'recurring_conflict'
  | 'message_locked'
  | 'reschedule_closed'
  | 'issue_not_found'
  | 'already_resolved'
  | 'network_failure'
  | 'unknown';

export class PlanError extends RepoError {
  constructor(message: string, kind: RepoErrorKind, public readonly code: PlanErrorCode) {
    super(message, kind);
    this.name = 'PlanError';
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapPlanError(e: any): PlanError {
  const msg = String(e?.message ?? '').toLowerCase();
  if (import.meta.env?.DEV) console.warn('[plans]', e?.code ?? '', e?.message ?? '');
  if (msg.includes('plan_exists')) {
    return new PlanError('There’s already a conversation plan with this companion.', 'conflict', 'plan_exists');
  }
  if (msg.includes('plan_not_active')) {
    return new PlanError('This plan isn’t active any more — refresh to see its latest state.', 'conflict', 'plan_not_active');
  }
  if (msg.includes('invalid_frequency')) {
    return new PlanError('Choose between 1 and 7 conversations per week.', 'validation', 'invalid_frequency');
  }
  if (msg.includes('invalid_slots')) {
    return new PlanError('Please choose a weekly time for each conversation.', 'validation', 'invalid_slots');
  }
  if (msg.includes('invalid_method')) {
    return new PlanError('That call method isn’t offered by this companion.', 'validation', 'invalid_method');
  }
  if (msg.includes('slot_unavailable')) {
    return new PlanError('One of those times is outside the companion’s weekly availability.', 'conflict', 'slot_unavailable');
  }
  if (msg.includes('price_unavailable')) {
    return new PlanError('This companion hasn’t set a rate for that conversation length yet.', 'validation', 'price_unavailable');
  }
  if (msg.includes('no_pending_change')) {
    return new PlanError('There’s no plan change waiting.', 'conflict', 'no_pending_change');
  }
  if (msg.includes('recurring_conflict')) {
    return new PlanError('One of those weekly times is no longer available every week — please choose a different regular time.', 'conflict', 'recurring_conflict');
  }
  if (msg.includes('message_locked')) {
    return new PlanError('The message can no longer be changed.', 'conflict', 'message_locked');
  }
  if (msg.includes('reschedule_closed')) {
    return new PlanError('Changes close two hours before a conversation starts.', 'conflict', 'reschedule_closed');
  }
  if (msg.includes('issue_not_found')) {
    return new PlanError('We couldn’t find that scheduling issue — it may already be sorted.', 'not_found', 'issue_not_found');
  }
  if (msg.includes('already_resolved')) {
    return new PlanError('This conversation has already been rearranged.', 'conflict', 'already_resolved');
  }
  if (msg.includes('under_18')) {
    return new PlanError('You must be at least 18 to use this service.', 'validation', 'unauthorised');
  }
  if (msg.includes('trial_used')) {
    return new PlanError('The test call with this companion has already happened.', 'conflict', 'trial_used');
  }
  if (msg.includes('only the companion') || msg.includes('only the member side')
      || msg.includes('cannot manage this plan') || msg.includes('cannot book for this member')
      || msg.includes('row-level security') || msg.includes('permission denied')
      || msg.includes('not authenticated') || msg.includes('not accepting new members')) {
    return new PlanError('You don’t have permission to do that.', 'unauthorised', 'unauthorised');
  }
  if (msg.includes('not found') || msg.includes('not available')) {
    return new PlanError('We couldn’t find that plan.', 'not_found', 'plan_not_found');
  }
  if (msg.includes('failed to fetch') || msg.includes('network')) {
    return new PlanError('We couldn’t reach the server. Please check your connection.', 'network', 'network_failure');
  }
  return new PlanError('Something went wrong. Please try again.', 'database', 'unknown');
}

/* ---------------- Pure domain helpers ---------------- */

/** Weekly price mirror of the SQL: frequency × per-conversation rate. */
export function weeklyPriceMinor(perConversationMinor: number, frequencyPerWeek: number): number {
  return perConversationMinor * frequencyPerWeek;
}

/** Validate a plan before troubling the server (which re-checks anyway). */
export function validatePlanInput(input: PlanInput): PlanError | null {
  if (
    !Number.isInteger(input.frequencyPerWeek) ||
    input.frequencyPerWeek < PLAN_FREQUENCY_MIN ||
    input.frequencyPerWeek > PLAN_FREQUENCY_MAX
  ) {
    return new PlanError('Choose between 1 and 7 conversations per week.', 'validation', 'invalid_frequency');
  }
  if (!PLAN_DURATIONS.includes(input.durationMinutes)) {
    return new PlanError('Please choose 15, 30, 45 or 60 minutes.', 'validation', 'invalid_slots');
  }
  if (input.slots.length !== input.frequencyPerWeek) {
    return new PlanError(
      `Please choose exactly ${input.frequencyPerWeek} weekly time${input.frequencyPerWeek === 1 ? '' : 's'}.`,
      'validation',
      'invalid_slots',
    );
  }
  const seen = new Set<string>();
  for (const s of input.slots) {
    if (!Number.isInteger(s.day) || s.day < 1 || s.day > 7 || !/^\d{2}:\d{2}$/.test(s.time)) {
      return new PlanError('Each weekly time needs a day and a time.', 'validation', 'invalid_slots');
    }
    const key = `${s.day}-${s.time}`;
    if (seen.has(key)) {
      return new PlanError('Please choose different weekly times.', 'validation', 'invalid_slots');
    }
    seen.add(key);
  }
  return null;
}

/**
 * Which fields require the Companion to accept the plan again?
 * Frequency, duration, method, schedule (and therefore weekly price).
 * Occurrence-level actions (skip, pause, reschedule one) never do.
 */
export function isMaterialChange(
  plan: Pick<ConversationPlanRow, 'frequency_per_week' | 'duration_minutes' | 'communication_method'>,
  next: Partial<PlanInput>,
): boolean {
  if (next.frequencyPerWeek !== undefined && next.frequencyPerWeek !== plan.frequency_per_week) return true;
  if (next.durationMinutes !== undefined && next.durationMinutes !== plan.duration_minutes) return true;
  if (next.communicationMethod !== undefined && next.communicationMethod !== plan.communication_method) return true;
  if (next.slots !== undefined) return true; // schedule changes are material
  return false;
}

/** Plans awaiting the Companion (new request or a proposed change). */
export function needsCompanionAction(plan: ConversationPlanRow): boolean {
  return plan.status === 'requested' || plan.pending_change !== null;
}

/** Occurrences the later UI can retry (never silent, never credit-consuming). */
export function retriableSkips(log: PlanGenerationLogRow[]): PlanGenerationLogRow[] {
  return log.filter(
    (l) => l.outcome === 'skipped_conflict' || l.outcome === 'skipped_availability' || l.outcome === 'skipped_paused',
  );
}

/* ---------------- Member preferences → recommendations ---------------- */

export interface MemberPlanPreferences {
  /** Signup answers: days and dayparts they'd like conversations. */
  preferredDays: string[];
  preferredDayparts: string[];
  preferredDurationMinutes: number | null;
}

const ISO_DAY_BY_NAME: Record<string, number> = {
  Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7,
};

export async function getMemberPlanPreferences(memberProfileId: string): Promise<MemberPlanPreferences> {
  const { data, error } = await getSupabaseClient()
    .from('member_profiles')
    .select('preferred_days, preferred_dayparts, preferred_duration_minutes')
    .eq('profile_id', memberProfileId)
    .maybeSingle();
  if (error) throw mapPlanError(error);
  return {
    preferredDays: data?.preferred_days ?? [],
    preferredDayparts: data?.preferred_dayparts ?? [],
    preferredDurationMinutes: data?.preferred_duration_minutes ?? null,
  };
}

/**
 * How often does this Member want to talk? Derived from the days they chose
 * at signup (one conversation per preferred day), clamped to the offered
 * options. Three per week is the product default when they didn't say.
 */
export function recommendedFrequency(prefs: MemberPlanPreferences): number {
  const days = prefs.preferredDays.filter((d) => ISO_DAY_BY_NAME[d]).length;
  if (days < 1) return 3;
  return Math.min(Math.max(days, PLAN_FREQUENCY_MIN), 4);
}

export function recommendedDuration(prefs: MemberPlanPreferences): number {
  return prefs.preferredDurationMinutes && PLAN_DURATIONS.includes(prefs.preferredDurationMinutes)
    ? prefs.preferredDurationMinutes
    : 30;
}

/* ---------------- Weekly availability grid (for the scheduler) ---------------- */

export interface WeeklyGridDay {
  isoDay: number;
  /** Companion-local "HH:MM" starts that fit the whole conversation. */
  times: string[];
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function toHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Which part of the day a start time falls in (matches Explore's rule). */
export function daypartOf(time: string): 'Morning' | 'Afternoon' | 'Evening' {
  const m = toMinutes(time);
  if (m < 12 * 60) return 'Morning';
  if (m <= 17 * 60) return 'Afternoon';
  return 'Evening';
}

/**
 * Candidate weekly times from the Companion's recurring availability, on a
 * 30-minute grid, only where the whole conversation fits. Times are
 * Companion-local wall times — exactly what a weekly plan slot stores.
 */
export function buildWeeklyGrid(
  windows: { day: number; start: string; end: string }[],
  durationMinutes: number,
  stepMinutes = 30,
): WeeklyGridDay[] {
  const byDay = new Map<number, Set<string>>();
  for (const w of windows) {
    const start = toMinutes(w.start);
    const end = toMinutes(w.end);
    for (let t = start; t + durationMinutes <= end; t += stepMinutes) {
      const set = byDay.get(w.day) ?? new Set<string>();
      set.add(toHHMM(t));
      byDay.set(w.day, set);
    }
  }
  return [1, 2, 3, 4, 5, 6, 7]
    .filter((d) => (byDay.get(d)?.size ?? 0) > 0)
    .map((d) => ({ isoDay: d, times: [...byDay.get(d)!].sort() }));
}

/**
 * A recommended weekly rhythm: the Member's preferred days and dayparts
 * first, spread across the week, filled from availability if needed.
 * Returns fewer slots only when the Companion genuinely lacks days.
 */
export function recommendSchedule(
  grid: WeeklyGridDay[],
  prefs: MemberPlanPreferences,
  frequency: number,
): PlanSlotInput[] {
  const wantedDays = prefs.preferredDays
    .map((d) => ISO_DAY_BY_NAME[d])
    .filter((d): d is number => Boolean(d));
  const wantedParts = prefs.preferredDayparts.length > 0 ? prefs.preferredDayparts : ['Morning', 'Afternoon', 'Evening'];

  const pickTime = (day: WeeklyGridDay): string | null => {
    const preferred = day.times.find((t) => wantedParts.includes(daypartOf(t)));
    return preferred ?? day.times[0] ?? null;
  };

  // Preferred days first, then the rest — spread evenly across the week.
  const ordered = [
    ...grid.filter((d) => wantedDays.includes(d.isoDay)),
    ...grid.filter((d) => !wantedDays.includes(d.isoDay)),
  ];
  const chosen: PlanSlotInput[] = [];
  for (const day of ordered) {
    if (chosen.length >= frequency) break;
    const time = pickTime(day);
    if (time) chosen.push({ day: day.isoDay, time });
  }
  return chosen.sort((a, b) => a.day - b.day);
}

/* ---------------- Plan lifecycle ---------------- */

/**
 * Request a plan. The server derives the price from the Companion's rate,
 * validates every weekly time against their availability, and creates the
 * hidden allowance account atomically. Sends no prices or credits.
 */
export const PLAN_MESSAGE_MAX = 1000;

export async function createConversationPlan(
  memberProfileId: string,
  companionProfileId: string,
  input: PlanInput,
  /** Optional consent message for the Companion (plain text, ≤1000). */
  requestMessage?: string,
): Promise<ConversationPlanRow> {
  const invalid = validatePlanInput(input);
  if (invalid) throw invalid;
  const message = requestMessage?.trim() ?? '';
  if (message.length > PLAN_MESSAGE_MAX) {
    throw new PlanError('Please keep your message under 1,000 characters.', 'validation', 'invalid_slots');
  }
  const { data, error } = await getSupabaseClient().rpc('create_conversation_plan', {
    p_member: memberProfileId,
    p_companion: companionProfileId,
    p_frequency: input.frequencyPerWeek,
    p_duration: input.durationMinutes,
    p_method: input.communicationMethod,
    p_slots: input.slots,
    p_message: message || null,
  });
  if (error) throw mapPlanError(error);
  return data as ConversationPlanRow;
}

/** Editable by the requester only while the plan is still requested. */
export async function updatePlanRequestMessage(
  planId: string,
  message: string | null,
): Promise<ConversationPlanRow> {
  const { data, error } = await getSupabaseClient().rpc('update_plan_request_message', {
    p_plan: planId,
    p_message: message,
  });
  if (error) throw mapPlanError(error);
  return data as ConversationPlanRow;
}

/**
 * Safe Member profile for the plan's Companion. Explicit fields only —
 * never surname, date of birth, email, phone, address or auth ids.
 */
export async function getPlanMemberProfile(planId: string): Promise<PlanMemberProfilePayload> {
  const { data, error } = await getSupabaseClient().rpc('get_plan_member_profile', {
    p_plan: planId,
  });
  if (error) throw mapPlanError(error);
  return data as PlanMemberProfilePayload;
}

/**
 * Four-week conflict preview for proposed weekly times. The server
 * classifies each slot with the SAME overlap rule the exclusion
 * constraints enforce: available / one_off_conflict / recurring_conflict.
 */
export async function previewPlanSchedule(
  memberProfileId: string,
  companionProfileId: string,
  durationMinutes: number,
  slots: PlanSlotInput[],
): Promise<SlotPreviewPayload[]> {
  const { data, error } = await getSupabaseClient().rpc('preview_plan_schedule', {
    p_member: memberProfileId,
    p_companion: companionProfileId,
    p_duration: durationMinutes,
    p_slots: slots,
  });
  if (error) throw mapPlanError(error);
  return (data ?? []) as SlotPreviewPayload[];
}

/** A recurring conflict blocks the plan; one-offs are surfaced, not fatal. */
export function hasRecurringConflict(preview: SlotPreviewPayload[]): boolean {
  return preview.some((s) => s.classification === 'recurring_conflict');
}

export function oneOffConflicts(preview: SlotPreviewPayload[]): { day: number; time: string; startsAt: string }[] {
  return preview
    .filter((s) => s.classification === 'one_off_conflict')
    .flatMap((s) =>
      s.occurrences
        .filter((o) => o.conflict)
        .map((o) => ({ day: s.day, time: s.time, startsAt: o.starts_at })),
    );
}

function toGenerationResult(p: PlanGenerationResultPayload): PlanGenerationResult {
  return {
    planId: p.plan_id,
    generated: Number(p.generated ?? 0),
    skipped: Number(p.skipped ?? 0),
    retried: Number(p.retried ?? 0),
    generatedUntil: p.generated_until,
  };
}

/** Companion accepts the plan once — occurrences generate immediately.
 *  Refused server-side if a weekly time has become a recurring conflict. */
export async function acceptPlan(planId: string, message?: string): Promise<PlanGenerationResult> {
  const { data, error } = await getSupabaseClient().rpc('accept_plan', {
    p_plan: planId,
    p_message: message?.trim() || null,
  });
  if (error) throw mapPlanError(error);
  return toGenerationResult(data as PlanGenerationResultPayload);
}

export async function declinePlan(planId: string, reason?: string): Promise<ConversationPlanRow> {
  const { data, error } = await getSupabaseClient().rpc('decline_plan', {
    p_plan: planId,
    p_reason: reason ?? null,
  });
  if (error) throw mapPlanError(error);
  return data as ConversationPlanRow;
}

/**
 * Top up the rolling 4-week window. Idempotent and safe to call on page
 * load: already-generated occurrences are left alone, previously skipped
 * ones are retried, deliberate skips are never resurrected.
 */
export async function extendPlanBookings(planId: string): Promise<PlanGenerationResult> {
  const { data, error } = await getSupabaseClient().rpc('extend_plan_bookings', { p_plan: planId });
  if (error) throw mapPlanError(error);
  return toGenerationResult(data as PlanGenerationResultPayload);
}

/* ---------------- Occurrence-level actions (no re-acceptance) ---------------- */

export async function pausePlan(
  planId: string,
  reason?: string,
  /** Optional planned resume date, yyyy-mm-dd (informational). */
  resumeOn?: string,
): Promise<PlanActionResultPayload> {
  const { data, error } = await getSupabaseClient().rpc('pause_plan', {
    p_plan: planId,
    p_reason: reason?.trim() || null,
    p_resume_on: resumeOn || null,
  });
  if (error) throw mapPlanError(error);
  return data as PlanActionResultPayload;
}

export async function resumePlan(planId: string): Promise<PlanGenerationResult> {
  const { data, error } = await getSupabaseClient().rpc('resume_plan', { p_plan: planId });
  if (error) throw mapPlanError(error);
  return toGenerationResult(data as PlanGenerationResultPayload);
}

export async function endPlan(planId: string, reason?: string): Promise<PlanActionResultPayload> {
  const { data, error } = await getSupabaseClient().rpc('end_plan', {
    p_plan: planId,
    p_reason: reason ?? null,
  });
  if (error) throw mapPlanError(error);
  return data as PlanActionResultPayload;
}

/** Skip a whole week — credits return; the week is never regenerated. */
export async function skipPlanWeek(planId: string, weekStart: string): Promise<PlanActionResultPayload> {
  const { data, error } = await getSupabaseClient().rpc('skip_plan_week', {
    p_plan: planId,
    p_week_start: weekStart,
  });
  if (error) throw mapPlanError(error);
  return data as PlanActionResultPayload;
}

/* ---------------- Material changes (Companion re-acceptance) ---------------- */

/** Propose a material change; the plan keeps running until it's accepted. */
export async function proposePlanChange(
  planId: string,
  change: Partial<PlanInput>,
): Promise<ConversationPlanRow> {
  const { data, error } = await getSupabaseClient().rpc('propose_plan_change', {
    p_plan: planId,
    p_frequency: change.frequencyPerWeek ?? null,
    p_duration: change.durationMinutes ?? null,
    p_method: change.communicationMethod ?? null,
    p_slots: change.slots ?? null,
  });
  if (error) throw mapPlanError(error);
  return data as ConversationPlanRow;
}

export async function acceptPlanChange(
  planId: string,
  message?: string,
): Promise<PlanActionResultPayload> {
  const { data, error } = await getSupabaseClient().rpc('accept_plan_change', {
    p_plan: planId,
    p_message: message?.trim() || null,
  });
  if (error) throw mapPlanError(error);
  return data as PlanActionResultPayload;
}

export async function declinePlanChange(
  planId: string,
  message?: string,
): Promise<ConversationPlanRow> {
  const { data, error } = await getSupabaseClient().rpc('decline_plan_change', {
    p_plan: planId,
    p_message: message?.trim() || null,
  });
  if (error) throw mapPlanError(error);
  return data as ConversationPlanRow;
}

/* ---------------- Occurrence-level management (2E4D) ---------------- */

/** Deliberately skip ONE generated conversation. Allowance is released and
 * the occurrence is never regenerated. Respects the two-hour cutoff. */
export async function skipPlanOccurrence(bookingId: string): Promise<PlanActionResultPayload> {
  const { data, error } = await getSupabaseClient().rpc('skip_plan_occurrence', {
    p_booking: bookingId,
  });
  if (error) throw mapPlanError(error);
  return data as PlanActionResultPayload;
}

/**
 * Choose a replacement time for an occurrence that couldn't be scheduled.
 * The SERVER re-checks availability, notice, horizon, the two-hour cutoff
 * and both diaries; a second resolution of the same issue is refused.
 */
export async function resolvePlanOccurrence(
  planId: string,
  intendedStart: string,
  newStart: string,
): Promise<{ planId: string; bookingId: string; startsAt: string }> {
  const { data, error } = await getSupabaseClient().rpc('resolve_plan_occurrence', {
    p_plan: planId,
    p_intended_start: intendedStart,
    p_new_start: newStart,
  });
  if (error) throw mapPlanError(error);
  const d = data as { plan_id: string; booking_id: string; starts_at: string };
  return { planId: d.plan_id, bookingId: d.booking_id, startsAt: d.starts_at };
}

/* ---------------- Reads ---------------- */

export async function getPlan(planId: string): Promise<ConversationPlanRow | null> {
  const { data, error } = await getSupabaseClient()
    .from('conversation_plans')
    .select('*')
    .eq('id', planId)
    .maybeSingle();
  if (error) throw mapPlanError(error);
  return (data as ConversationPlanRow | null) ?? null;
}

/** Every plan this account can see (RLS scopes it to participants). */
export async function listMyPlans(): Promise<ConversationPlanRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('conversation_plans')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw mapPlanError(error);
  return (data ?? []) as ConversationPlanRow[];
}

export async function getPlanSlots(planId: string): Promise<PlanScheduleSlotRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('plan_schedule_slots')
    .select('*')
    .eq('plan_id', planId)
    .order('iso_day')
    .order('local_time');
  if (error) throw mapPlanError(error);
  return (data ?? []) as PlanScheduleSlotRow[];
}

/** Generation attempts — including retriable skips. Never silent. */
export async function getPlanGenerationLog(planId: string): Promise<PlanGenerationLogRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('plan_generation_log')
    .select('*')
    .eq('plan_id', planId)
    .order('intended_start');
  if (error) throw mapPlanError(error);
  return (data ?? []) as PlanGenerationLogRow[];
}

/** This plan's generated conversations (ordinary bookings). */
export async function listPlanBookings(planId: string): Promise<MyBookingRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('my_bookings')
    .select('*')
    .eq('plan_id', planId)
    .order('starts_at');
  if (error) throw mapPlanError(error);
  return (data ?? []) as MyBookingRow[];
}

/** The next upcoming conversation of a plan, if any. */
export function nextConversation(bookings: MyBookingRow[], now = new Date()): MyBookingRow | null {
  const upcoming = bookings
    .filter((b) => ['requested', 'confirmed', 'change_proposed'].includes(b.status))
    .filter((b) => new Date(b.starts_at).getTime() > now.getTime())
    .sort((a, z) => new Date(a.starts_at).getTime() - new Date(z.starts_at).getTime());
  return upcoming[0] ?? null;
}

/* ---------------- Test call (the trial, once per pair, ever) ---------------- */

/**
 * `available` → offer the test call; `pending` → one is already booked;
 * `used` → permanently replaced by "Start regular conversations".
 * Server-derived: never browser state.
 */
export async function getTrialState(
  memberProfileId: string,
  companionProfileId: string,
): Promise<TrialState> {
  const { data, error } = await getSupabaseClient().rpc('get_trial_state', {
    p_member: memberProfileId,
    p_companion: companionProfileId,
  });
  if (error) throw mapPlanError(error);
  return data as TrialState;
}
