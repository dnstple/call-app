/**
 * Stage 2E4B — "Start regular conversations" wizard (Supabase mode).
 *
 * Six steps: frequency → duration → method → weekly schedule → review →
 * request. The Member is arranging ongoing companionship, not buying a
 * bundle: no package, credit or purchase language appears anywhere.
 *
 * planRepository is the only data path. The browser never sends prices —
 * the weekly price shown here is a preview of what the SERVER will
 * snapshot (frequency × the Companion's per-conversation rate).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CalendarDays, Check, Loader2, X } from 'lucide-react';
import type { User } from '../types';
import type { ConversationOfferRow } from '../supabase/database.types';
import {
  buildWeeklyGrid,
  createConversationPlan,
  getMemberPlanPreferences,
  PlanError,
  recommendedDuration,
  recommendedFrequency,
  recommendSchedule,
  validatePlanInput,
  weeklyPriceMinor,
  type MemberPlanPreferences,
  type PlanSlotInput,
  type WeeklyGridDay,
} from '../repositories/planRepository';
import { getAvailabilityRules, formatMinor, ruleRowToWindow } from '../repositories/availabilityRepository';
import { browserTimezone, ISO_DAY_NAMES, nextDateForIsoDay, wallTimeToUtc } from '../domain/timezones';
import { MEDIUM_LABELS } from '../domain/format';
import { useAuthSnapshot } from '../state/authBridge';
import { ProfilePhoto } from './ui';

const FREQUENCY_OPTIONS = [1, 2, 3, 4] as const;

/**
 * The instant of the next occurrence of a weekly slot — DST-safe, so a
 * viewer abroad sees the right weekday AND time, not a manual offset.
 */
function slotInstant(slot: PlanSlotInput, companionTz: string): Date {
  const [h, m] = slot.time.split(':').map(Number);
  const date = nextDateForIsoDay(slot.day, companionTz);
  return wallTimeToUtc(date.y, date.m, date.d, h, m, companionTz);
}

/** "18:00" in the viewer's timezone. */
export function slotTimeInViewerTz(slot: PlanSlotInput, companionTz: string, viewerTz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: viewerTz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(slotInstant(slot, companionTz));
}

/** "Tuesday 6pm" — friendly, viewer-timezone aware (weekday included). */
export function slotLabel(slot: PlanSlotInput, companionTz: string, viewerTz: string): string {
  const instant = slotInstant(slot, companionTz);
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: viewerTz, weekday: 'long' }).format(instant);
  const [h, m] = slotTimeInViewerTz(slot, companionTz, viewerTz).split(':').map(Number);
  const suffix = h < 12 ? 'am' : 'pm';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const time = m === 0 ? `${hour12}${suffix}` : `${hour12}:${String(m).padStart(2, '0')}${suffix}`;
  return `${weekday} ${time}`;
}

export function scheduleSummary(slots: PlanSlotInput[], companionTz: string, viewerTz: string): string {
  return [...slots].sort((a, b) => a.day - b.day).map((s) => slotLabel(s, companionTz, viewerTz)).join(' · ');
}

type Step = 1 | 2 | 3 | 4 | 5 | 6;

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

  const [step, setStep] = useState<Step>(1);
  const [prefs, setPrefs] = useState<MemberPlanPreferences | null>(null);
  const [companionTz, setCompanionTz] = useState('Europe/London');
  const [grid, setGrid] = useState<WeeklyGridDay[]>([]);
  const [loading, setLoading] = useState(true);

  const [frequency, setFrequency] = useState(3);
  const [duration, setDuration] = useState(30);
  const [method, setMethod] = useState('phone');
  const [slots, setSlots] = useState<PlanSlotInput[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Durations the Companion actually offers a rate for.
  const durationOptions = useMemo(
    () => [...new Set(offers.filter((o) => o.offer_type === 'single').map((o) => o.duration_minutes))].sort((a, b) => a - b),
    [offers],
  );
  const offerForDuration = useMemo(
    () => offers.find((o) => o.offer_type === 'single' && o.duration_minutes === duration) ?? null,
    [offers, duration],
  );
  const methodOptions = offerForDuration?.supported_methods ?? ['phone'];
  const perConversation = offerForDuration?.price_minor ?? 0;
  const weekly = weeklyPriceMinor(perConversation, frequency);

  const recommended = prefs ? recommendedFrequency(prefs) : 3;

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
        const preferredDuration = recommendedDuration(p);
        const firstDuration = durationOptions.includes(preferredDuration)
          ? preferredDuration
          : durationOptions[0] ?? 30;
        setDuration(firstDuration);
        setFrequency(recommendedFrequency(p));
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

  // The grid depends on duration (a longer conversation needs a longer window).
  useEffect(() => {
    let live = true;
    getAvailabilityRules(companion.id)
      .then((rules) => live && setGrid(buildWeeklyGrid(rules.map(ruleRowToWindow), duration)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [companion.id, duration]);

  useEffect(() => {
    if (!methodOptions.includes(method)) setMethod(methodOptions[0] ?? 'phone');
  }, [methodOptions, method]);

  // Trim or top up the schedule when the frequency changes.
  useEffect(() => {
    setSlots((prev) => (prev.length > frequency ? prev.slice(0, frequency) : prev));
  }, [frequency]);

  const applyRecommendedSchedule = useCallback(() => {
    if (prefs) setSlots(recommendSchedule(grid, prefs, frequency));
  }, [grid, prefs, frequency]);

  const toggleSlot = (day: number, time: string) => {
    setSlots((prev) => {
      const existing = prev.find((s) => s.day === day && s.time === time);
      if (existing) return prev.filter((s) => s !== existing);
      const withoutDay = prev.filter((s) => s.day !== day); // one per day keeps a rhythm
      if (withoutDay.length >= frequency) return prev; // full — deselect something first
      return [...withoutDay, { day, time }].sort((a, b) => a.day - b.day);
    });
  };

  const submit = async () => {
    if (submitting) return; // duplicate-click protection
    const input = { frequencyPerWeek: frequency, durationMinutes: duration, communicationMethod: method, slots };
    const invalid = validatePlanInput(input);
    if (invalid) {
      setError(invalid.message);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createConversationPlan(memberProfileId, companion.id, input);
      setStep(6);
      onCreated?.();
    } catch (e) {
      setError(e instanceof PlanError ? e.message : 'We couldn’t set up this plan. Please try again.');
      setSubmitting(false);
    }
  };

  const canContinue =
    (step === 1 && frequency >= 1) ||
    (step === 2 && !!offerForDuration) ||
    (step === 3 && !!method) ||
    (step === 4 && slots.length === frequency);

  if (loading) {
    return (
      <Dialog title={`Regular conversations with ${companion.firstName}`} onClose={onClose}>
        <div className="row" style={{ gap: 10 }}>
          <Loader2 size={20} aria-hidden="true" />
          <span className="muted">Getting things ready…</span>
        </div>
      </Dialog>
    );
  }

  if (step === 6) {
    return (
      <Dialog title="Plan requested" onClose={onClose}>
        <div className="col" style={{ gap: 14, alignItems: 'center', textAlign: 'center' }}>
          <ProfilePhoto user={companion} size={96} radius={24} />
          <h3 style={{ margin: 0 }}>{companion.firstName} will confirm your plan</h3>
          <p className="muted" style={{ margin: 0 }}>
            We’ve sent your request for {frequency} conversation{frequency === 1 ? '' : 's'} a week.
            Once {companion.firstName} says yes, the conversations appear in your diary automatically.
          </p>
          <p className="faint" style={{ margin: 0 }}>Prototype plan — no payment will be taken.</p>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={`Regular conversations with ${companion.firstName}`} onClose={onClose}>
      <StepDots step={step} />
      {error && <p role="alert" className="badge badge-danger" style={{ display: 'block', marginBottom: 12 }}>{error}</p>}

      {step === 1 && (
        <section className="col" style={{ gap: 14 }} aria-label="How often">
          <div>
            <h3 style={{ margin: '0 0 4px' }}>How often would you like to talk?</h3>
            <p className="muted" style={{ margin: 0 }}>
              {member ? `Recommended for ${member.first_name}: ` : 'Recommended: '}
              <strong>{recommended} conversation{recommended === 1 ? '' : 's'} per week</strong>
              {prefs && prefs.preferredDays.length > 0 && ` — based on the days they chose`}
            </p>
          </div>
          <div className="col" style={{ gap: 8 }}>
            {FREQUENCY_OPTIONS.map((n) => (
              <label key={n} className="card card-tight row between" style={{ cursor: 'pointer' }}>
                <span className="row" style={{ gap: 10 }}>
                  <input
                    type="radio"
                    name="plan-frequency"
                    checked={frequency === n}
                    onChange={() => setFrequency(n)}
                  />
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
                onChange={() => setFrequency(5)}
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
                      onChange={(e) => setFrequency(Math.max(1, Math.min(7, Number(e.target.value) || 1)))}
                    />
                  </label>
                )}
              </span>
            </label>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="col" style={{ gap: 14 }} aria-label="How long">
          <h3 style={{ margin: 0 }}>How long should each conversation be?</h3>
          {durationOptions.length === 0 ? (
            <p className="muted">{companion.firstName} hasn’t set their conversation lengths yet.</p>
          ) : (
            <div className="col" style={{ gap: 8 }}>
              {durationOptions.map((d) => {
                const offer = offers.find((o) => o.offer_type === 'single' && o.duration_minutes === d);
                return (
                  <label key={d} className="card card-tight row between" style={{ cursor: 'pointer' }}>
                    <span className="row" style={{ gap: 10 }}>
                      <input type="radio" name="plan-duration" checked={duration === d} onChange={() => { setDuration(d); setSlots([]); }} />
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

      {step === 3 && (
        <section className="col" style={{ gap: 14 }} aria-label="How to talk">
          <h3 style={{ margin: 0 }}>How would you like to talk?</h3>
          <div className="col" style={{ gap: 8 }}>
            {methodOptions.map((m) => (
              <label key={m} className="card card-tight row" style={{ gap: 10, cursor: 'pointer' }}>
                <input type="radio" name="plan-method" checked={method === m} onChange={() => setMethod(m)} />
                <span className="bold">{MEDIUM_LABELS[m as keyof typeof MEDIUM_LABELS] ?? m}</span>
              </label>
            ))}
          </div>
        </section>
      )}

      {step === 4 && (
        <section className="col" style={{ gap: 14 }} aria-label="Weekly schedule">
          <div>
            <h3 style={{ margin: '0 0 4px' }}>Choose your weekly times</h3>
            <p className="muted" style={{ margin: 0 }}>
              Pick {frequency} time{frequency === 1 ? '' : 's'} — the same every week.{' '}
              <span className="faint">Shown in your timezone ({viewerTz}).</span>
            </p>
          </div>
          <WeeklyScheduler
            grid={grid}
            slots={slots}
            frequency={frequency}
            companionTz={companionTz}
            viewerTz={viewerTz}
            onToggle={toggleSlot}
          />
          <div className="row wrap between" style={{ gap: 10 }}>
            <span className={slots.length === frequency ? 'bold' : 'muted'}>
              {slots.length} of {frequency} chosen
            </span>
            {prefs && grid.length > 0 && (
              <button className="btn btn-ghost btn-small" onClick={applyRecommendedSchedule}>
                Use recommended times
              </button>
            )}
          </div>
        </section>
      )}

      {step === 5 && (
        <section className="col" style={{ gap: 14 }} aria-label="Review plan">
          <div className="card card-muted row" style={{ gap: 14 }}>
            <ProfilePhoto user={companion} size={64} radius={16} />
            <div className="col" style={{ gap: 2 }}>
              <span className="bold">Regular conversations with {companion.firstName}</span>
              {member && <span className="muted">For {member.first_name} {member.last_name}</span>}
            </div>
          </div>
          <div className="card card-tight col" style={{ gap: 8 }}>
            <Row label="How often" value={`${frequency} conversation${frequency === 1 ? '' : 's'} per week`} />
            <Row label="Each conversation" value={`${duration} minutes`} />
            <Row label="How you’ll talk" value={MEDIUM_LABELS[method as keyof typeof MEDIUM_LABELS] ?? method} />
            <div className="col" style={{ gap: 4 }}>
              <span className="muted">Your weekly times</span>
              <span className="bold row" style={{ gap: 8 }}>
                <CalendarDays size={16} aria-hidden="true" />
                {scheduleSummary(slots, companionTz, viewerTz)}
              </span>
            </div>
          </div>
          <div className="card card-tight col" style={{ gap: 4 }}>
            <div className="row between">
              <span className="muted">Weekly total</span>
              <span className="bold" style={{ fontSize: '1.2em' }}>{formatMinor(weekly)} per week</span>
            </div>
            <span className="faint">
              {formatMinor(perConversation)} × {frequency} conversation{frequency === 1 ? '' : 's'}
            </span>
            <p className="faint" style={{ margin: '6px 0 0' }}>
              Prototype plan — no payment will be taken.
            </p>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            {companion.firstName} will confirm before anything is arranged.
          </p>
        </section>
      )}

      <div className="row between mt-4" style={{ gap: 10 }}>
        <button
          className="btn btn-ghost"
          disabled={submitting}
          onClick={() => (step === 1 ? onClose() : setStep((step - 1) as Step))}
        >
          {step === 1 ? 'Cancel' : 'Back'}
        </button>
        {step < 5 ? (
          <button className="btn btn-primary" disabled={!canContinue} onClick={() => setStep((step + 1) as Step)}>
            Continue
          </button>
        ) : (
          <button className="btn btn-primary" disabled={submitting} onClick={() => void submit()}>
            {submitting ? 'Sending…' : 'Request plan'}
          </button>
        )}
      </div>
    </Dialog>
  );
}

/* ---------------- The weekly scheduler (flagship) ---------------- */

export function WeeklyScheduler({
  grid,
  slots,
  frequency,
  companionTz,
  viewerTz,
  onToggle,
}: {
  grid: WeeklyGridDay[];
  slots: PlanSlotInput[];
  frequency: number;
  companionTz: string;
  viewerTz: string;
  onToggle: (day: number, time: string) => void;
}) {
  if (grid.length === 0) {
    return (
      <p className="muted">
        No weekly availability published yet — try a different conversation length, or a one-off
        conversation for now.
      </p>
    );
  }
  const full = slots.length >= frequency;
  return (
    <div className="col" style={{ gap: 12 }}>
      {grid.map((day) => {
        const chosen = slots.find((s) => s.day === day.isoDay);
        return (
          <div key={day.isoDay} className="col" style={{ gap: 6 }}>
            <div className="row between">
              <span className="bold">{ISO_DAY_NAMES[day.isoDay]}</span>
              {chosen && (
                <span className="badge badge-success row" style={{ gap: 4 }}>
                  <Check size={12} aria-hidden="true" /> {slotLabel(chosen, companionTz, viewerTz)}
                </span>
              )}
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              {day.times.map((t) => {
                const selected = chosen?.time === t;
                const blocked = full && !chosen; // this day can't be added yet
                return (
                  <button
                    key={t}
                    className={`btn btn-small ${selected ? 'btn-primary' : 'btn-secondary'}`}
                    aria-pressed={selected}
                    aria-label={`${ISO_DAY_NAMES[day.isoDay]} ${t}`}
                    disabled={blocked}
                    onClick={() => onToggle(day.isoDay, t)}
                  >
                    {slotTimeInViewerTz({ day: day.isoDay, time: t }, companionTz, viewerTz)}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- small pieces ---------------- */

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row between">
      <span className="muted">{label}</span>
      <span className="bold">{value}</span>
    </div>
  );
}

function StepDots({ step }: { step: Step }) {
  return (
    <div className="row mb-4" style={{ gap: 6 }} aria-label={`Step ${step} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          aria-hidden="true"
          style={{
            height: 4,
            flex: 1,
            borderRadius: 2,
            background: n <= step ? 'var(--color-brand)' : 'var(--color-surface-muted)',
          }}
        />
      ))}
    </div>
  );
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal card"
        style={{ maxWidth: 560, width: '100%', maxHeight: '88vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row between mb-4">
          <h2 style={{ margin: 0, fontSize: '1.15em' }}>{title}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
