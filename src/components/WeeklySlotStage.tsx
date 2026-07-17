/**
 * Corrective Stage 2E4B — one sub-stage of the recurring schedule.
 *
 * "Conversation 2 of 3": pick a weekday, then a time on that weekday.
 * Only the Companion's real recurring availability is offered, times are
 * shown in the viewer's timezone, and any weekday/time already taken by
 * another conversation in this plan is blocked.
 */
import { CheckCircle2 } from 'lucide-react';
import type { PlanSlotInput, WeeklyGridDay } from '../repositories/planRepository';
import { ISO_DAY_NAMES } from '../domain/timezones';
import { slotLabel, slotTimeInViewerTz } from './PlanWizard';

export function WeeklySlotStage({
  index,
  total,
  grid,
  chosen,
  others,
  companionTz,
  viewerTz,
  recommendation,
  onPick,
}: {
  /** 1-based: "Conversation {index} of {total}". */
  index: number;
  total: number;
  grid: WeeklyGridDay[];
  chosen: PlanSlotInput | null;
  /** The other conversations in this plan — their times are unavailable. */
  others: PlanSlotInput[];
  companionTz: string;
  viewerTz: string;
  recommendation?: PlanSlotInput | null;
  onPick: (slot: PlanSlotInput | null) => void;
}) {
  const takenKey = (s: PlanSlotInput) => `${s.day}-${s.time}`;
  const taken = new Set(others.map(takenKey));

  if (grid.length === 0) {
    return (
      <p className="muted longform">
        No weekly availability published for this conversation length yet — try a shorter
        conversation, or ask about a one-off instead.
      </p>
    );
  }

  const activeDay = chosen?.day ?? recommendation?.day ?? grid[0].isoDay;
  const dayTimes = grid.find((d) => d.isoDay === activeDay)?.times ?? [];

  return (
    <section className="col" style={{ gap: 12 }} aria-label={`Conversation ${index} of ${total}`}>
      <div className="col" style={{ gap: 4 }}>
        <span className="faint">Conversation {index} of {total}</span>
        <h3 style={{ margin: 0 }}>Which day and time each week?</h3>
        {others.length > 0 && (
          <p className="faint" style={{ margin: 0 }}>
            Already chosen: {others.map((s) => slotLabel(s, companionTz, viewerTz)).join(' · ')}
          </p>
        )}
      </div>

      <div className="col" style={{ gap: 6 }}>
        <span className="bold">Day</span>
        <div className="row wrap" style={{ gap: 6 }}>
          {grid.map((day) => {
            const isActive = activeDay === day.isoDay;
            // A day is only unusable when every one of its times is taken.
            const allTaken = day.times.every((t) => taken.has(`${day.isoDay}-${t}`));
            return (
              <button
                key={day.isoDay}
                className={`btn btn-small ${isActive ? 'btn-primary' : 'btn-secondary'}`}
                aria-pressed={isActive}
                disabled={allTaken}
                onClick={() => onPick(chosen && chosen.day === day.isoDay ? chosen : { day: day.isoDay, time: '' })}
              >
                {ISO_DAY_NAMES[day.isoDay]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="col" style={{ gap: 6 }}>
        <span className="bold">Time on {ISO_DAY_NAMES[activeDay]}</span>
        <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Available times">
          {dayTimes.map((t) => {
            const isTaken = taken.has(`${activeDay}-${t}`);
            const isSelected = chosen?.day === activeDay && chosen?.time === t;
            return (
              <button
                key={t}
                className={`btn btn-small ${isSelected ? 'btn-primary' : 'btn-secondary'}`}
                aria-pressed={isSelected}
                aria-label={`${ISO_DAY_NAMES[activeDay]} ${t}`}
                disabled={isTaken}
                title={isTaken ? 'Already used by another conversation in this plan' : undefined}
                onClick={() => onPick({ day: activeDay, time: t })}
              >
                {slotTimeInViewerTz({ day: activeDay, time: t }, companionTz, viewerTz)}
              </button>
            );
          })}
        </div>
      </div>

      {recommendation && !chosen && (
        <button
          className="btn btn-ghost btn-small"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => onPick(recommendation)}
        >
          Use {slotLabel(recommendation, companionTz, viewerTz)} (recommended)
        </button>
      )}

      {chosen?.time && (
        <p className="row" style={{ gap: 6, margin: 0 }}>
          <CheckCircle2 size={16} aria-hidden="true" style={{ color: 'var(--color-success-text)' }} />
          <span className="bold">{slotLabel(chosen, companionTz, viewerTz)}</span>
          <span className="faint">every week</span>
        </p>
      )}
    </section>
  );
}
