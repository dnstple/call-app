/**
 * Availability & rates editor (Supabase mode, Companions).
 * Recurring weekly windows, time off / one-off availability, scheduling
 * settings and conversation offers with fee previews. Prices are what people
 * pay when they book a conversation.
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
// Minimum-notice choices, stored as whole hours (backend-compatible):
// No minimum, 1h…12h, then 1/2/3 days and 1 week.
export const NOTICE_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 24, 48, 72, 168];
const HORIZON_OPTIONS = [14, 30, 60, 90];

/** Human label for a minimum-notice value expressed in hours. */
export function noticeLabel(hours: number): string {
  if (hours <= 0) return 'No minimum';
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  if (hours === 168) return '1 week';
  const days = hours / 24;
  return `${days} day${days === 1 ? '' : 's'}`;
}

export default function AvailabilityRates() {
  const auth = useAuth();
  const navigate = useNavigate();
  const supabase = isSupabaseMode();
  // Role/access is only authoritative once auth resolves to 'authenticated'
  // (the provider sets that state only after profiles have loaded). Until then
  // we must not judge access, or a mid-load render flashes a false rejection.
  const authoritative = !supabase || auth.status === 'authenticated';
  const active =
    auth.profiles.find((p) => p.profile.id === auth.activeProfileId) ??
    // activeProfileId can briefly lag a fresh sign-up or hard refresh; fall
    // back to an editable Companion profile the account already holds.
    auth.profiles.find((p) => p.profile.role === 'companion' && p.access.can_edit);
  const profileId = active?.profile.id ?? '';
  const allowed = supabase && active?.profile.role === 'companion' && !!active.access.can_edit;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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
    setLoading(true);
    setError(null);
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
  }, [allowed, profileId, reloadKey]);

  // Unsaved-change warning.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // Wait for the authoritative role before deciding anything. A signed-in
  // account whose profiles are still loading sees a neutral skeleton, never a
  // false "this isn't your page" rejection.
  if (supabase && !authoritative) {
    return (
      <div className="row" style={{ justifyContent: 'center', padding: 64 }}>
        <Loader2 size={26} aria-hidden="true" />
        <span className="muted">Loading your availability…</span>
      </div>
    );
  }

  if (!allowed) {
    return (
      <div className="empty-state">
        <h3>Availability &amp; rates</h3>
        <p>This page is for Companions. Switch to your Companion profile to set your availability and rates.</p>
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

      {error && (
        <div className="banner banner-danger mb-4" role="alert">
          <div className="row between wrap" style={{ gap: 12 }}>
            <span>{error}</span>
            <button className="btn btn-secondary btn-small" onClick={() => setReloadKey((k) => k + 1)}>Try again</button>
          </div>
        </div>
      )}

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
                <option key={n} value={n}>{noticeLabel(n)}</option>
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
          These are the prices people see and pay when they book a conversation with you. You can
          update them at any time.
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

/**
 * One standard-conversation offer, shown with its full economics (customer
 * price, platform fee, estimated earnings) and edited in place — duration and
 * price with Save / Cancel, saving state, and inline validation. Editing never
 * deletes the offer.
 */
export function SingleOfferRow({
  offer, rates, busy, editing, onStartEdit, onStopEdit, onSave, onToggle, durationTaken,
}: {
  offer: ConversationOfferRow;
  rates: { trialPct: number; standardPct: number };
  busy: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onStopEdit: () => void;
  onSave: (patch: { duration_minutes: number; price_minor: number }) => Promise<void>;
  onToggle: () => void;
  durationTaken: (duration: number, exceptId: string) => boolean;
}) {
  const [dur, setDur] = useState(offer.duration_minutes);
  const [price, setPrice] = useState(String(offer.price_minor / 100));
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) { setDur(offer.duration_minutes); setPrice(String(offer.price_minor / 100)); setErr(null); }
  }, [editing, offer.duration_minutes, offer.price_minor]);

  const fee = repo.calculateFeePreview(offer.price_minor, 'single', rates);

  if (editing) {
    const priceMinor = repo.poundsToMinor(price);
    async function save() {
      const problem = repo.validateOfferInput({ durationMinutes: dur, priceMinor });
      if (problem) { setErr(problem); return; }
      if (offer.active && durationTaken(dur, offer.id)) {
        setErr('You already offer an active conversation of this length. Turn that one off first, or pick another length.');
        return;
      }
      setSaving(true); setErr(null);
      try { await onSave({ duration_minutes: dur, price_minor: priceMinor }); }
      catch (e) { setErr(e instanceof RepoError ? e.message : 'We couldn’t save that.'); setSaving(false); return; }
      setSaving(false);
    }
    return (
      <div className="card card-tight col" style={{ gap: 10 }}>
        <div className="row wrap" style={{ gap: 10 }}>
          <div className="field" style={{ marginBottom: 0, width: 150 }}>
            <label htmlFor={`edit-dur-${offer.id}`}>Duration</label>
            <select id={`edit-dur-${offer.id}`} value={dur} onChange={(e) => setDur(Number(e.target.value))} disabled={saving}>
              {repo.OFFER_DURATIONS.map((d) => <option key={d} value={d}>{d} minutes</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0, width: 140 }}>
            <label htmlFor={`edit-price-${offer.id}`}>Price (£)</label>
            <input id={`edit-price-${offer.id}`} type="number" min={1} step={0.5} value={price} onChange={(e) => setPrice(e.target.value)} disabled={saving} />
          </div>
          <div className="row" style={{ gap: 8, alignSelf: 'flex-end' }}>
            <button className="btn btn-primary btn-small" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
            <button className="btn btn-ghost btn-small" disabled={saving} onClick={onStopEdit}>Cancel</button>
          </div>
        </div>
        <FeeLine priceMinor={priceMinor} type="single" rates={rates} />
        {err && <span className="faint" role="alert" style={{ color: 'var(--color-danger-text)' }}>{err}</span>}
      </div>
    );
  }

  return (
    <div className="card card-tight row between wrap" style={{ gap: 10 }}>
      <div className="col" style={{ gap: 2 }}>
        <span>
          <span className="bold">{offer.duration_minutes} minutes</span>{' '}
          <span className="muted">· {repo.formatMinor(offer.price_minor)} to the customer</span>{' '}
          {offer.active
            ? <span className="badge badge-success">Active</span>
            : <span className="badge badge-neutral">Inactive</span>}
        </span>
        <span className="faint small">
          Platform fee ({fee.ratePct}%): {repo.formatMinor(fee.feeMinor)} · you receive {repo.formatMinor(fee.companionMinor)}
        </span>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-secondary btn-small" disabled={busy} onClick={onStartEdit}>Edit</button>
        <button className="btn btn-ghost btn-small" disabled={busy} onClick={onToggle}>
          {offer.active ? 'Disable' : 'Enable'}
        </button>
      </div>
    </div>
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // At most one ACTIVE standard offer per duration.
  const activeDurationTaken = (duration: number, exceptId: string) =>
    singles.some((o) => o.active && o.duration_minutes === duration && o.id !== exceptId);

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
        <p className="muted small">The platform takes {rates.standardPct}% on standard conversations. You can offer one active conversation of each length.</p>
        {singles.length > 0 && (
          <div className="stack-list mb-4">
            {singles.map((o) => (
              <SingleOfferRow
                key={o.id}
                offer={o}
                rates={rates}
                busy={busy}
                editing={editingId === o.id}
                onStartEdit={() => { setEditingId(o.id); setError(null); setAddError(null); }}
                onStopEdit={() => setEditingId(null)}
                onSave={async (patch) => {
                  await run(() => repo.updateOffer(o.id, patch), 'Offer updated');
                  setEditingId(null);
                }}
                onToggle={() => {
                  if (!o.active && activeDurationTaken(o.duration_minutes, o.id)) {
                    setError('You already offer an active conversation of this length. Turn that one off first.');
                    return;
                  }
                  void run(() => repo.updateOffer(o.id, { active: !o.active }), o.active ? 'Offer disabled' : 'Offer enabled');
                }}
                durationTaken={activeDurationTaken}
              />
            ))}
          </div>
        )}

        {/* Add a new standard offer. De-emphasised while a row is being edited. */}
        <div className="row wrap" style={{ gap: 10, opacity: editingId ? 0.5 : 1 }}>
          <div className="field" style={{ marginBottom: 0, width: 150 }}>
            <label htmlFor="single-duration">Duration</label>
            <select id="single-duration" value={newDuration} onChange={(e) => setNewDuration(Number(e.target.value))} disabled={!!editingId}>
              {repo.OFFER_DURATIONS.map((d) => (
                <option key={d} value={d}>{d} minutes</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0, width: 140 }}>
            <label htmlFor="single-price">Price (£)</label>
            <input id="single-price" type="number" min={1} step={0.5} value={newPrice} onChange={(e) => setNewPrice(e.target.value)} disabled={!!editingId} />
          </div>
          <button
            className="btn btn-secondary btn-small"
            style={{ alignSelf: 'flex-end' }}
            disabled={busy || !!editingId}
            onClick={() => {
              const priceMinor = repo.poundsToMinor(newPrice);
              const problem = repo.validateOfferInput({ durationMinutes: newDuration, priceMinor });
              if (problem) { setAddError(problem); return; }
              if (activeDurationTaken(newDuration, '')) {
                setAddError('You already offer an active conversation of this length. Edit that one instead, or choose another length.');
                return;
              }
              setAddError(null);
              void run(
                () => repo.createOffer(profileId, 'single', { durationMinutes: newDuration, priceMinor, supportedMethods: ['in_app'] }),
                'Offer added',
              );
            }}
          >
            <Plus size={16} aria-hidden="true" /> Add offer
          </button>
        </div>
        {addError && <p className="faint" role="alert" style={{ color: 'var(--color-danger-text)', margin: '6px 0 0' }}>{addError}</p>}
        <FeeLine priceMinor={repo.poundsToMinor(newPrice)} type="single" rates={rates} />
      </div>
    </div>
  );
}
