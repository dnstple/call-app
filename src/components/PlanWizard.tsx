/**
 * Corrective Stage 2E4B — "Start regular conversations".
 *
 * Frequency → duration → one sub-stage per weekly conversation
 * ("Conversation 2 of 3") → review → request. Every conversation happens
 * in the app, so there is no method to choose. No package, credit or
 * purchase language exists here: the Member is arranging companionship.
 *
 * planRepository is the only data path; the weekly price shown is a
 * preview of what the SERVER snapshots (frequency × per-conversation).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import type { User } from '../types';
import type { ConversationOfferRow } from '../supabase/database.types';
import {
  buildWeeklyGrid,
  createConversationPlan,
  getMemberPlanPreferences,
  hasRecurringConflict,
  oneOffConflicts,
  PLAN_MESSAGE_MAX,
  PlanError,
  previewPlanSchedule,
  recommendedDuration,
  recommendedFrequency,
  recommendSchedule,
  validatePlanInput,
  weeklyPriceMinor,
  type MemberPlanPreferences,
  type PlanSlotInput,
  type WeeklyGridDay,
} from '../repositories/planRepository';
import type { SlotPreviewPayload } from '../supabase/database.types';
import { getAvailabilityRules, formatMinor, ruleRowToWindow } from '../repositories/availabilityRepository';
import { RESCHEDULE_OPEN_COPY } from '../repositories/bookingRepository';
import { browserTimezone, ISO_DAY_NAMES, nextDateForIsoDay, wallTimeToUtc } from '../domain/timezones';
import { useAuthSnapshot } from '../state/authBridge';
import { FlowModal, IN_APP_CALL_EXPLAINER, IN_APP_CALL_LABEL, PrototypePaymentStep } from './FlowModal';
import { WeeklySlotStage } from './WeeklySlotStage';
import { ProfilePhoto } from './ui';

const FREQUENCY_OPTIONS = [1, 2, 3, 4] as const;

/* ---------------- timezone-safe slot labels ---------------- */

function slotInstant(slot: PlanSlotInput, companionTz: string, from = new Date()): Date {
  const [h, m] = slot.time.split(':').map(Number);
  const date = nextDateForIsoDay(slot.day, companionTz, from);
  return wallTimeToUtc(date.y, date.m, date.d, h, m, companionTz);
}

export function slotTimeInViewerTz(slot: PlanSlotInput, companionTz: string, viewerTz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: viewerTz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(slotInstant(slot, companionTz));
}

/** "Tuesday 6pm" in the viewer's timezone (weekday included — DST-safe). */
export function slotLabel(slot: PlanSlotInput, companionTz: string, viewerTz: string): string {
  if (!slot.time) return ISO_DAY_NAMES[slot.day];
  const instant = slotInstant(slot, companionTz);
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: viewerTz, weekday: 'long' }).format(instant);
  const [h, m] = slotTimeInViewerTz(slot, companionTz, viewerTz).split(':').map(Number);
  const suffix = h < 12 ? 'am' : 'pm';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const time = m === 0 ? `${hour12}${suffix}` : `${hour12}:${String(m).padStart(2, '0')}${suffix}`;
  return `${weekday} ${time}`;
}

export function scheduleSummary(slots: PlanSlotInput[], companionTz: string, viewerTz: string): string {
  return [...slots]
    .filter((s) => s.time)
    .sort((a, b) => a.day - b.day)
    .map((s) => slotLabel(s, companionTz, viewerTz))
    .join(' · ');
}

/** The first real dates these weekly times will produce. */
export function firstUpcomingDates(
  slots: PlanSlotInput[],
  companionTz: string,
  viewerTz: string,
  from = new Date(),
): string[] {
  return slots
    .filter((s) => s.time)
    .map((s) => slotInstant(s, companionTz, from))
    .sort((a, b) => a.getTime() - b.getTime())
    .map((d) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: viewerTz, weekday: 'long', day: 'numeric', month: 'long',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(d),
    );
}

/* ---------------- the wizard ---------------- */

export function PlanWizard({
  companion,
  offers,
  memberProfileId,
  onClose,
  onCreated,
}: {
  companion: User;
  /** Active single offers — the source of per-conversation rates. */
  offers: ConversationOfferRow[];
  memberProfileId: string;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const auth = useAuthSnapshot();
  const viewerTz = browserTimezone();
  const member = auth.profiles.find((p) => p.profile.id === memberProfileId)?.profile;

  const [prefs, setPrefs] = useState<MemberPlanPreferences | null>(null);
  const [companionTz, setCompanionTz] = useState('Europe/London');
  const [grid, setGrid] = useState<WeeklyGridDay[]>([]);
  const [loading, setLoading] = useState(true);

  const [frequency, setFrequency] = useState(3);
  const [duration, setDuration] = useState(30);
  /** One entry per weekly conversation; index = sub-stage. */
  const [slots, setSlots] = useState<(PlanSlotInput | null)[]>([]);
  /** 0 = frequency, 1 = duration, 2..(1+frequency) = schedule, then review, done. */
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  /** Optional personal message for the Companion, saved with the request. */
  const [message, setMessage] = useState('');
  /** Server-classified four-week preview of the chosen weekly times. */
  const [preview, setPreview] = useState<SlotPreviewPayload[] | null>(null);
  const [previewPending, setPreviewPending] = useState(false);

  const durationOptions = useMemo(
    () => [...new Set(offers.filter((o) => o.offer_type === 'single').map((o) => o.duration_minutes))].sort((a, b) => a - b),
    [offers],
  );
  const offerForDuration = useMemo(
    () => offers.find((o) => o.offer_type === 'single' && o.duration_minutes === duration) ?? null,
    [offers, duration],
  );
  const perConversation = offerForDuration?.price_minor ?? 0;
  const weekly = weeklyPriceMinor(perConversation, frequency);
  const recommended = prefs ? recommendedFrequency(prefs) : 3;

  const scheduleStages = frequency;
  const reviewStep = 2 + scheduleStages;
  const chosen = slots.filter((s): s is PlanSlotInput => Boolean(s?.time));

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [p, rules] = await Promise.all([
          getMemberPlanPreferences(memberProfileId).catch(() => ({
            preferredDays: [], preferredDayparts: [], preferredDurationMinutes: null,
          })),
          getAvailabilityRules(companion.id).catch(() => []),
        ]);
        if (!live) return;
        setPrefs(p);
        setCompanionTz(rules[0]?.timezone ?? 'Europe/London');
        const preferred = recommendedDuration(p);
        const firstDuration = durationOptions.includes(preferred) ? preferred : durationOptions[0] ?? 30;
        setDuration(firstDuration);
        const freq = recommendedFrequency(p);
        setFrequency(freq);
        setSlots(Array.from({ length: freq }, () => null));
        setGrid(buildWeeklyGrid(rules.map(ruleRowToWindow), firstDuration));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberProfileId, companion.id]);

  // A longer conversation needs a longer window: rebuild the grid.
  useEffect(() => {
    let live = true;
    getAvailabilityRules(companion.id)
      .then((rules) => live && setGrid(buildWeeklyGrid(rules.map(ruleRowToWindow), duration)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [companion.id, duration]);

  /** Changing frequency safely adds or removes schedule stages. */
  const changeFrequency = (next: number) => {
    setFrequency(next);
    setSlots((prev) => {
      const kept = prev.slice(0, next);
      while (kept.length < next) kept.push(null);
      return kept;
    });
    setStep((s) => Math.min(s, 1)); // never strand the user past the new stages
  };

  const changeDuration = (next: number) => {
    setDuration(next);
    setSlots(Array.from({ length: frequency }, () => null)); // times differ per length
  };

  const recommendation = useMemo(() => {
    if (!prefs) return [] as PlanSlotInput[];
    return recommendSchedule(grid, prefs, frequency);
  }, [grid, prefs, frequency]);

  /** Fill every stage — or explain why we can't. */
  const useRecommendedTimes = useCallback(() => {
    const picks = recommendSchedule(grid, prefs ?? { preferredDays: [], preferredDayparts: [], preferredDurationMinutes: null }, frequency);
    if (picks.length < frequency) {
      setError(
        `${companion.firstName} only has ${picks.length} suitable weekly time${picks.length === 1 ? '' : 's'} for ${duration}-minute conversations. Choose ${picks.length} per week, a shorter conversation, or pick times yourself.`,
      );
      return;
    }
    setError(null);
    setSlots(picks);
    setStep(reviewStep);
  }, [grid, prefs, frequency, companion.firstName, duration, reviewStep]);

  // Entering review (or changing the schedule) refreshes the server-side
  // four-week preview. PostgreSQL stays the final authority on conflicts;
  // this is the honest early warning.
  useEffect(() => {
    if (step !== reviewStep || chosen.length === 0) return;
    let live = true;
    setPreviewPending(true);
    previewPlanSchedule(memberProfileId, companion.id, duration, chosen)
      .then((p) => live && setPreview(p))
      .catch(() => live && setPreview(null)) // preview is advisory; the server still refuses conflicts
      .finally(() => live && setPreviewPending(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, reviewStep, duration, chosen.map((s) => `${s.day}T${s.time}`).join(',')]);

  const recurringBlocked = preview ? hasRecurringConflict(preview) : false;
  const oneOffs = preview ? oneOffConflicts(preview) : [];

  const setSlotAt = (index: number, slot: PlanSlotInput | null) => {
    setSlots((prev) => {
      const next = [...prev];
      next[index] = slot;
      return next;
    });
  };

  const submit = async () => {
    if (submitting) return; // duplicate-click protection
    const input = {
      frequencyPerWeek: frequency,
      durationMinutes: duration,
      communicationMethod: 'in_app',
      slots: chosen,
    };
    const invalid = validatePlanInput(input);
    if (invalid) {
      setError(invalid.message);
      return;
    }
    if (recurringBlocked) {
      setError('One of your weekly times is already taken every week. Please choose a different weekly time.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createConversationPlan(memberProfileId, companion.id, input, message.trim() || undefined);
      setDone(true);
      onCreated?.();
    } catch (e) {
      setError(e instanceof PlanError ? e.message : 'We couldn’t set up this plan. Please try again.');
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <FlowModal title={`Regular conversations with ${companion.firstName}`} onClose={onClose}>
        <p className="muted">Getting things ready…</p>
      </FlowModal>
    );
  }

  if (done) {
    return (
      <FlowModal title="Plan requested" onClose={onClose}>
        <div className="col" style={{ gap: 12, alignItems: 'center', textAlign: 'center' }}>
          <ProfilePhoto user={companion} size={88} radius={22} />
          <h3 style={{ margin: 0 }}>{companion.firstName} will confirm your plan</h3>
          <p className="muted longform" style={{ margin: 0 }}>
            We’ve sent your request for {frequency} regular conversation{frequency === 1 ? '' : 's'} a
            week. Once {companion.firstName} says yes, they appear in your diary automatically.
          </p>
          <p className="faint longform" style={{ margin: 0 }}>{IN_APP_CALL_EXPLAINER}</p>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </FlowModal>
    );
  }

  const stageIndex = step >= 2 && step < reviewStep ? step - 2 : -1;
  const currentStage = stageIndex >= 0 ? slots[stageIndex] ?? null : null;
  const otherStages = stageIndex >= 0
    ? slots.filter((s, i): s is PlanSlotInput => i !== stageIndex && Boolean(s?.time))
    : [];
  const stageRecommendation = stageIndex >= 0 ? recommendation[stageIndex] ?? null : null;

  const canContinue =
    (step === 0) ||
    (step === 1 && !!offerForDuration) ||
    (stageIndex >= 0 && Boolean(currentStage?.time)) ||
    step === reviewStep;

  return (
    <FlowModal
      title={`Regular conversations with ${companion.firstName}`}
      onClose={onClose}
      steps={reviewStep + 1}
      current={step + 1}
      error={error}
      confirmDiscard={chosen.length > 0}
      footer={
        <>
          <button
            className="btn btn-ghost"
            disabled={submitting}
            onClick={() => (step === 0 ? onClose() : setStep(step - 1))}
          >
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {step < reviewStep ? (
            <button className="btn btn-primary" disabled={!canContinue} onClick={() => setStep(step + 1)}>
              Continue
            </button>
          ) : (
            <button className="btn btn-primary" disabled={submitting || recurringBlocked} onClick={() => void submit()}>
              {submitting ? 'Sending…' : 'Request plan'}
            </button>
          )}
        </>
      }
    >
      {step === 0 && (
        <section className="col" style={{ gap: 14 }} aria-label="How often">
          <div>
            <h3 style={{ margin: '0 0 4px' }}>How often would you like to talk?</h3>
            <p className="muted longform" style={{ margin: 0 }}>
              {member ? `Recommended for ${member.first_name}: ` : 'Recommended: '}
              <strong>{recommended} conversation{recommended === 1 ? '' : 's'} per week</strong>
              {prefs && prefs.preferredDays.length > 0 && ' — based on the days they chose'}
            </p>
          </div>
          <div className="col" style={{ gap: 8 }}>
            {FREQUENCY_OPTIONS.map((n) => (
              <label key={n} className="card card-tight row between" style={{ cursor: 'pointer' }}>
                <span className="row" style={{ gap: 10 }}>
                  <input type="radio" name="plan-frequency" checked={frequency === n} onChange={() => changeFrequency(n)} />
                  <span className="bold">{n} per week</span>
                </span>
                {n === recommended && <span className="badge badge-success">Recommended</span>}
              </label>
            ))}
            <label className="card card-tight row" style={{ gap: 10, cursor: 'pointer' }}>
              <input
                type="radio"
                name="plan-frequency"
                checked={!FREQUENCY_OPTIONS.includes(frequency as 1 | 2 | 3 | 4)}
                onChange={() => changeFrequency(5)}
              />
              <span className="col" style={{ gap: 4 }}>
                <span className="bold">Custom</span>
                {!FREQUENCY_OPTIONS.includes(frequency as 1 | 2 | 3 | 4) && (
                  <label className="row" style={{ gap: 8 }}>
                    <span className="faint">Conversations per week</span>
                    <input
                      type="number"
                      min={1}
                      max={7}
                      value={frequency}
                      aria-label="Conversations per week"
                      style={{ width: 90 }}
                      onChange={(e) => changeFrequency(Math.max(1, Math.min(7, Number(e.target.value) || 1)))}
                    />
                  </label>
                )}
              </span>
            </label>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="col" style={{ gap: 14 }} aria-label="How long">
          <div>
            <h3 style={{ margin: '0 0 4px' }}>How long should each conversation be?</h3>
            <p className="faint longform" style={{ margin: 0 }}>{IN_APP_CALL_EXPLAINER}</p>
          </div>
          {durationOptions.length === 0 ? (
            <p className="muted longform">{companion.firstName} hasn’t set their conversation lengths yet.</p>
          ) : (
            <div className="col" style={{ gap: 8 }}>
              {durationOptions.map((d) => {
                const offer = offers.find((o) => o.offer_type === 'single' && o.duration_minutes === d);
                return (
                  <label key={d} className="card card-tight row between" style={{ cursor: 'pointer' }}>
                    <span className="row" style={{ gap: 10 }}>
                      <input type="radio" name="plan-duration" checked={duration === d} onChange={() => changeDuration(d)} />
                      <span className="bold">{d} minutes</span>
                    </span>
                    {offer && <span className="faint">{formatMinor(offer.price_minor)} each</span>}
                  </label>
                );
              })}
            </div>
          )}
        </section>
      )}

      {stageIndex >= 0 && (
        <div className="col" style={{ gap: 12 }}>
          <WeeklySlotStage
            index={stageIndex + 1}
            total={scheduleStages}
            grid={grid}
            chosen={currentStage}
            others={otherStages}
            companionTz={companionTz}
            viewerTz={viewerTz}
            recommendation={stageRecommendation}
            onPick={(slot) => setSlotAt(stageIndex, slot)}
          />
          {stageIndex === 0 && recommendation.length >= frequency && (
            <button className="btn btn-ghost btn-small" style={{ alignSelf: 'flex-start' }} onClick={useRecommendedTimes}>
              Use recommended times for all {frequency}
            </button>
          )}
          <p className="faint" style={{ margin: 0 }}>Times shown in your timezone ({viewerTz}).</p>
        </div>
      )}

      {step === reviewStep && (
        <section className="col" style={{ gap: 14 }} aria-label="Review plan">
          <div className="card card-muted row" style={{ gap: 14 }}>
            <ProfilePhoto user={companion} size={64} radius={16} />
            <div className="col grow" style={{ gap: 2 }}>
              <span className="bold longform">
                {frequency} regular conversation{frequency === 1 ? '' : 's'} per week with {companion.firstName}
              </span>
              {member && <span className="muted">For {member.first_name} {member.last_name}</span>}
            </div>
          </div>

          <div className="card card-tight col" style={{ gap: 8 }}>
            <Row label="How often" value={`${frequency} per week`} />
            <Row label="Each conversation" value={`${duration} minutes`} />
            <Row label="How you’ll talk" value={IN_APP_CALL_LABEL} />
            <div className="col" style={{ gap: 4 }}>
              <span className="muted">Your weekly times</span>
              <span className="bold row longform" style={{ gap: 8 }}>
                <CalendarDays size={16} aria-hidden="true" />
                {scheduleSummary(chosen, companionTz, viewerTz)}
              </span>
            </div>
          </div>

          <div className="card card-tight col" style={{ gap: 6 }}>
            <span className="muted">Your first four weeks</span>
            {previewPending && <span className="faint">Checking these times against both diaries…</span>}
            {!previewPending && preview && (
              <div className="col" style={{ gap: 8 }}>
                {preview.map((slot) => (
                  <div key={`${slot.day}-${slot.time}`} className="col" style={{ gap: 2 }}>
                    <span className="bold">{slotLabel({ day: slot.day, time: slot.time.slice(0, 5) }, companionTz, viewerTz)}</span>
                    {slot.occurrences.map((o) => (
                      <span key={o.starts_at} className={o.conflict ? 'badge badge-danger' : 'faint'} style={o.conflict ? { alignSelf: 'flex-start' } : undefined}>
                        {new Intl.DateTimeFormat('en-GB', {
                          timeZone: viewerTz, weekday: 'short', day: 'numeric', month: 'short',
                          hour: '2-digit', minute: '2-digit', hour12: false,
                        }).format(new Date(o.starts_at))}
                        {o.conflict ? ' — conflicts with an existing conversation' : ''}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {!previewPending && !preview && firstUpcomingDates(chosen, companionTz, viewerTz).map((d) => (
              <span key={d} className="bold longform">{d}</span>
            ))}
          </div>

          {recurringBlocked && (
            <div className="banner banner-danger" role="alert">
              One of your weekly times is already taken every week across the next four weeks, so this
              plan can’t go ahead at that time. Go back and choose a different weekly time.
            </div>
          )}
          {!recurringBlocked && oneOffs.length > 0 && (
            <div className="banner banner-warning" role="alert">
              {oneOffs.length === 1 ? 'One conversation conflicts' : `${oneOffs.length} conversations conflict`} with
              something already arranged — the first affected date is shown above. Your weekly plan still
              works: that occurrence will be skipped without being charged, and you can arrange a
              replacement time for it from your plan page once {companion.firstName} accepts.
            </div>
          )}

          <div className="field col" style={{ gap: 4, marginBottom: 0 }}>
            <label htmlFor="plan-message" className="bold">
              Add a message for {companion.firstName}
            </label>
            <p className="faint longform" style={{ margin: 0 }}>
              Introduce yourself or explain what you are hoping for from regular conversations.
            </p>
            <textarea
              id="plan-message"
              rows={4}
              maxLength={PLAN_MESSAGE_MAX}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={member && member.first_name !== undefined && auth.profiles.some((p) => p.profile.role === 'coordinator')
                ? `e.g. “${member.first_name} loves gardening and local history. She would really enjoy having someone to speak with regularly during the week.”`
                : 'e.g. “I’d love a regular chat about books and local history.”'}
            />
            <span className="faint" aria-live="polite" style={{ alignSelf: 'flex-end' }}>
              {message.length}/{PLAN_MESSAGE_MAX} characters
            </span>
          </div>

          <PrototypePaymentStep
            heading="Weekly plan"
            lines={[
              { label: 'Each conversation', value: formatMinor(perConversation) },
              { label: 'Conversations per week', value: String(frequency) },
            ]}
            total={`${formatMinor(weekly)} per week`}
            totalLabel="Weekly total"
            billingNote="Billed weekly when payments are introduced."
            note={RESCHEDULE_OPEN_COPY}
          />

          <p className="muted longform" style={{ margin: 0 }}>
            {companion.firstName} will confirm before anything is arranged.
          </p>
        </section>
      )}
    </FlowModal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row between" style={{ gap: 12 }}>
      <span className="muted">{label}</span>
      <span className="bold" style={{ textAlign: 'right' }}>{value}</span>
    </div>
  );
}
