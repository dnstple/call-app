/**
 * Block 2 — reusable Trust & Safety UI: a versioned-consent panel, a
 * report-a-concern dialog, and a block/unblock control. Each talks only to the
 * server RPCs in trustRepository; none holds authority logic. Copy is neutral
 * and pilot-appropriate.
 */
import { useCallback, useEffect, useState } from 'react';
import { Flag, Shield, ShieldOff } from 'lucide-react';
import {
  acknowledgeConsent, getMyConsentStatus, reportConcern, createBlock, removeBlock,
  getMyNotificationPreferences, setMyNotificationPreferences,
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try { setPrefs(await getMyNotificationPreferences()); }
      catch (e) { setError(e instanceof Error ? e.message : 'Could not load your preferences.'); }
    })();
  }, []);

  const update = async (patch: Partial<NotificationPreferences>) => {
    if (!prefs) return;
    const next = { ...prefs, ...patch };
    setPrefs(next); setBusy(true); setError(null);
    try { await setMyNotificationPreferences(next); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  };

  if (!prefs) return null;
  const row = (label: string, key: keyof NotificationPreferences, disabled = false) => (
    <div className="switch-row">
      <span>{label}</span>
      <span className="switch">
        <input type="checkbox" checked={prefs[key]} disabled={busy || disabled}
          aria-label={label}
          onChange={(e) => void update({ [key]: e.target.checked } as Partial<NotificationPreferences>)} />
        <span className="track" />
      </span>
    </div>
  );
  return (
    <section>
      <h2>Email notifications</h2>
      <p className="muted small mt-2">In-app notifications always stay on. Email is optional.</p>
      {error && <div className="banner banner-danger mt-2" role="alert">{error}</div>}
      <div className="settings-group mt-2" style={{ padding: '0 var(--space-5)' }}>
        {row('Email me notifications', 'email_enabled')}
        <div style={prefs.email_enabled ? undefined : { pointerEvents: 'none', opacity: 0.5 }}>
          {row('Messages', 'email_messages', !prefs.email_enabled)}
          {row('Bookings & reminders', 'email_bookings', !prefs.email_enabled)}
          {row('Billing & payments', 'email_billing', !prefs.email_enabled)}
          {row('Safety & support', 'email_safety', !prefs.email_enabled)}
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
