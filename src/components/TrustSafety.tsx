/**
 * Block 2 — reusable Trust & Safety UI: a versioned-consent panel, a
 * report-a-concern dialog, and a block/unblock control. Each talks only to the
 * server RPCs in trustRepository; none holds authority logic. Copy is neutral
 * and pilot-appropriate.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Flag, Shield, ShieldOff } from 'lucide-react';
import {
  acknowledgeConsent, getMyConsentStatus, reportConcern, createBlock, removeBlock,
  getMyNotificationPreferences, setMyNotificationPreferences, setMyCommunicationPreferences,
  type ConsentItem, type ConcernCategory, type NotificationPreferences,
} from '../repositories/trustRepository';

const CONSENT_COPY: Record<string, { title: string; points: string[] }> = {
  member_pilot: {
    title: 'Using this service',
    points: [
      'This is a social-companionship service — not healthcare, counselling or emergency support.',
      'In an emergency, always contact your local emergency services.',
      'Calls are not recorded by the platform.',
      'Please treat companions respectfully.',
      'You can report a concern from any conversation or booking.',
    ],
  },
  coordinator_pilot: {
    title: 'Managing someone else',
    points: [
      'You have authority to arrange conversations for the person you manage.',
      'They understand or have agreed to this arrangement.',
      'Never share passwords, bank details or financial credentials.',
    ],
  },
  companion_pilot: {
    title: 'Companion conduct & safeguarding',
    points: [
      'Behave professionally and respectfully at all times.',
      'Do not give medical, legal or financial advice.',
      'Calls are not recorded; respect members’ privacy.',
      'Report any safeguarding concern promptly.',
    ],
  },
};

export function ConsentPanel() {
  const [items, setItems] = useState<ConsentItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setItems(await getMyConsentStatus()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load your agreements.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const ack = async (it: ConsentItem) => {
    setBusy(it.consent_type + it.profile_id); setError(null);
    try { await acknowledgeConsent(it.profile_id, it.consent_type); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save your agreement.'); }
    finally { setBusy(null); }
  };

  if (items.length === 0) return null;
  return (
    <section>
      <h2>Your agreements</h2>
      {error && <div className="banner banner-danger mt-2" role="alert">{error}</div>}
      <div className="stack-list mt-2">
        {items.map((it) => {
          const copy = CONSENT_COPY[it.consent_type];
          return (
            <div key={it.consent_type + it.profile_id} className="card card-tight">
              <div className="row between">
                <h3 style={{ margin: 0 }}>{copy?.title ?? it.consent_type}</h3>
                {it.satisfied
                  ? <span className="badge badge-success">Accepted</span>
                  : <span className="badge badge-pending">Action needed</span>}
              </div>
              {copy && (
                <ul className="muted small" style={{ margin: 'var(--space-3) 0 0', paddingLeft: '1.25rem' }}>
                  {copy.points.map((p) => <li key={p}>{p}</li>)}
                </ul>
              )}
              {!it.satisfied && it.authority && (
                <button className="btn btn-primary btn-small mt-4" disabled={busy !== null} onClick={() => void ack(it)}>
                  {busy === it.consent_type + it.profile_id ? 'Saving…' : 'I understand and accept'}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

const REPORT_CATEGORIES: { value: ConcernCategory; label: string }[] = [
  { value: 'inappropriate_conduct', label: 'Inappropriate conduct' },
  { value: 'safeguarding', label: 'Safeguarding concern' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'suspected_fraud', label: 'Suspected fraud' },
  { value: 'privacy', label: 'Privacy concern' },
  { value: 'technical_call_problem', label: 'Technical / call problem' },
  { value: 'other', label: 'Something else' },
];

export function ReportConcernButton({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<ConcernCategory>('inappropriate_conduct');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setError(null);
    try { await reportConcern(conversationId, category, description.trim()); setDone(true); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not send your report.'); }
    finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button className="btn btn-ghost btn-small btn-danger" onClick={() => setOpen(true)}>
        <Flag size={15} aria-hidden="true" /> Report a concern
      </button>
    );
  }
  return (
    <div className="card card-tight mt-2">
      {done ? (
        <div>
          <p className="bold" style={{ margin: 0 }}>Thank you — your report has been received.</p>
          <p className="muted small mt-2">Our support team will review it. If someone is in immediate danger, contact emergency services.</p>
          <button className="btn btn-secondary btn-small mt-4" onClick={() => setOpen(false)}>Close</button>
        </div>
      ) : (
        <div>
          <h3 style={{ margin: 0 }}>Report a concern</h3>
          <p className="muted small mt-2">This is not for emergencies. If someone is in immediate danger, contact emergency services.</p>
          <div className="field mt-4">
            <label htmlFor="report-category">What’s happened?</label>
            <select id="report-category" value={category} onChange={(e) => setCategory(e.target.value as ConcernCategory)}>
              {REPORT_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="report-desc">Tell us more</label>
            <textarea id="report-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={4}
              placeholder="Describe what happened" />
          </div>
          {error && <div className="banner banner-danger mb-4" role="alert">{error}</div>}
          <div className="row">
            <button className="btn btn-primary btn-small" disabled={busy || description.trim().length === 0} onClick={() => void submit()}>
              {busy ? 'Sending…' : 'Send report'}
            </button>
            <button className="btn btn-ghost btn-small" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function BlockControl({ memberProfileId, companionProfileId, initiallyBlocked = false }: {
  memberProfileId: string; companionProfileId: string; initiallyBlocked?: boolean;
}) {
  const [blocked, setBlocked] = useState(initiallyBlocked);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doBlock = async () => {
    setBusy(true); setError(null);
    try { await createBlock(memberProfileId, companionProfileId); setBlocked(true); setConfirming(false); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not block.'); }
    finally { setBusy(false); }
  };
  const doUnblock = async () => {
    setBusy(true); setError(null);
    try { await removeBlock(memberProfileId, companionProfileId); setBlocked(false); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not unblock.'); }
    finally { setBusy(false); }
  };

  if (blocked) {
    return (
      <div>
        <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => void doUnblock()}>
          <ShieldOff size={15} aria-hidden="true" /> Unblock
        </button>
        {error && <p className="small mt-2" style={{ color: 'var(--color-danger-text)' }}>{error}</p>}
      </div>
    );
  }
  if (confirming) {
    return (
      <div className="card card-tight">
        <p className="small" style={{ margin: 0 }}>Block this person? They won’t be able to book, message or call you, and won’t appear in your searches. Existing history is kept.</p>
        {error && <p className="small mt-2" style={{ color: 'var(--color-danger-text)' }}>{error}</p>}
        <div className="row mt-4">
          <button className="btn btn-primary btn-small" disabled={busy} onClick={() => void doBlock()}>{busy ? 'Blocking…' : 'Block'}</button>
          <button className="btn btn-ghost btn-small" onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <button className="btn btn-ghost btn-small btn-danger" onClick={() => setConfirming(true)}>
      <Shield size={15} aria-hidden="true" /> Block
    </button>
  );
}

export function NotificationPreferencesPanel() {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Remember the last change so an error can be retried without losing intent.
  const lastPatch = useRef<Partial<NotificationPreferences> | null>(null);
  const redo = useRef<null | (() => void)>(null);   // retry works for either setter
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async () => {
    setLoadError(null);
    try { setPrefs(await getMyNotificationPreferences()); }
    catch (e) { setLoadError(e instanceof Error ? e.message : 'Could not load your preferences.'); }
  };

  useEffect(() => { void load(); }, []);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  const onSaved = () => {
    setStatus('saved');
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setStatus('idle'), 2000);
  };
  const onErr = (e: unknown) => {
    setStatus('error');
    setError(e instanceof Error ? e.message : 'Could not save your change.');
  };

  const update = async (patch: Partial<NotificationPreferences>) => {
    if (!prefs) return;
    lastPatch.current = patch;
    redo.current = () => void update(patch);
    const next = { ...prefs, ...patch };
    setPrefs(next);
    setStatus('saving');
    setError(null);
    try { await setMyNotificationPreferences(next); onSaved(); } catch (e) { onErr(e); }
  };

  // Digest opt-in + quiet hours travel through their own RPC (0116), so the
  // 5-boolean email setter above is never disturbed.
  const updateComm = async (
    patch: Partial<Pick<NotificationPreferences, 'email_matches' | 'quiet_hours_start' | 'quiet_hours_end' | 'time_zone'>>,
  ) => {
    if (!prefs) return;
    redo.current = () => void updateComm(patch);
    const next = { ...prefs, ...patch };
    setPrefs(next);
    setStatus('saving');
    setError(null);
    try {
      await setMyCommunicationPreferences({
        email_matches: next.email_matches ?? true,
        quiet_hours_start: next.quiet_hours_start ?? null,
        quiet_hours_end: next.quiet_hours_end ?? null,
        time_zone: next.time_zone
          || (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : '')
          || 'Europe/London',
      });
      onSaved();
    } catch (e) { onErr(e); }
  };

  const retry = () => { redo.current?.(); };

  const busy = status === 'saving';

  if (loadError) {
    return (
      <section className="card">
        <h2 style={{ marginTop: 0 }}>Email notifications</h2>
        <div className="banner banner-danger mt-2" role="alert">{loadError}</div>
        <button className="btn btn-secondary btn-small mt-2" onClick={() => void load()}>Try again</button>
      </section>
    );
  }
  if (!prefs) return null;

  const row = (
    label: string,
    description: string,
    key: keyof NotificationPreferences,
    disabled = false,
  ) => (
    <label className="switch-row" style={{ alignItems: 'flex-start', gap: 'var(--space-4)' }}>
      <span className="col" style={{ gap: 2 }}>
        <span className="bold">{label}</span>
        <span className="faint small">{description}</span>
      </span>
      <span className="switch" style={{ flexShrink: 0, marginTop: 2 }}>
        <input
          type="checkbox"
          checked={Boolean(prefs[key])}
          disabled={busy || disabled}
          aria-label={label}
          onChange={(e) => void update({ [key]: e.target.checked } as Partial<NotificationPreferences>)}
        />
        <span className="track" />
      </span>
    </label>
  );

  return (
    <section className="card">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ marginTop: 0, marginBottom: 4 }}>Email notifications</h2>
          <p className="muted small" style={{ margin: 0 }}>
            In-app notifications always stay on. Choose what we also email you about.
          </p>
        </div>
        <span className="faint small" aria-live="polite" style={{ flexShrink: 0, minWidth: 60, textAlign: 'right' }}>
          {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : ''}
        </span>
      </div>

      {status === 'error' && (
        <div className="banner banner-danger mt-4" role="alert">
          <div className="row between wrap" style={{ gap: 'var(--space-3)' }}>
            <span>{error}</span>
            <button className="btn btn-secondary btn-small" onClick={retry}>Try again</button>
          </div>
        </div>
      )}

      <div className="stack-list mt-4">
        {row(
          'Email me notifications',
          'The master switch. Turn this off to pause all email — the categories below stay as you set them.',
          'email_enabled',
        )}
        <div
          aria-hidden={!prefs.email_enabled}
          style={prefs.email_enabled ? undefined : { opacity: 0.5 }}
        >
          <div className="stack-list">
            {row('Messages', 'New messages from the people you talk with.', 'email_messages', !prefs.email_enabled)}
            {row('Bookings & reminders', 'Requests, confirmations, changes and upcoming-conversation reminders.', 'email_bookings', !prefs.email_enabled)}
            {row('Billing & payments', 'Receipts, upcoming charges and payment issues.', 'email_billing', !prefs.email_enabled)}
            {row('Safety & support', 'Updates on concerns you raise and important account-safety notices.', 'email_safety', !prefs.email_enabled)}
            <label className="switch-row" style={{ alignItems: 'flex-start', gap: 'var(--space-4)' }}>
              <span className="col" style={{ gap: 2 }}>
                <span className="bold">Suggestions &amp; introductions</span>
                <span className="faint small">
                  An occasional digest — at most one a week — when new companions share your interests, or members
                  who follow you do. Never one email per suggestion.
                </span>
              </span>
              <span className="switch" style={{ flexShrink: 0, marginTop: 2 }}>
                <input
                  type="checkbox"
                  checked={prefs.email_matches !== false}
                  disabled={busy || !prefs.email_enabled}
                  aria-label="Suggestions and introductions digest"
                  onChange={(e) => void updateComm({ email_matches: e.target.checked })}
                />
                <span className="track" />
              </span>
            </label>
          </div>

          <div className="field mt-4">
            <label className="bold" htmlFor="quiet-start">Quiet hours</label>
            <p className="faint small" style={{ marginTop: 2 }}>
              We won’t send the suggestions digest during these hours, in your local time.
            </p>
            <div className="row" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
              <select
                id="quiet-start"
                aria-label="Quiet hours start"
                disabled={busy || !prefs.email_enabled}
                value={prefs.quiet_hours_start ?? ''}
                onChange={(e) => void updateComm({
                  quiet_hours_start: e.target.value === '' ? null : Number(e.target.value),
                  quiet_hours_end: e.target.value === '' ? null : (prefs.quiet_hours_end ?? 7),
                })}
              >
                <option value="">Off</option>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                ))}
              </select>
              <span className="faint small">to</span>
              <select
                aria-label="Quiet hours end"
                disabled={busy || !prefs.email_enabled || prefs.quiet_hours_start == null}
                value={prefs.quiet_hours_end ?? ''}
                onChange={(e) => void updateComm({ quiet_hours_end: e.target.value === '' ? null : Number(e.target.value) })}
              >
                <option value="">—</option>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function SafetyNotice() {
  return (
    <section className="card card-muted">
      <h2 style={{ marginTop: 0 }}>Your safety</h2>
      <ul className="muted small" style={{ margin: 0, paddingLeft: '1.25rem' }}>
        <li>This is a social-companionship service — not healthcare, counselling or emergency support.</li>
        <li>If someone is in immediate danger, contact your local emergency services.</li>
        <li>Never share passwords, bank details or financial credentials with anyone.</li>
        <li>Calls are not recorded by the platform.</li>
        <li>Please treat everyone respectfully. You can report a concern from any conversation or booking, and our support team will review safeguarding concerns.</li>
      </ul>
    </section>
  );
}
