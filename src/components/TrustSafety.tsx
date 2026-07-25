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
  type ConsentItem, type ConcernCategory,
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
      <h2 className="text-base font-semibold text-stone-800">Your agreements</h2>
      {error && <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</div>}
      <div className="mt-2 space-y-3">
        {items.map((it) => {
          const copy = CONSENT_COPY[it.consent_type];
          return (
            <div key={it.consent_type + it.profile_id} className="rounded-2xl border border-stone-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-stone-800">{copy?.title ?? it.consent_type}</h3>
                {it.satisfied
                  ? <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">Accepted</span>
                  : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Action needed</span>}
              </div>
              {copy && (
                <ul className="mt-2 list-disc pl-5 text-sm text-stone-600">
                  {copy.points.map((p) => <li key={p}>{p}</li>)}
                </ul>
              )}
              {!it.satisfied && it.authority && (
                <button className="btn btn-primary mt-3 text-sm" disabled={busy !== null} onClick={() => void ack(it)}>
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
      <button className="inline-flex items-center gap-1 text-sm text-stone-500 hover:text-red-600" onClick={() => setOpen(true)}>
        <Flag size={14} /> Report a concern
      </button>
    );
  }
  return (
    <div className="mt-2 rounded-2xl border border-stone-200 bg-white p-4">
      {done ? (
        <div>
          <p className="text-sm font-medium text-stone-800">Thank you — your report has been received.</p>
          <p className="mt-1 text-sm text-stone-500">Our support team will review it. If someone is in immediate danger, contact emergency services.</p>
          <button className="btn btn-ghost mt-3 text-sm" onClick={() => setOpen(false)}>Close</button>
        </div>
      ) : (
        <div>
          <h3 className="text-sm font-semibold text-stone-800">Report a concern</h3>
          <p className="mt-1 text-xs text-stone-500">This is not for emergencies. If someone is in immediate danger, contact emergency services.</p>
          <label className="mt-3 block text-sm font-medium text-stone-600" htmlFor="report-category">What’s happened?</label>
          <select id="report-category" value={category} onChange={(e) => setCategory(e.target.value as ConcernCategory)}
            className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-base">
            {REPORT_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <label className="mt-3 block text-sm font-medium text-stone-600" htmlFor="report-desc">Tell us more</label>
          <textarea id="report-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={4}
            className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-base" placeholder="Describe what happened" />
          {error && <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</div>}
          <div className="mt-3 flex gap-2">
            <button className="btn btn-primary text-sm" disabled={busy || description.trim().length === 0} onClick={() => void submit()}>
              {busy ? 'Sending…' : 'Send report'}
            </button>
            <button className="btn btn-ghost text-sm" onClick={() => setOpen(false)}>Cancel</button>
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
        <button className="inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-700" disabled={busy} onClick={() => void doUnblock()}>
          <ShieldOff size={14} /> Unblock
        </button>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
    );
  }
  if (confirming) {
    return (
      <div className="rounded-xl border border-stone-200 bg-white p-3">
        <p className="text-sm text-stone-700">Block this person? They won’t be able to book, message or call you, and won’t appear in your searches. Existing history is kept.</p>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
        <div className="mt-2 flex gap-2">
          <button className="btn btn-primary text-sm" disabled={busy} onClick={() => void doBlock()}>{busy ? 'Blocking…' : 'Block'}</button>
          <button className="btn btn-ghost text-sm" onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <button className="inline-flex items-center gap-1 text-sm text-stone-500 hover:text-red-600" onClick={() => setConfirming(true)}>
      <Shield size={14} /> Block
    </button>
  );
}

export function SafetyNotice() {
  return (
    <section className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
      <h2 className="text-base font-semibold text-stone-800">Your safety</h2>
      <ul className="mt-2 list-disc pl-5 text-sm text-stone-600">
        <li>This is a social-companionship service — not healthcare, counselling or emergency support.</li>
        <li>If someone is in immediate danger, contact your local emergency services.</li>
        <li>Never share passwords, bank details or financial credentials with anyone.</li>
        <li>Calls are not recorded by the platform.</li>
        <li>Please treat everyone respectfully. You can report a concern from any conversation or booking, and our support team will review safeguarding concerns.</li>
      </ul>
    </section>
  );
}
