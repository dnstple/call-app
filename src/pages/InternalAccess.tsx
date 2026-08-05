/**
 * Private pilot access console (/internal/access) — support-admin only.
 *
 * Guarded by <SupportOnly> in the router AND re-checked server-side inside every
 * RPC (app_private.is_support_admin). The browser holds no authority: it renders
 * what the admin_* RPCs return and sends explicit, audited actions. Adverse
 * actions collect a required reason and confirm before sending. There is NO
 * user deletion and NO impersonation.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import {
  adminDashboard, adminListAccounts, adminAccountDetail, adminListCohorts,
  adminActions, cohortActions,
  type AdminListResult, type AdminListRow,
} from '../repositories/accessRepository';

const STATUS = ['incomplete', 'ready_for_review', 'under_review', 'approved', 'rejected', 'suspended'];
const ACCESS = ['waitlist', 'pilot', 'full', 'blocked'];
const ROLES = ['companion', 'member', 'coordinator'];
const FEATURES = ['explore', 'favourites', 'message_requests', 'messaging', 'conversations', 'booking', 'calls', 'payments', 'payouts', 'reviews'];

function pretty(s: string | null | undefined): string {
  if (!s) return '—';
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function reasonPrompt(action: string): string | null {
  const r = window.prompt(`Reason for “${action}” (required):`, '');
  if (r === null) return null;
  if (r.trim() === '') { window.alert('A reason is required.'); return null; }
  return r.trim();
}
function errText(e: unknown): string {
  const m = String((e as { message?: string })?.message ?? '');
  if (/unauthor/i.test(m)) return 'You’re not authorised for that action.';
  if (/reason_required/i.test(m)) return 'A reason is required.';
  if (/cohort_full/i.test(m)) return 'That cohort is at capacity.';
  if (/cohort_closed/i.test(m)) return 'That cohort is not accepting assignments.';
  if (/cannot_delete_self/i.test(m)) return 'You can’t delete your own account.';
  if (/cannot_delete_admin/i.test(m)) return 'Remove support-admin status before deleting this account.';
  return 'That action could not be completed.';
}

export default function InternalAccess() {
  const [dash, setDash] = useState<Record<string, unknown> | null>(null);
  const [cohorts, setCohorts] = useState<Array<Record<string, unknown>>>([]);
  const [list, setList] = useState<AdminListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [filters, setFilters] = useState({ search: '', role: '', status: '', access: '', cohort: '', sort: 'registered' as 'registered' | 'last_active', dir: 'desc' as 'asc' | 'desc', offset: 0 });
  const LIMIT = 25;

  const loadTop = useCallback(() => {
    adminDashboard().then(setDash).catch(() => {});
    adminListCohorts().then(setCohorts).catch(() => {});
  }, []);
  const loadList = useCallback(() => {
    setLoading(true);
    adminListAccounts({ ...filters, limit: LIMIT })
      .then(setList).catch(() => setList(null)).finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => { loadTop(); }, [loadTop]);
  useEffect(() => { loadList(); }, [loadList]);

  const refresh = () => { loadTop(); loadList(); };

  const dashCount = (group: string, key: string): number => {
    const g = (dash?.[group] as Record<string, number>) ?? {};
    return Number(g[key] ?? 0);
  };

  return (
    <div className="col" style={{ gap: 18 }}>
      <header className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span className="section-label">Support</span>
          <h1 style={{ margin: 0 }}>Pilot access</h1>
        </div>
        <button className="btn btn-ghost btn-small" onClick={refresh}><RefreshCw size={16} aria-hidden="true" /> Refresh</button>
      </header>

      {/* Dashboard */}
      <section className="access-dash-grid">
        <div className="card access-dash-tile"><span className="access-dash-num">{Number(dash?.total ?? 0)}</span><span>Total registrations</span></div>
        <div className="card access-dash-tile"><span className="access-dash-num">{dashCount('by_application_status', 'ready_for_review') + dashCount('by_application_status', 'under_review')}</span><span>Awaiting review</span></div>
        <div className="card access-dash-tile"><span className="access-dash-num">{dashCount('by_access_level', 'pilot')}</span><span>Pilot access</span></div>
        <div className="card access-dash-tile"><span className="access-dash-num">{dashCount('by_access_level', 'full')}</span><span>Full access</span></div>
        <div className="card access-dash-tile"><span className="access-dash-num">{dashCount('by_access_level', 'waitlist')}</span><span>Waitlist</span></div>
        <div className="card access-dash-tile"><span className="access-dash-num">{dashCount('by_access_level', 'blocked') + dashCount('by_application_status', 'suspended')}</span><span>Blocked / suspended</span></div>
      </section>

      {/* Filters */}
      <section className="card access-filters">
        <input className="input" placeholder="Search name or email" value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, offset: 0 }))} />
        <select className="input" value={filters.role} onChange={(e) => setFilters((f) => ({ ...f, role: e.target.value, offset: 0 }))}>
          <option value="">All roles</option>{ROLES.map((r) => <option key={r} value={r}>{pretty(r)}</option>)}
        </select>
        <select className="input" value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, offset: 0 }))}>
          <option value="">All statuses</option>{STATUS.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}
        </select>
        <select className="input" value={filters.access} onChange={(e) => setFilters((f) => ({ ...f, access: e.target.value, offset: 0 }))}>
          <option value="">All access</option>{ACCESS.map((a) => <option key={a} value={a}>{pretty(a)}</option>)}
        </select>
        <select className="input" value={filters.cohort} onChange={(e) => setFilters((f) => ({ ...f, cohort: e.target.value, offset: 0 }))}>
          <option value="">All cohorts</option>{cohorts.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.name)}</option>)}
        </select>
        <select className="input" value={`${filters.sort}:${filters.dir}`} onChange={(e) => { const [sort, dir] = e.target.value.split(':'); setFilters((f) => ({ ...f, sort: sort as 'registered' | 'last_active', dir: dir as 'asc' | 'desc', offset: 0 })); }}>
          <option value="registered:desc">Newest first</option>
          <option value="registered:asc">Oldest first</option>
          <option value="last_active:desc">Recently active</option>
        </select>
      </section>

      {/* User list */}
      <section className="card" style={{ overflowX: 'auto' }}>
        {loading ? (
          <div className="row" style={{ justifyContent: 'center', padding: 24 }}><Loader2 size={20} aria-hidden="true" /><span className="visually-hidden">Loading</span></div>
        ) : list && list.rows.length > 0 ? (
          <>
            <table className="access-table">
              <thead><tr><th>Name</th><th>Role</th><th>Application</th><th>Access</th><th>Cohort</th><th>Registered</th><th></th></tr></thead>
              <tbody>
                {list.rows.map((r: AdminListRow) => (
                  <tr key={r.account_id}>
                    <td>{`${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email || '—'}<br /><span className="text-secondary" style={{ fontSize: '0.8rem' }}>{r.email}</span></td>
                    <td>{pretty(r.role)}</td>
                    <td><span className={`access-badge s-${r.application_status}`}>{pretty(r.application_status)}</span></td>
                    <td><span className={`access-badge a-${r.access_level}`}>{pretty(r.access_level)}</span></td>
                    <td>{r.cohort_name ?? '—'}</td>
                    <td>{new Date(r.registered).toLocaleDateString()}</td>
                    <td><button className="btn btn-ghost btn-small" onClick={() => setSelected(r.account_id)}>Manage</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 10, alignItems: 'center' }}>
              <span className="text-secondary">{list.total} total</span>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-ghost btn-small" disabled={filters.offset === 0} onClick={() => setFilters((f) => ({ ...f, offset: Math.max(0, f.offset - LIMIT) }))}>Previous</button>
                <button className="btn btn-ghost btn-small" disabled={filters.offset + LIMIT >= list.total} onClick={() => setFilters((f) => ({ ...f, offset: f.offset + LIMIT }))}>Next</button>
              </div>
            </div>
          </>
        ) : (
          <p className="text-secondary" style={{ padding: 12 }}>No accounts match those filters.</p>
        )}
      </section>

      <CohortPanel cohorts={cohorts} onChange={refresh} />

      {selected && (
        <DetailDrawer accountId={selected} cohorts={cohorts} onClose={() => setSelected(null)} onChanged={refresh} />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
function DetailDrawer({ accountId, cohorts, onClose, onChanged }: {
  accountId: string; cohorts: Array<Record<string, unknown>>; onClose: () => void; onChanged: () => void;
}) {
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    adminAccountDetail(accountId).then(setDetail).catch(() => setErr('Could not load this account.'));
  }, [accountId]);
  useEffect(() => { load(); }, [load]);

  async function run(label: string, fn: () => Promise<unknown>, confirmMsg?: string) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true); setErr(null);
    try { await fn(); load(); onChanged(); }
    catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  }
  const withReason = (label: string, fn: (reason: string) => Promise<unknown>) => {
    const r = reasonPrompt(label); if (r === null) return;
    void run(label, () => fn(r));
  };

  // Permanent deletion: extra confirmation, reason, then close the drawer (the
  // account no longer exists, so we don't reload it — just refresh the list).
  async function deleteUser() {
    const name = `${profile.first_name ?? ''} ${profile.last_name ?? ''}`.trim() || 'this user';
    if (!window.confirm(`Permanently delete ${name}? This cannot be undone and removes their account, profile and access.`)) return;
    const reason = reasonPrompt('delete user'); if (reason === null) return;
    setBusy(true); setErr(null);
    try {
      await adminActions.deleteUser(accountId, reason);
      onChanged();
      onClose();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  }

  const d = detail ?? {};
  const profile = (d.profile as Record<string, unknown>) ?? {};
  const draftName = `${profile.first_name ?? ''} ${profile.last_name ?? ''}`.trim();
  const draftInterests = Array.isArray(profile.interests) ? (profile.interests as string[]) : [];
  const draftLanguages = Array.isArray(profile.languages) ? (profile.languages as string[]) : [];
  const draftPlaces = Array.isArray(profile.connected_places) ? (profile.connected_places as string[]) : [];
  const draftFluency = (profile.language_fluency as Record<string, string>) ?? {};
  const hasDraft =
    !!(draftName || profile.headline || profile.bio || profile.photo_url) ||
    draftInterests.length > 0 || draftLanguages.length > 0 || draftPlaces.length > 0;
  const checklist = d.checklist as { completion_pct?: number; items?: Array<Record<string, unknown>> } | null;
  const audit = (d.audit as Array<Record<string, unknown>>) ?? [];
  const notes = (d.notes as Array<Record<string, unknown>>) ?? [];
  const notifs = (d.notifications as Array<Record<string, unknown>>) ?? [];
  const overrides = (d.overrides as Array<Record<string, unknown>>) ?? [];

  return (
    <div className="access-drawer-backdrop" onClick={onClose}>
      <aside className="access-drawer" onClick={(e) => e.stopPropagation()} aria-label="Account detail">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>{`${profile.first_name ?? ''} ${profile.last_name ?? ''}`.trim() || 'Account'}</h2>
          <button className="btn btn-ghost btn-small" onClick={onClose}>Close</button>
        </div>
        {err && <p className="access-inline-error">{err}</p>}

        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          <span className={`access-badge s-${d.application_status}`}>{pretty(d.application_status as string)}</span>
          <span className={`access-badge a-${d.access_level}`}>{pretty(d.access_level as string)}</span>
          <span className="access-badge">{pretty(d.role as string)}</span>
          <span className="access-badge">{d.email_confirmed ? 'Email confirmed' : 'Email unconfirmed'}</span>
          {checklist && <span className="access-badge">{checklist.completion_pct ?? 0}% complete</span>}
        </div>

        <section className="access-drawer-sec">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Account draft</h3>
            <a className="btn btn-ghost btn-small" href={`#/internal/access/preview/${accountId}`} target="_blank" rel="noopener noreferrer">
              Preview full profile ↗
            </a>
          </div>
          <p className="text-secondary" style={{ fontSize: '0.85rem', margin: '2px 0 12px' }}>
            What this person entered — how their account will appear once approved.
          </p>

          {hasDraft ? (
            <>
              <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                {profile.photo_url ? (
                  <img src={String(profile.photo_url)} alt="" style={{ width: 64, height: 64, borderRadius: 12, objectFit: 'cover', flex: 'none' }} />
                ) : (
                  <div className="text-secondary" style={{ width: 64, height: 64, borderRadius: 12, background: 'var(--surface-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontSize: '0.75rem', textAlign: 'center' }}>No photo</div>
                )}
                <div className="col" style={{ gap: 2 }}>
                  <strong>{draftName || '—'}</strong>
                  {profile.preferred_name ? <span className="text-secondary">Prefers “{String(profile.preferred_name)}”</span> : null}
                  {profile.headline ? <span>{String(profile.headline)}</span> : null}
                </div>
              </div>

              {profile.bio ? <p style={{ margin: '10px 0 0' }}>{String(profile.bio)}</p> : null}

              <div className="col" style={{ gap: 0, marginTop: 10 }}>
                {draftInterests.length > 0 && <DraftRow label="Interests" value={draftInterests.join(', ')} />}
                {draftLanguages.length > 0 && (
                  <DraftRow label="Languages" value={draftLanguages.map((l) => (draftFluency[l] ? `${l} (${draftFluency[l]})` : l)).join(', ')} />
                )}
                {profile.age_band ? <DraftRow label="Age band" value={String(profile.age_band)} /> : null}
                {profile.region ? <DraftRow label="Town or city" value={String(profile.region)} /> : null}
                {profile.country_of_residence ? <DraftRow label="Country of residence" value={String(profile.country_of_residence)} /> : null}
                {draftPlaces.length > 0 && <DraftRow label="Places & cultures" value={draftPlaces.join(', ')} />}
              </div>
            </>
          ) : (
            <p className="text-secondary" style={{ margin: 0 }}>This person hasn’t entered profile details yet.</p>
          )}
        </section>

        <section className="access-drawer-sec">
          <h3>Application</h3>
          <div className="access-actions">
            <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => run('under review', () => adminActions.markUnderReview(accountId))}>Mark under review</button>
            <button className="btn btn-primary btn-small" disabled={busy} onClick={() => run('approve', () => adminActions.approve(accountId), 'Approve this application? This records the decision but does not grant access.')}>Approve</button>
            <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => withReason('reject', (r) => adminActions.reject(accountId, r))}>Reject…</button>
            <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => run('return to incomplete', () => adminActions.returnToIncomplete(accountId))}>Return to incomplete</button>
          </div>
        </section>

        <section className="access-drawer-sec">
          <h3>Access level</h3>
          <div className="access-actions">
            <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => run('grant waitlist', () => adminActions.grantWaitlist(accountId))}>Waitlist</button>
            <button className="btn btn-primary btn-small" disabled={busy} onClick={() => run('grant pilot', () => adminActions.grantPilot(accountId, undefined), 'Grant pilot access to this account?')}>Grant pilot</button>
            <button className="btn btn-primary btn-small" disabled={busy} onClick={() => run('grant full', () => adminActions.grantFull(accountId), 'Grant FULL access to this account?')}>Grant full</button>
            <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => withReason('revoke access', (r) => adminActions.revoke(accountId, r))}>Revoke…</button>
            <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => withReason('block access', (r) => adminActions.block(accountId, r))}>Block…</button>
            <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => run('unblock', () => adminActions.unblock(accountId))}>Unblock</button>
            <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => withReason('suspend', (r) => adminActions.suspend(accountId, r))}>Suspend…</button>
            <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => run('restore', () => adminActions.restore(accountId))}>Restore</button>
          </div>
        </section>

        <section className="access-drawer-sec">
          <h3>Cohort</h3>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <select className="input" defaultValue="" disabled={busy}
              onChange={(e) => { if (e.target.value) run('assign cohort', () => adminActions.assignCohort(accountId, e.target.value)); }}>
              <option value="">Assign to cohort…</option>
              {cohorts.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.name)}</option>)}
            </select>
            <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => run('remove cohort', () => adminActions.removeCohort(accountId))}>Remove from cohort</button>
          </div>
        </section>

        <section className="access-drawer-sec">
          <h3>Feature overrides</h3>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <select className="input" id="ovf"><option value="">Feature…</option>{FEATURES.map((f) => <option key={f} value={f}>{pretty(f)}</option>)}</select>
            <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => { const f = (document.getElementById('ovf') as HTMLSelectElement)?.value; if (f) run('enable feature', () => adminActions.setOverride(accountId, f, true)); }}>Enable</button>
            <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => { const f = (document.getElementById('ovf') as HTMLSelectElement)?.value; if (f) run('disable feature', () => adminActions.setOverride(accountId, f, false)); }}>Disable</button>
          </div>
          {overrides.length > 0 && (
            <ul className="access-mini-list">{overrides.map((o) => (
              <li key={String(o.feature)}>{pretty(String(o.feature))}: {o.enabled ? 'on' : 'off'}
                <button className="btn btn-ghost btn-small" onClick={() => run('clear override', () => adminActions.clearOverride(accountId, String(o.feature)))}>clear</button></li>
            ))}</ul>
          )}
        </section>

        <section className="access-drawer-sec">
          <h3>Private notes</h3>
          <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => { const n = window.prompt('Add a private note (not visible to the account):', ''); if (n && n.trim()) run('add note', () => adminActions.addNote(accountId, n.trim())); }}>Add note</button>
          <ul className="access-mini-list">{notes.map((n) => (
            <li key={String(n.id)}><span className="text-secondary">{new Date(String(n.created_at)).toLocaleDateString()} · {String(n.author ?? 'support')}</span><br />{String(n.note)}</li>
          ))}</ul>
        </section>

        <section className="access-drawer-sec">
          <h3>Notifications</h3>
          <ul className="access-mini-list">{notifs.map((n) => (
            <li key={String(n.id)}>{pretty(String(n.type))} — <span className="text-secondary">{String(n.email_status ?? 'in-app')}</span>
              <button className="btn btn-ghost btn-small" onClick={() => run('resend', () => adminActions.resendNotification(accountId, String(n.type)))}>resend</button></li>
          ))}{notifs.length === 0 && <li className="text-secondary">No access notifications yet.</li>}</ul>
        </section>

        <section className="access-drawer-sec">
          <h3>Audit history</h3>
          <ul className="access-mini-list">{audit.slice(0, 20).map((a, i) => (
            <li key={i}><span className="text-secondary">{new Date(String(a.created_at)).toLocaleString()}</span> — {pretty(String(a.action))}{a.reason ? ` · ${String(a.reason)}` : ''}</li>
          ))}{audit.length === 0 && <li className="text-secondary">No history yet.</li>}</ul>
        </section>

        <section className="access-drawer-sec access-danger-zone">
          <h3>Danger zone</h3>
          <p className="text-secondary" style={{ fontSize: '0.9rem', margin: '0 0 10px' }}>
            Permanently deletes this account, its profile and access. This can’t be undone.
          </p>
          <button className="btn btn-small offer-delete" disabled={busy} onClick={() => void deleteUser()}>
            Delete user
          </button>
        </section>
      </aside>
    </div>
  );
}

// --------------------------------------------------------------------------
function DraftRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row between" style={{ gap: 16, alignItems: 'flex-start', padding: '3px 0' }}>
      <span className="text-secondary" style={{ flex: 'none' }}>{label}</span>
      <span style={{ textAlign: 'right' }}>{value}</span>
    </div>
  );
}

// --------------------------------------------------------------------------
function CohortPanel({ cohorts, onChange }: { cohorts: Array<Record<string, unknown>>; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function guard(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); onChange(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Cohorts</h2>
        <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => { const name = window.prompt('New cohort name:', ''); if (name && name.trim()) guard(() => cohortActions.create(name.trim())); }}>New cohort</button>
      </div>
      {err && <p className="access-inline-error">{err}</p>}
      {cohorts.length === 0 ? <p className="text-secondary" style={{ marginTop: 8 }}>No cohorts yet.</p> : (
        <ul className="access-mini-list" style={{ marginTop: 8 }}>
          {cohorts.map((c) => (
            <li key={String(c.id)}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span><strong>{String(c.name)}</strong> · {pretty(String(c.status))} · {String((c.occupancy as number) ?? 0)}{c.max_size ? `/${String(c.max_size)}` : ''} members</span>
                <select className="input" defaultValue={String(c.status)} disabled={busy}
                  onChange={(e) => guard(() => cohortActions.update(String(c.id), { status: e.target.value }))}>
                  {['draft', 'recruiting', 'active', 'completed', 'archived'].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}
                </select>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
