/**
 * Reach-out console (/internal/outreach) — support-admin only.
 *
 * One panel for all five outreach missions: prompt members to book, chase
 * incomplete members, get visible companions to verify their number, get
 * approved-but-hidden companions to finish their profile, and send companions
 * their personal invite link. Each card shows the live audience, lets you edit
 * the email/SMS/in-app copy, preview, and send — and keeps a run history with
 * how many messages were actually sent and delivered.
 */
import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, RefreshCw, Mail, MessageSquare, Bell, Pencil, Eye, Send, ChevronDown, ChevronRight } from 'lucide-react';
import {
  listTemplates, updateTemplate, audienceCounts, listRuns,
  previewCampaign, sendCampaign,
  type OutreachTemplate, type AudienceCounts, type OutreachRun,
} from '../repositories/outreachRepository';
import {
  resendConfirmations, nudgeIncompleteOnboarding,
  syncMarketingAudience, sendMarketingTest, sendMarketingCampaign,
  getOnboardingNudgeConfig, setOnboardingNudgeConfig, type OnboardingNudgeConfig,
} from '../repositories/emailRepository';

// Display order = the five missions.
const ORDER = [
  'member_first_call',
  'member_incomplete',
  'companion_verify_phone',
  'companion_incomplete_profile',
  'companion_invite_link',
];

function when(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

export default function InternalOutreach() {
  const [templates, setTemplates] = useState<OutreachTemplate[]>([]);
  const [counts, setCounts] = useState<AudienceCounts>({});
  const [runsByCampaign, setRunsByCampaign] = useState<Record<string, OutreachRun[]>>({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<OutreachTemplate | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([listTemplates(), audienceCounts(), listRuns(undefined, 60)])
      .then(([t, c, r]) => {
        setTemplates(t);
        setCounts(c);
        const grouped: Record<string, OutreachRun[]> = {};
        for (const run of r) (grouped[run.campaign_key] ??= []).push(run);
        setRunsByCampaign(grouped);
      })
      .catch(() => { /* keep prior */ })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const ordered = ORDER
    .map((k) => templates.find((t) => t.campaign_key === k))
    .filter((t): t is OutreachTemplate => Boolean(t));

  return (
    <div className="col" style={{ gap: 18 }}>
      <header className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span className="section-label">Support</span>
          <h1 style={{ margin: 0 }}>Reach out</h1>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <Link className="btn btn-ghost btn-small" to="/internal/access">Pilot access</Link>
          <Link className="btn btn-ghost btn-small" to="/internal/bookings">Bookings</Link>
          <button className="btn btn-ghost btn-small" onClick={load}><RefreshCw size={16} aria-hidden="true" /> Refresh</button>
        </div>
      </header>

      <p className="muted small" style={{ margin: 0, maxWidth: 720 }}>
        Each card sends email + text + in-app to everyone currently in that audience (people who opted out are always excluded).
        Sending is one click — edit the wording, preview the audience, then send. Every send is recorded below with how many actually went out and were delivered.
      </p>

      {loading && templates.length === 0 ? (
        <div className="row" style={{ justifyContent: 'center', padding: 24 }}>
          <Loader2 size={20} className="spin" aria-hidden="true" /><span className="visually-hidden">Loading</span>
        </div>
      ) : (
        <div className="col" style={{ gap: 14 }}>
          {ordered.map((t) => (
            <CampaignCard
              key={t.campaign_key}
              template={t}
              count={counts[t.campaign_key]}
              runs={runsByCampaign[t.campaign_key] ?? []}
              onEdit={() => setEditing(t)}
              onSent={load}
            />
          ))}
        </div>
      )}

      {!loading && <OtherTools />}

      {editing && (
        <CopyEditor
          template={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Utilities that sit outside the five mission campaigns but belong in one place:
// reaching people with no account yet, the general marketing broadcast, and the
// automated account-setup reminder cadence.
function OtherTools() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [subject, setSubject] = useState('Know someone who’d love Apricoti?');
  const [cfg, setCfg] = useState<OnboardingNudgeConfig | null>(null);

  useEffect(() => { getOnboardingNudgeConfig().then(setCfg).catch(() => {}); }, []);

  const run = async (fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true); setMsg(null);
    try { setMsg((await fn()).message); } catch { setMsg('That action failed.'); } finally { setBusy(false); }
  };
  const confirmSend = (prompt: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    const typed = window.prompt(prompt + '\nType SEND to confirm:', '');
    if (typed !== 'SEND') { setMsg('Cancelled — you must type SEND exactly.'); return; }
    return run(fn);
  };
  const saveCfg = async (patch: Partial<OnboardingNudgeConfig>) => {
    setBusy(true); setMsg(null);
    try { const next = await setOnboardingNudgeConfig(patch); if (next) { setCfg(next); setMsg('Saved.'); } }
    finally { setBusy(false); }
  };

  return (
    <section className="card col" style={{ gap: 12 }}>
      <h2 className="section-label" style={{ margin: 0 }}>Other tools</h2>

      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <button className="btn btn-secondary btn-small" disabled={busy}
          onClick={() => run(() => resendConfirmations())}>
          Resend email confirmations
        </button>
        <span className="muted small">People who signed up but never confirmed their email (no account yet, so they aren’t in the campaigns above). Sends a magic link. Runs daily; this triggers a run now.</span>
      </div>

      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <button className="btn btn-secondary btn-small" disabled={busy}
          onClick={() => run(() => nudgeIncompleteOnboarding())}>
          Run account-setup reminder now
        </button>
        <span className="muted small">The automated daily “finish signing up” email. Only emails people who are due (see cadence below).</span>
      </div>

      {cfg && (
        <div className="row wrap" style={{ gap: 12, alignItems: 'center' }}>
          <strong style={{ fontSize: 13 }}>Reminder cadence</strong>
          <label className="row" style={{ gap: 6, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={cfg.enabled} disabled={busy} onChange={(e) => saveCfg({ enabled: e.target.checked })} />
            {cfg.enabled ? 'On' : 'Paused'}
          </label>
          <label className="row" style={{ gap: 6, alignItems: 'center', fontSize: 13 }}>
            Every
            <input className="input" type="number" min={1} max={90} defaultValue={cfg.cadence_days} disabled={busy} style={{ width: 64 }}
              onBlur={(e) => { const n = parseInt(e.target.value, 10); if (Number.isFinite(n) && n !== cfg.cadence_days) saveCfg({ cadence_days: n }); }} />
            days
          </label>
          <label className="row" style={{ gap: 6, alignItems: 'center', fontSize: 13 }}>
            Max
            <input className="input" type="number" min={0} max={52} defaultValue={cfg.max_reminders} disabled={busy} style={{ width: 64 }}
              onBlur={(e) => { const n = parseInt(e.target.value, 10); if (Number.isFinite(n) && n !== cfg.max_reminders) saveCfg({ max_reminders: n }); }} />
            reminders (0 = no limit)
          </label>
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--border, #FBE9DE)', paddingTop: 10 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: '0.95rem' }}>Marketing broadcast (Resend audience)</h3>
        <label className="col" style={{ gap: 4, fontSize: 13, marginBottom: 8 }}>
          Subject line
          <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} style={{ maxWidth: 420 }} />
        </label>
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => run(() => syncMarketingAudience())}>Sync audience</button>
          <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => run(() => sendMarketingTest(subject))}>Send test to me</button>
          <button className="btn btn-primary btn-small" disabled={busy} onClick={() => confirmSend('Send the marketing campaign to EVERYONE in the audience.', () => sendMarketingCampaign(subject))}>Send to everyone…</button>
        </div>
      </div>

      {msg && <p role="status" className="small" style={{ margin: 0, color: 'var(--muted,#6b625c)' }}>{msg}</p>}
    </section>
  );
}

// --------------------------------------------------------------------------
function CampaignCard({ template, count, runs, onEdit, onSent }: {
  template: OutreachTemplate;
  count: { total: number; with_email: number; with_sms: number } | undefined;
  runs: OutreachRun[];
  onEdit: () => void;
  onSent: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showRuns, setShowRuns] = useState(false);

  const preview = async () => {
    setBusy(true); setMsg(null);
    try { setMsg((await previewCampaign(template.campaign_key)).message); }
    finally { setBusy(false); }
  };
  const send = async () => {
    const total = count?.total ?? 0;
    if (!window.confirm(`Send “${template.title}” to ${total} ${total === 1 ? 'person' : 'people'} now (email, text and in-app)?`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await sendCampaign(template.campaign_key);
      setMsg(r.message);
      onSent();
    } finally { setBusy(false); }
  };

  const last = runs[0];

  return (
    <section className="card col" style={{ gap: 10 }}>
      <div className="row between" style={{ alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 260, flex: 1 }}>
          <h2 style={{ margin: '0 0 2px', fontSize: '1.05rem' }}>{template.title}</h2>
          <p className="muted small" style={{ margin: 0 }}>{template.description}</p>
        </div>
        <div className="row" style={{ gap: 14, alignItems: 'center' }}>
          <span title="Total audience" style={{ fontWeight: 700, fontSize: '1.35rem' }}>{count?.total ?? '—'}</span>
          <span className="muted small row" style={{ gap: 4, alignItems: 'center' }}><Mail size={13} aria-hidden="true" /> {count?.with_email ?? 0}</span>
          <span className="muted small row" style={{ gap: 4, alignItems: 'center' }}><MessageSquare size={13} aria-hidden="true" /> {count?.with_sms ?? 0}</span>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn btn-ghost btn-small" disabled={busy} onClick={onEdit}><Pencil size={14} aria-hidden="true" /> Edit copy</button>
        <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => void preview()}><Eye size={14} aria-hidden="true" /> Preview audience</button>
        <button className="btn btn-primary btn-small" disabled={busy} onClick={() => void send()}>
          {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />} Send now
        </button>
        <span className="muted small row" style={{ gap: 4, alignItems: 'center' }}><Bell size={12} aria-hidden="true" /> email · text · in-app</span>
      </div>

      {msg && <p role="status" className="small" style={{ margin: 0, color: 'var(--muted,#6b625c)' }}>{msg}</p>}

      {last && (
        <div className="muted small" style={{ marginTop: 2 }}>
          Last sent {when(last.created_at)} — {last.emails_sent} email ({last.emails_delivered} delivered, {last.emails_bounced} bounced),
          {' '}{last.texts_sent} text ({last.texts_delivered} delivered), {last.in_app_count} in-app.
        </div>
      )}

      {runs.length > 0 && (
        <div>
          <button className="btn btn-ghost btn-small" onClick={() => setShowRuns((s) => !s)}>
            {showRuns ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />} Run history ({runs.length})
          </button>
          {showRuns && (
            <div style={{ overflowX: 'auto', marginTop: 6 }}>
              <table className="access-table" style={{ fontSize: '0.82rem' }}>
                <thead>
                  <tr>
                    <th>When</th><th style={{ textAlign: 'right' }}>Audience</th>
                    <th style={{ textAlign: 'right' }}>Email sent</th><th style={{ textAlign: 'right' }}>Delivered</th><th style={{ textAlign: 'right' }}>Bounced</th>
                    <th style={{ textAlign: 'right' }}>Text sent</th><th style={{ textAlign: 'right' }}>Delivered</th>
                    <th style={{ textAlign: 'right' }}>In-app</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{when(r.created_at)}{r.mode === 'preview' ? ' (preview)' : ''}</td>
                      <td style={{ textAlign: 'right' }}>{r.audience_size}</td>
                      <td style={{ textAlign: 'right' }}>{r.emails_sent}{r.emails_failed ? ` (+${r.emails_failed} failed)` : ''}</td>
                      <td style={{ textAlign: 'right' }}>{r.emails_delivered}</td>
                      <td style={{ textAlign: 'right' }}>{r.emails_bounced}</td>
                      <td style={{ textAlign: 'right' }}>{r.texts_sent}{r.texts_failed ? ` (+${r.texts_failed} failed)` : ''}</td>
                      <td style={{ textAlign: 'right' }}>{r.texts_delivered}</td>
                      <td style={{ textAlign: 'right' }}>{r.in_app_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// --------------------------------------------------------------------------
function CopyEditor({ template, onClose, onSaved }: {
  template: OutreachTemplate; onClose: () => void; onSaved: () => void;
}) {
  const [draft, setDraft] = useState<OutreachTemplate>(template);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const field = (k: keyof OutreachTemplate) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));

  const save = async () => {
    setBusy(true); setErr(null);
    const r = await updateTemplate(draft);
    setBusy(false);
    if (r.ok) onSaved(); else setErr('Could not save — please try again.');
  };

  return (
    <div className="access-drawer-backdrop" onClick={onClose}>
      <aside className="access-drawer" onClick={(e) => e.stopPropagation()} aria-label="Edit outreach copy">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>{template.title}</h2>
          <button className="btn btn-ghost btn-small" onClick={onClose}>Close</button>
        </div>
        <p className="muted small" style={{ marginTop: 4 }}>
          Placeholders: <code>{'{{first_name}}'}</code>, <code>{'{{link}}'}</code>, <code>{'{{unsubscribe}}'}</code>.
        </p>
        {err && <p className="access-inline-error">{err}</p>}

        <label className="col" style={{ gap: 4, fontSize: 13, marginTop: 8 }}>
          Email subject
          <input className="input" value={draft.subject} onChange={field('subject')} />
        </label>
        <label className="col" style={{ gap: 4, fontSize: 13, marginTop: 10 }}>
          Email — HTML body
          <textarea className="input" rows={7} value={draft.email_html} onChange={field('email_html')} style={{ fontFamily: 'monospace', fontSize: 12 }} />
        </label>
        <label className="col" style={{ gap: 4, fontSize: 13, marginTop: 10 }}>
          Email — plain-text body
          <textarea className="input" rows={5} value={draft.email_text} onChange={field('email_text')} />
        </label>
        <label className="col" style={{ gap: 4, fontSize: 13, marginTop: 10 }}>
          Text message (SMS)
          <textarea className="input" rows={3} value={draft.sms_body} onChange={field('sms_body')} />
        </label>
        <label className="col" style={{ gap: 4, fontSize: 13, marginTop: 10 }}>
          In-app title
          <input className="input" value={draft.in_app_title} onChange={field('in_app_title')} />
        </label>
        <label className="col" style={{ gap: 4, fontSize: 13, marginTop: 10 }}>
          In-app message
          <textarea className="input" rows={3} value={draft.in_app_body} onChange={field('in_app_body')} />
        </label>

        <div className="row" style={{ gap: 8, marginTop: 14 }}>
          <button className="btn btn-primary btn-small" disabled={busy} onClick={() => void save()}>
            {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : null} Save copy
          </button>
          <button className="btn btn-ghost btn-small" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </aside>
    </div>
  );
}
