/**
 * Companion "Your hours" control for the Settings page — set the weekly
 * availability windows the credit slot generator (get_credit_slots) reads. Built
 * from the same repository + WindowInput model the (now hidden) Availability &
 * rates page used, so it saves through replace_companion_availability and stays
 * consistent. Companion-only; edits the caller's own companion profile.
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Copy, Loader2 } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { browserTimezone, ISO_DAY_NAMES, validateWindows, type WindowInput } from '../domain/timezones';
import {
  getAvailabilityRules, ruleRowToWindow, getCompanionSchedulingSettings, replaceAvailabilityRules,
} from '../repositories/availabilityRepository';

const DAYS = [1, 2, 3, 4, 5, 6, 7];

export function AvailabilityHoursPanel() {
  const auth = useAuth();
  const profileId = useMemo(() => {
    const p = auth.profiles.find((x) => x.access.access_role === 'owner' && x.profile.role === 'companion');
    return p?.profile.id ?? '';
  }, [auth.profiles]);

  const [timezone, setTimezone] = useState(browserTimezone());
  const [windows, setWindows] = useState<WindowInput[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!profileId) { setLoading(false); return; }
    let live = true;
    Promise.all([getAvailabilityRules(profileId), getCompanionSchedulingSettings(profileId)])
      .then(([rules, settings]) => {
        if (!live) return;
        setWindows(rules.map(ruleRowToWindow));
        setTimezone(settings?.timezone ?? rules[0]?.timezone ?? browserTimezone());
      })
      .catch(() => { /* leave empty */ })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [profileId]);

  const windowsFor = (day: number) => windows.filter((w) => w.day === day).sort((a, b) => a.start.localeCompare(b.start));

  function addWindow(day: number) {
    const existing = windowsFor(day);
    const start = existing.length > 0 ? existing[existing.length - 1].end : '09:00';
    const end = start >= '21:00' ? '22:00' : `${String(Math.min(Number(start.slice(0, 2)) + 2, 23)).padStart(2, '0')}:00`;
    setWindows((w) => [...w, { day, start, end }]);
    setMsg(null);
  }
  function updateWindow(day: number, index: number, patch: Partial<WindowInput>) {
    setWindows((all) => {
      const forDay = all.filter((w) => w.day === day).sort((a, b) => a.start.localeCompare(b.start));
      const others = all.filter((w) => w.day !== day);
      forDay[index] = { ...forDay[index], ...patch };
      return [...others, ...forDay];
    });
  }
  function removeWindow(day: number, index: number) {
    setWindows((all) => {
      const forDay = all.filter((w) => w.day === day).sort((a, b) => a.start.localeCompare(b.start));
      const others = all.filter((w) => w.day !== day);
      forDay.splice(index, 1);
      return [...others, ...forDay];
    });
  }
  function copyDay(day: number) {
    const source = windowsFor(day);
    if (source.length === 0) return;
    setWindows((all) => {
      const targetDays = [...new Set(all.filter((w) => w.day !== day).map((w) => w.day))];
      const untouched = all.filter((w) => w.day === day || !targetDays.includes(w.day));
      const copies = targetDays.flatMap((d) => source.map((s) => ({ ...s, day: d })));
      return [...untouched, ...copies];
    });
  }

  async function save() {
    if (saving) return;
    const problem = validateWindows(windows);
    if (problem) { setErr(problem); setMsg(null); return; }
    setSaving(true); setErr(null); setMsg(null);
    try {
      await replaceAvailabilityRules(profileId, timezone, windows);
      setMsg('Your hours have been saved.');
    } catch {
      setErr('We couldn’t save your hours. Please try again.');
    }
    setSaving(false);
  }

  if (!profileId) return null;

  return (
    <section className="card col" style={{ gap: 12 }} aria-label="Your weekly hours">
      <div>
        <strong>Your hours</strong>
        <div className="muted small">When you’re available for calls each week. Members can only book inside these times.</div>
      </div>

      {loading ? (
        <div className="row" style={{ justifyContent: 'center', padding: 12 }}><Loader2 size={20} className="spin" aria-hidden="true" /></div>
      ) : (
        <>
          {err && <p className="banner banner-danger" role="alert" style={{ margin: 0 }}>{err}</p>}
          <div className="col" style={{ gap: 10 }}>
            {DAYS.map((day) => {
              const dayWindows = windowsFor(day);
              const enabled = dayWindows.length > 0;
              return (
                <div key={day} className="card card-tight" style={{ background: enabled ? undefined : 'var(--color-surface-muted)' }}>
                  <div className="row between wrap" style={{ gap: 10, alignItems: 'center' }}>
                    <label className="row" style={{ gap: 10, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={enabled}
                        style={{ width: 20, height: 20 }}
                        onChange={(e) => {
                          if (e.target.checked) addWindow(day);
                          else setWindows((all) => all.filter((w) => w.day !== day));
                        }}
                        aria-label={`Available on ${ISO_DAY_NAMES[day]}s`}
                      />
                      <span className="bold">{ISO_DAY_NAMES[day]}</span>
                    </label>
                    {enabled && (
                      <div className="row" style={{ gap: 4 }}>
                        <button className="icon-btn" aria-label={`Copy ${ISO_DAY_NAMES[day]}'s times to your other active days`} onClick={() => copyDay(day)}>
                          <Copy size={16} aria-hidden="true" />
                        </button>
                        <button className="icon-btn" aria-label={`Add a time range on ${ISO_DAY_NAMES[day]}`} onClick={() => addWindow(day)}>
                          <Plus size={16} aria-hidden="true" />
                        </button>
                      </div>
                    )}
                  </div>
                  {enabled && (
                    <div className="col mt-2" style={{ gap: 8 }}>
                      {dayWindows.map((w, i) => (
                        <div key={`${day}-${i}`} className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                          <input type="time" value={w.start} style={{ width: 130 }}
                            aria-label={`${ISO_DAY_NAMES[day]} window ${i + 1} start`}
                            onChange={(e) => updateWindow(day, i, { start: e.target.value })} />
                          <span className="muted">to</span>
                          <input type="time" value={w.end} style={{ width: 130 }}
                            aria-label={`${ISO_DAY_NAMES[day]} window ${i + 1} end`}
                            onChange={(e) => updateWindow(day, i, { end: e.target.value })} />
                          <button className="icon-btn" aria-label="Remove this time range" onClick={() => removeWindow(day, i)}>
                            <Trash2 size={16} aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="row between" style={{ alignItems: 'center' }}>
            <span className="muted small">Times are in {timezone}.</span>
            <button className="btn btn-primary btn-small" disabled={saving} onClick={save}>
              {saving ? <Loader2 size={15} className="spin" aria-hidden="true" /> : null} Save hours
            </button>
          </div>
          {msg && <p className="small" role="status" style={{ margin: 0 }}>{msg}</p>}
        </>
      )}
    </section>
  );
}
