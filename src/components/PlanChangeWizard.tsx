/**
 * Stage 2E4D — "Change this and future conversations".
 *
 * Proposes a MATERIAL change to a conversation plan: frequency, duration
 * and/or the recurring weekly times. Follows the approved consent rule:
 * nothing changes until the Companion accepts; the current plan keeps
 * running under its existing terms; pricing is recalculated SERVER-side
 * from the Companion's current rate (the browser only previews it).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import type { ConversationPlanRow, PlanScheduleSlotRow } from '../supabase/database.types';
import {
  buildWeeklyGrid,
  proposePlanChange,
  PlanError,
  validatePlanInput,
  weeklyPriceMinor,
  type PlanSlotInput,
  type WeeklyGridDay,
} from '../repositories/planRepository';
import {
  formatMinor,
  getAvailabilityRules,
  getPublicConversationOffers,
  ruleRowToWindow,
} from '../repositories/availabilityRepository';
import { browserTimezone } from '../domain/timezones';
import { FlowModal, IN_APP_CALL_LABEL } from './FlowModal';
import { WeeklySlotStage } from './WeeklySlotStage';
import { scheduleSummary } from './PlanWizard';

export function PlanChangeWizard({
  plan,
  currentSlots,
  companionName,
  onClose,
  onProposed,
}: {
  plan: ConversationPlanRow;
  currentSlots: PlanScheduleSlotRow[];
  companionName: string;
  onClose: () => void;
  onProposed: () => void;
}) {
  const viewerTz = browserTimezone();
  const companionTz = currentSlots[0]?.timezone ?? 'Europe/London';

  const [loading, setLoading] = useState(true);
  const [grid, setGrid] = useState<WeeklyGridDay[]>([]);
  const [durationOptions, setDurationOptions] = useState<{ minutes: number; priceMinor: number }[]>([]);

  const [frequency, setFrequency] = useState(plan.frequency_per_week);
  const [duration, setDuration] = useState(plan.duration_minutes);
  const [slots, setSlots] = useState<(PlanSlotInput | null)[]>(
    Array.from({ length: plan.frequency_per_week }, () => null),
  );
  const [step, setStep] = useState(0); // 0 freq, 1 duration, 2..n slots, review
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scheduleStages = frequency;
  const reviewStep = 2 + scheduleStages;
  const chosen = slots.filter((s): s is PlanSlotInput => Boolean(s?.time));

  const newUnit = durationOptions.find((d) => d.minutes === duration)?.priceMinor ?? null;
  const newWeekly = newUnit === null ? null : weeklyPriceMinor(newUnit, frequency);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [rules, offers] = await Promise.all([
          getAvailabilityRules(plan.companion_profile_id).catch(() => []),
          getPublicConversationOffers(plan.companion_profile_id).catch(() => []),
        ]);
        if (!live) return;
        setDurationOptions(
          [...new Map(
            offers
              .filter((o) => o.offer_type === 'single' && o.active)
              .map((o) => [o.duration_minutes, { minutes: o.duration_minutes, priceMinor: o.price_minor }]),
          ).values()].sort((a, b) => a.minutes - b.minutes),
        );
        setGrid(buildWeeklyGrid(rules.map(ruleRowToWindow), plan.duration_minutes));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [plan.companion_profile_id, plan.duration_minutes]);

  useEffect(() => {
    let live = true;
    getAvailabilityRules(plan.companion_profile_id)
      .then((rules) => live && setGrid(buildWeeklyGrid(rules.map(ruleRowToWindow), duration)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [plan.companion_profile_id, duration]);

  const changeFrequency = (next: number) => {
    const clamped = Math.max(1, Math.min(7, next));
    setFrequency(clamped);
    setSlots((prev) => {
      const kept = prev.slice(0, clamped);
      while (kept.length < clamped) kept.push(null);
      return kept;
    });
  };

  const setSlotAt = useCallback((index: number, slot: PlanSlotInput | null) => {
    setSlots((prev) => {
      const next = [...prev];
      next[index] = slot;
      return next;
    });
  }, []);

  const submit = async () => {
    if (submitting) return;
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
    setSubmitting(true);
    setError(null);
    try {
      await proposePlanChange(plan.id, input);
      onProposed();
    } catch (e) {
      setError(e instanceof PlanError ? e.message : 'We couldn’t propose this change. Please try again.');
      setSubmitting(false);
    }
  };

  const stageIndex = step >= 2 && step < reviewStep ? step - 2 : -1;
  const currentStage = stageIndex >= 0 ? slots[stageIndex] ?? null : null;
  const otherStages = stageIndex >= 0
    ? slots.filter((s, i): s is PlanSlotInput => i !== stageIndex && Boolean(s?.time))
    : [];

  const currentSummary = useMemo(
    () => scheduleSummary(
      currentSlots.map((s) => ({ day: s.iso_day, time: s.local_time.slice(0, 5) })),
      companionTz,
      viewerTz,
    ),
    [currentSlots, companionTz, viewerTz],
  );

  const canContinue =
    step === 0 ||
    (step === 1 && !!newUnit) ||
    (stageIndex >= 0 && Boolean(currentStage?.time)) ||
    step === reviewStep;

  if (loading) {
    return (
      <FlowModal title="Change this and future conversations" onClose={onClose}>
        <p className="muted">Getting things ready…</p>
      </FlowModal>
    );
  }

  return (
    <FlowModal
      title="Change this and future conversations"
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
            <button className="btn btn-primary" disabled={submitting} onClick={() => void submit()}>
              {submitting ? 'Sending…' : 'Request change'}
            </button>
          )}
        </>
      }
    >
      {step === 0 && (
        <section className="col" style={{ gap: 12 }} aria-label="How often">
          <h3 style={{ margin: 0 }}>How many conversations per week?</h3>
          <p className="faint longform" style={{ margin: 0 }}>
            Currently {plan.frequency_per_week} per week. {companionName} will need to approve any change.
          </p>
          <div className="row wrap" style={{ gap: 8 }}>
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <button
                key={n}
                className="chip"
                aria-pressed={frequency === n}
                onClick={() => changeFrequency(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="col" style={{ gap: 12 }} aria-label="How long">
          <h3 style={{ margin: 0 }}>How long should each conversation be?</h3>
          {durationOptions.length === 0 ? (
            <p className="muted longform">{companionName} hasn’t set conversation lengths yet.</p>
          ) : (
            <div className="col" style={{ gap: 8 }}>
              {durationOptions.map((d) => (
                <label key={d.minutes} className="card card-tight row between" style={{ cursor: 'pointer' }}>
                  <span className="row" style={{ gap: 10 }}>
                    <input
                      type="radio"
                      name="plan-change-duration"
                      checked={duration === d.minutes}
                      onChange={() => {
                        setDuration(d.minutes);
                        setSlots(Array.from({ length: frequency }, () => null));
                      }}
                    />
                    <span className="bold">{d.minutes} minutes</span>
                  </span>
                  <span className="faint">{formatMinor(d.priceMinor)} each</span>
                </label>
              ))}
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
            recommendation={null}
            onPick={(slot) => setSlotAt(stageIndex, slot)}
          />
          <p className="faint" style={{ margin: 0 }}>Times shown in your timezone ({viewerTz}).</p>
        </div>
      )}

      {step === reviewStep && (
        <section className="col" style={{ gap: 14 }} aria-label="Review change">
          <div className="card card-muted col" style={{ gap: 4 }}>
            <span className="muted">Current plan</span>
            <span className="bold">
              {plan.frequency_per_week} conversation{plan.frequency_per_week === 1 ? '' : 's'} per week ·{' '}
              {plan.duration_minutes} minutes
            </span>
            <span className="faint longform">{currentSummary}</span>
            <span className="muted">{formatMinor(plan.weekly_price_minor)} per week</span>
          </div>

          <div className="card card-tight col" style={{ gap: 4 }}>
            <span className="muted">Requested change</span>
            <span className="bold">
              {frequency} conversation{frequency === 1 ? '' : 's'} per week · {duration} minutes
            </span>
            <span className="faint row longform" style={{ gap: 6 }}>
              <CalendarDays size={14} aria-hidden="true" />
              {scheduleSummary(chosen, companionTz, viewerTz)}
            </span>
            {newWeekly !== null && (
              <span className="muted">
                About {formatMinor(newWeekly)} per week — the exact price is set from{' '}
                {companionName}’s current rate when the change is approved.
              </span>
            )}
            <span className="faint">{IN_APP_CALL_LABEL}</span>
          </div>

          <div className="banner banner-info">
            <strong>{companionName}’s approval is required.</strong> Your current plan continues
            unchanged until they accept. Conversations starting within the next two hours are
            never affected.
          </div>
        </section>
      )}
    </FlowModal>
  );
}
