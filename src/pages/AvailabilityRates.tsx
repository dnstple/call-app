/**
 * Availability & rates editor (Supabase mode, Companions).
 * Recurring weekly windows, time off / one-off availability, scheduling
 * settings and conversation offers with fee previews. Payments are NOT
 * enabled yet — prices persist for when booking arrives.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Copy, Loader2, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { isSupabaseMode } from '../config/dataMode';
import { pushToast } from '../state/store';
import { PageHeader, Switch } from '../components/ui';
import { PackageOfferEditor } from '../components/PackageOfferEditor';
import { RepoError } from '../repositories/profileRepository';
import * as repo from '../repositories/availabilityRepository';
import { clearSetupIncomplete } from '../signup/completeSupabase';
import {
  browserTimezone,
  COMMON_TIMEZONES,
  ISO_DAY_NAMES,
  validateWindows,
  type WindowInput,
} from '../domain/timezones';
import type { AvailabilityExceptionRow, ConversationOfferRow } from '../supabase/database.types';

const DAYS = [1, 2, 3, 4, 5, 6, 7];
const NOTICE_OPTIONS = [0, 6, 12, 24, 48, 72];
const HORIZON_OPTIONS = [14, 30, 60, 90];

export default function AvailabilityRates() {
  const auth = useAuth();
  const navigate = useNavigate();
  const active = auth.profiles.find((p) => p.profile.id === auth.activeProfileId);
  const profileId = active?.profile.id ?? '';
  const allowed =
    isSupabaseMode() && active?.profile.role === 'companion' && active.access.can_edit;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [timezone, setTimezone] = useState(browserTimezone());
  const [windows, setWindows] = useState<WindowInput[]>([]);
  const [notice, setNotice] = useState(24);
  const [horizon, setHorizon] = useState(60);
  const [accepting, setAccepting] = useState(true);
  const [initial, setInitial] = useState('');

  const [exceptions, setExceptions] = useState<AvailabilityExceptionRow[]>([]);
  const [offers, setOffers] = useState<ConversationOfferRow[]>([]);
  const [rates, setRates] = useState({ trialPct: 0, standardPct: 2 });

  const snapshot = useMemo(
    () => JSON.stringify({ timezone, windows, notice, horizon, accepting }),
    [timezone, windows, notice, horizon, accepting],
  );
  const dirty = initial !== '' && snapshot !== initial;

  useEffect(() => {
    if (!allowed || !profileId) return;
    let live = true;
    (async () => {
      try {
        const [rules, settings, exc, offs, commission] = await Promise.all([
          repo.getAvailabilityRules(profileId),
          repo.getCompanionSchedulingSettings(profileId),
          repo.getAvailabilityExceptions(profileId),
          repo.getConversationOffers(profileId),
          repo.getPublicCommissionSettings().catch(() => ({ trialPct: 0, standardPct: 2 })),
        ]);
        if (!live) return;
        const ws = rules.map(repo.ruleRowToWindow);
        setWindows(ws);
        setTimezone(settings?.timezone ?? rules[0]?.timezone ?? browserTimezone());
        setNotice(settings?.minimumNoticeHours ?? 24);
        setHorizon(settings?.bookingHorizonDays ?? 60);
        setAccepting(settings?.acceptingNewMembers ?? true);
        setExceptions(exc);
        setOffers(offs);
        setRates(commission);
        setInitial(
          JSON.stringify({
            timezone: settings?.timezone ?? rules[0]?.timezone ?? browserTimezone(),
            windows: ws,
            notice: settings?.minimumNoticeHours ?? 24,
            horizon: settings?.bookingHorizonDays ?? 60,
            accepting: settings?.acceptingNewMembers ?? true,
          }),
        );
      } catch (e) {
        if (live) setError(e instanceof RepoError ? e.message : 'We couldn’t load your availability.');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [allowed, profileId]);

  // Unsaved-change warning.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  if (!allowed) {
    return (
      <div className="empty-state">
        <h3>Availability & rates</h3>
        <p>This page is for Companion profiles you can edit, in Supabase mode.</p>
        <button className="btn btn-secondary" onClick={() => navigate('/')}>Go home</button>
      </div>
    );
  }

  function windowsFor(day: number): WindowInput[] {
    return windows.filter((w) => w.day === day).sort((a, b) => a.start.localeCompare(b.start));
  }

  function addWindow(day: number) {
    const existing = windowsFor(day);
    const start = existing.length > 0 ? existing[existing.length - 1].end : '09:00';
    const end = start >= '21:00' ? '22:00' : `${String(Math.min(Number(start.slice(0, 2)) + 2, 23)).padStart(2, '0')}:00`;
    setWindows((w) => [...w, { day, start, end }]);
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

  /** Copy this day's times to every other day that already has windows. */
  function copyDay(day: number) {
    const source = windowsFor(day);
    if (source.length === 0) return;
    setWindows((all) => {
      const targetDays = [...new Set(all.filter((w) => w.day !== day).map((w) => w.day))];
      const untouched = all.filter((w) => w.day === day || !targetDays.includes(w.day));
      const copies = targetDays.flatMap((d) => source.map((s) => ({ ...s, day: d })));
      return [...untouched, ...copies];
    });
    pushToast('Copied to your other active days', 'ok');
  }

  async function save() {
    if (saving) return;
    const problem = validateWindows(windows);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await repo.replaceAvailabilityRules(profileId, timezone, windows);
      await repo.updateCompanionSchedulingSettings(profileId, {
        timezone,
        minimumNoticeHours: notice,
        bookingHorizonDays: horizon,
        acceptingNewMembers: accepting,
      });
      clearSetupIncomplete(profileId);
      setInitial(snapshot);
      pushToast('Availability saved', 'ok');
    } catch (e) {
      setError(e instanceof RepoError ? e.message : 'We couldn’t save your availability.');
    } finally {
      setSaving(false);
    }
  }

  async function reloadOffers() {
    setOffers(await repo.getConversationOffers(profileId));
  }

  if (loading) {
    return (
      <div className="row" style={{ justifyContent: 'center', padding: 64 }}>
        <Loader2 size={26} aria-hidden="true" />
        <span className="muted">Loading your availability…</span>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <button className="btn btn-ghost btn-small" onClick={() => navigate(-1)} style={{ marginBottom: 8 }}>
        <ArrowLeft size={18} aria-hidden="true" /> Back
      </button>
      <PageHeader
        title="Availability & rates"
        subtitle="When are you usually available for conversations, and what do you charge?"
      />

      {error && <div className="banner banner-danger mb-4" role="alert">{error}</div>}

      {/* ---------- Weekly availability ---------- */}
      <section className="card">
        <h2>Weekly availability</h2>
        <div className="field" style={{ maxWidth: 340 }}>
          <label htmlFor="av-tz">Your timezone</label>
          <select id="av-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {[...new Set([timezone, ...COMMON_TIMEZONES])].map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </select>
          <span className="hint">All times below are in this timezone.</span>
        </div>

        <div className="col" style={{ gap: 12 }}>
          {DAYS.map((day) => {
            const dayWindows = windowsFor(day);
            const enabled = dayWindows.length > 0;
            return (
              <div key={day} className="card card-tight" style={{ background: enabled ? undefined : 'var(--color-surface-muted)' }}>
                <div className="row between wrap" style={{ gap: 10 }}>
                  <label className="row" style={{ gap: 10 }}>
                    <input
                      type="checkbox"
                      checked={enabled}
                      style={{ width: 22, height: 22 }}
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
                        <Copy size={18} aria-hidden="true" />
                      </button>
                      <button className="icon-btn" aria-label={`Add a time range on ${ISO_DAY_NAMES[day]}`} onClick={() => addWindow(day)}>
                        <Plus size={18} aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </div>
                {enabled && (
                  <div className="col mt-2" style={{ gap: 8 }}>
                    {dayWindows.map((w, i) => (
                      <div key={`${day}-${i}`} className="row wrap" style={{ gap: 8 }}>
                        <input
                          type="time"
                          value={w.start}
                          onChange={(e) => updateWindow(day, i, { start: e.target.value })}
                          aria-label={`${ISO_DAY_NAMES[day]} window ${i + 1} start`}
                          style={{ width: 130 }}
                        />
                        <span className="muted">to</span>
                        <input
                          type="time"
                          value={w.end}
                          onChange={(e) => updateWindow(day, i, { end: e.target.value })}
                          aria-label={`${ISO_DAY_NAMES[day]} window ${i + 1} end`}
                          style={{ width: 130 }}
                        />
                        <button className="icon-btn" aria-label="Remove this time range" onClick={() => removeWindow(day, i)}>
                          <Trash2 size={18} aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="grid-2 mt-5">
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="av-notice">Minimum notice</label>
            <select id="av-notice" value={notice} onChange={(e) => setNotice(Number(e.target.value))}>
              {NOTICE_OPTIONS.map((n) => (
                <option key={n} value={n}>{n === 0 ? 'No minimum' : `${n} hours`}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="av-horizon">How far ahead people can book</label>
            <select id="av-horizon" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
              {HORIZON_OPTIONS.map((h) => (
                <option key={h} value={h}>{h} days</option>
              ))}
            </select>
          </div>
        </div>
        <Switch
          label="Accepting new members"
          description="Turn off to pause appearing as available in Explore"
          checked={accepting}
          onChange={setAccepting}
        />
        <div className="row between mt-4">
          {dirty ? <span className="faint">Unsaved changes</span> : <span />}
          <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
            {saving ? <Loader2 size={18} aria-hidden="true" /> : null} Save availability
          </button>
        </div>
      </section>

      {/* ---------- Exceptions ---------- */}
      <section className="card section-tight">
        <h2>Time off and one-off availability</h2>
        <p className="muted">Private to you — notes are never shown on your public profile.</p>
        <ExceptionsEditor profileId={profileId} exceptions={exceptions} onChanged={setExceptions} />
      </section>

      {/* ---------- Offers ---------- */}
      <section className="card section-tight">
        <h2>Conversation rates</h2>
        <div className="banner mb-4">
          Payments are not enabled yet. These prices will be used when bookings and payments are
          introduced.
        </div>
        <OffersEditor profileId={profileId} offers={offers} rates={rates} methods={active?.profile.mediums ?? []} onChanged={reloadOffers} />
      </section>

      {/* ---------- Packages (Stage 2E3B1) ---------- */}
      <PackageOfferEditor profileId={profileId} methods={active?.profile.mediums ?? []} />
    </div>
  );
}

/* ================= Exceptions ================= */

function ExceptionsEditor({
  profileId,
  exceptions,
  onChanged,
}: {
  profileId: string;
  exceptions: AvailabilityExceptionRow[];
  onChanged: (rows: AvailabilityExceptionRow[]) => void;
}) {
  const [type, setType] = useState<'unavailable' | 'additionally_available'>('unavailable');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (busy) return;
    if (!start || !end) {
      setError('Please choose a start and end.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await repo.addAvailabilityException(profileId, {
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(end).toISOString(),
        type,
        note: note.trim() || undefined,
      });
      onChanged(await repo.getAvailabilityExceptions(profileId));
      setStart('');
      setEnd('');
      setNote('');
      pushToast('Saved', 'ok');
    } catch (e) {
      setError(e instanceof RepoError ? e.message : 'We couldn’t save that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 12 }}>
      {error && <div className="banner banner-danger" role="alert">{error}</div>}
      {exceptions.length > 0 && (
        <div className="stack-list">
          {exceptions.map((e) => (
            <div key={e.id} className="row between wrap card card-tight">
              <div>
                <span className={`badge ${e.exception_type === 'unavailable' ? 'badge-neutral' : 'badge-success'}`}>
                  {e.exception_type === 'unavailable' ? 'Time off' : 'Extra availability'}
                </span>{' '}
                <span className="muted small">
                  {new Date(e.starts_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} –{' '}
                  {new Date(e.ends_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
                {e.note && <div className="faint">{e.note} (private)</div>}
              </div>
              <button
                className="icon-btn"
                aria-label="Remove this exception"
                onClick={async () => {
                  await repo.removeAvailabilityException(e.id);
                  onChanged(await repo.getAvailabilityExceptions(profileId));
                }}
              >
                <Trash2 size={18} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="grid-2" style={{ gap: 12 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="ex-type">Type</label>
          <select id="ex-type" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="unavailable">Time off (unavailable)</option>
            <option value="additionally_available">Extra one-off availability</option>
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="ex-note">Private note (optional)</label>
          <input id="ex-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="ex-start">From</label>
          <input id="ex-start" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="ex-end">Until</label>
          <input id="ex-end" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>
      <button className="btn btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} onClick={add} disabled={busy}>
        <Plus size={16} aria-hidden="true" /> Add
      </button>
    </div>
  );
}

/* ================= Offers ================= */

function FeeLine({ priceMinor, type, rates }: { priceMinor: number; type: 'trial' | 'single'; rates: { trialPct: number; standardPct: number } }) {
  if (!Number.isFinite(priceMinor) || priceMinor < repo.OFFER_PRICE_MIN_MINOR) return null;
  const fee = repo.calculateFeePreview(priceMinor, type, rates);
  return (
    <p className="faint" style={{ margin: 0 }}>
      Estimated platform fee ({fee.ratePct}%): {repo.formatMinor(fee.feeMinor)} · you’d receive{' '}
      {repo.formatMinor(fee.companionMinor)}
    </p>
  );
}

function OffersEditor({
  profileId,
  offers,
  rates,
  methods,
  onChanged,
}: {
  profileId: string;
  offers: ConversationOfferRow[];
  rates: { trialPct: number; standardPct: number };
  methods: string[];
  onChanged: () => Promise<void>;
}) {
  const trial = offers.find((o) => o.offer_type === 'trial' && o.active);
  const singles = offers.filter((o) => o.offer_type === 'single');
  const [trialPrice, setTrialPrice] = useState(trial ? String(trial.price_minor / 100) : '5');
  const [newPrice, setNewPrice] = useState('10');
  const [newDuration, setNewDuration] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (trial) setTrialPrice(String(trial.price_minor / 100));
  }, [trial?.id, trial?.price_minor]);

  async function run(action: () => Promise<unknown>, success: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
      pushToast(success, 'ok');
    } catch (e) {
      setError(e instanceof RepoError ? e.message : 'We couldn’t save that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      {error && <div className="banner banner-danger" role="alert">{error}</div>}

      {/* Trial */}
      <div className="card card-tight">
        <h3>Trial conversation</h3>
        <p className="muted small">
          One 30-minute introduction. We recommend about £5 — the platform takes {rates.trialPct}% on trials.
        </p>
        <div className="row wrap" style={{ gap: 10 }}>
          <div className="field" style={{ marginBottom: 0, width: 140 }}>
            <label htmlFor="trial-price">Price (£)</label>
            <input id="trial-price" type="number" min={1} step={0.5} value={trialPrice} onChange={(e) => setTrialPrice(e.target.value)} />
          </div>
          <div style={{ alignSelf: 'flex-end' }}>
            {trial ? (
              <div className="row" style={{ gap: 8 }}>
                <button
                  className="btn btn-secondary btn-small"
                  disabled={busy}
                  onClick={() => run(() => repo.updateOffer(trial.id, { price_minor: repo.poundsToMinor(trialPrice) }), 'Trial price updated')}
                >
                  Update
                </button>
                <button
                  className="btn btn-danger btn-small"
                  disabled={busy}
                  onClick={() => run(() => repo.archiveOffer(trial.id), 'Trial offer turned off')}
                >
                  Turn off
                </button>
              </div>
            ) : (
              <button
                className="btn btn-secondary btn-small"
                disabled={busy}
                onClick={() =>
                  run(
                    () => repo.createOffer(profileId, 'trial', { durationMinutes: 30, priceMinor: repo.poundsToMinor(trialPrice), supportedMethods: ['in_app'] }),
                    'Trial offer created',
                  )
                }
              >
                Offer a trial
              </button>
            )}
          </div>
        </div>
        <FeeLine priceMinor={repo.poundsToMinor(trialPrice)} type="trial" rates={rates} />
      </div>

      {/* Singles */}
      <div className="card card-tight">
        <h3>Standard conversations</h3>
        <p className="muted small">The platform takes {rates.standardPct}% on standard conversations.</p>
        {singles.length > 0 && (
          <div className="stack-list mb-4">
            {singles.map((o) => (
              <div key={o.id} className="row between wrap">
                <span>
                  <span className="bold">{o.duration_minutes} minutes</span>{' '}
                  <span className="muted">· {repo.formatMinor(o.price_minor)}</span>{' '}
                  {!o.active && <span className="badge badge-neutral">Off</span>}
                </span>
                <button
                  className="btn btn-ghost btn-small"
                  disabled={busy}
                  onClick={() => run(() => repo.updateOffer(o.id, { active: !o.active }), o.active ? 'Offer turned off' : 'Offer turned on')}
                >
                  {o.active ? 'Turn off' : 'Turn on'}
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="row wrap" style={{ gap: 10 }}>
          <div className="field" style={{ marginBottom: 0, width: 150 }}>
            <label htmlFor="single-duration">Duration</label>
            <select id="single-duration" value={newDuration} onChange={(e) => setNewDuration(Number(e.target.value))}>
              {repo.OFFER_DURATIONS.map((d) => (
                <option key={d} value={d}>{d} minutes</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0, width: 140 }}>
            <label htmlFor="single-price">Price (£)</label>
            <input id="single-price" type="number" min={1} step={0.5} value={newPrice} onChange={(e) => setNewPrice(e.target.value)} />
          </div>
          <button
            className="btn btn-secondary btn-small"
            style={{ alignSelf: 'flex-end' }}
            disabled={busy}
            onClick={() =>
              run(
                () => repo.createOffer(profileId, 'single', { durationMinutes: newDuration, priceMinor: repo.poundsToMinor(newPrice), supportedMethods: ['in_app'] }),
                'Offer added',
              )
            }
          >
            <Plus size={16} aria-hidden="true" /> Add offer
          </button>
        </div>
        <FeeLine priceMinor={repo.poundsToMinor(newPrice)} type="single" rates={rates} />
      </div>
    </div>
  );
}
