/**
 * Manual backup manager (support-admin). Lets an admin, for a chosen upcoming
 * credit call, hand-pick companions to invite as backups (they get an SMS + a
 * /cover link to accept or decline), watch who has accepted, and transfer the
 * call to an accepted companion. A stepping stone before the automatic engine.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Check, X, Phone, UserPlus } from 'lucide-react';
import {
  getUpcomingCreditCalls, getCandidateCompanions, offerBackup, getFailoverOverview,
  assignCompanion, keepPrimary, messageMember,
  type UpcomingCreditCall, type CandidateCompanion,
} from '../repositories/failoverRepository';

function when(iso: string): string {
  try { return new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

interface OfferRow {
  id: string; status: string; batch: string;
  companion_profile: string;
  companion?: { first_name?: string; last_name?: string };
  twilio_status?: string;
}

export function ManualBackupManager() {
  const [calls, setCalls] = useState<UpcomingCreditCall[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [overview, setOverview] = useState<Record<string, unknown> | null>(null);
  const [candidates, setCandidates] = useState<CandidateCompanion[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [memberMsg, setMemberMsg] = useState('');

  const loadCalls = useCallback(() => { getUpcomingCreditCalls().then(setCalls).catch(() => setCalls([])); }, []);
  useEffect(() => { loadCalls(); }, [loadCalls]);

  const loadCall = useCallback((id: string) => {
    getFailoverOverview(id).then(setOverview).catch(() => setOverview(null));
    getCandidateCompanions(id).then(setCandidates).catch(() => setCandidates([]));
  }, []);

  const select = (id: string) => { setSelected(id); setMsg(null); loadCall(id); };
  const refresh = () => { loadCalls(); if (selected) loadCall(selected); };

  const act = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg(`${label} done.`); } catch { setMsg(`${label} failed.`); }
    setBusy(false);
    if (selected) loadCall(selected);
    loadCalls();
  };

  const transferMessage = (outcome: string): string => ({
    assigned: 'Transferred — the member, new companion and original have all been notified.',
    conflict: 'That companion already has a call at this time.',
    no_consent: 'That companion hasn’t accepted the platform terms yet, so they couldn’t join. Pick someone else.',
    not_approved: 'That companion isn’t approved yet.',
    suspended: 'That companion is suspended.',
    blocked_with_member: 'That companion and this member have blocked each other.',
    too_late: 'This call has already started.',
    not_found: 'Booking not found.',
  } as Record<string, string>)[outcome] ?? `Couldn’t transfer (${outcome}).`;

  const doTransfer = async (companionProfileId: string) => {
    if (!selected) return;
    setBusy(true); setMsg(null);
    const r = await assignCompanion(selected, companionProfileId);
    setBusy(false);
    setMsg(r.ok ? transferMessage(r.outcome) : 'Transfer failed — please try again.');
    loadCall(selected); loadCalls();
  };

  const sendMemberMessage = async () => {
    if (!selected || !memberMsg.trim()) return;
    setBusy(true); setMsg(null);
    const r = await messageMember(selected, memberMsg.trim());
    setBusy(false); setMsg(r.detail);
    if (r.ok) setMemberMsg('');
  };

  const offers = (overview?.offers as OfferRow[] | undefined) ?? [];
  const available = offers.filter((o) => o.status === 'available');

  return (
    <section className="card section-tight col" style={{ gap: 12 }} aria-label="Manual backups">
      <div className="row between" style={{ alignItems: 'center' }}>
        <h2 className="section-label" style={{ margin: 0 }}>Pick backups for a call</h2>
        <button className="btn btn-ghost btn-small" onClick={refresh} disabled={busy}><RefreshCw size={15} aria-hidden="true" /> Refresh</button>
      </div>

      {/* Call picker */}
      <div className="col" style={{ gap: 6 }}>
        {calls.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>No upcoming credit calls.</p>
        ) : calls.map((c) => (
          <button key={c.booking_id}
            className={`btn btn-small ${selected === c.booking_id ? 'btn-primary' : 'btn-ghost'}`}
            style={{ justifyContent: 'flex-start', textAlign: 'left' }}
            onClick={() => select(c.booking_id)}>
            [{c.kind}] {when(c.starts_at)} · {c.member_first ?? 'Member'} with {c.companion_first ?? 'companion'}
            {' · '}
            {c.reassigned ? 'reassigned' : c.primary_confirmed ? 'confirmed' : 'awaiting confirmation'}
            {c.available_count > 0 ? ` · ${c.available_count} backup(s) accepted` : ''}
          </button>
        ))}
      </div>

      {msg && <p role="status" className="small" style={{ margin: 0 }}>{msg}</p>}

      {selected && overview && (
        <div className="col" style={{ gap: 12, borderTop: '1px solid var(--border, #FBE9DE)', paddingTop: 10 }}>
          <div className="small">
            <strong>Primary:</strong>{' '}
            {(overview.current_companion as { first_name?: string })?.first_name ?? '—'}{' '}
            — {String(overview.primary_accepted) === 'true' ? 'confirmed' : 'not confirmed yet'}
          </div>

          {/* Accepted backups → transfer */}
          <div>
            <h3 className="section-label" style={{ margin: '0 0 6px' }}>Invited backups ({offers.length})</h3>
            {offers.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>None invited yet — pick companions below.</p>
            ) : (
              <div className="stack-list">
                {offers.map((o) => (
                  <div key={o.id} className="row between wrap" style={{ gap: 8, alignItems: 'center', padding: '4px 0' }}>
                    <span>
                      {o.companion?.first_name ?? 'Companion'} {o.companion?.last_name ?? ''}
                      {' — '}
                      <span className={o.status === 'available' ? 'text-success' : 'muted'}>{o.status}</span>
                      {o.twilio_status ? <span className="muted small"> · sms {o.twilio_status}</span> : null}
                    </span>
                    {o.status === 'available' && (
                      <button className="btn btn-primary btn-small" disabled={busy}
                        onClick={() => doTransfer(o.companion_profile)}>
                        Transfer call to them
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {available.length > 0 && (
              <p className="muted small" style={{ margin: '6px 0 0' }}>
                Transferring notifies the member, the new companion and the original companion automatically.
              </p>
            )}
          </div>

          {/* Message the member who booked the call */}
          <div>
            <h3 className="section-label" style={{ margin: '0 0 6px' }}>Message the member</h3>
            <textarea
              className="input"
              rows={2}
              maxLength={500}
              placeholder="e.g. We’re arranging cover for your call — it will still go ahead as planned."
              value={memberMsg}
              disabled={busy}
              onChange={(e) => setMemberMsg(e.target.value)}
              style={{ width: '100%', resize: 'vertical' }}
            />
            <div className="row between" style={{ alignItems: 'center', marginTop: 6 }}>
              <span className="muted small">Sends an in-app note and a text to whoever booked the call.</span>
              <button className="btn btn-secondary btn-small" disabled={busy || !memberMsg.trim()} onClick={sendMemberMessage}>
                Send to member
              </button>
            </div>
          </div>

          {/* Candidate picker → invite */}
          <div>
            <h3 className="section-label" style={{ margin: '0 0 6px' }}>Companions you can invite</h3>
            <div className="stack-list" style={{ maxHeight: 260, overflowY: 'auto' }}>
              {candidates.map((c) => (
                <div key={c.profile_id} className="row between wrap" style={{ gap: 8, alignItems: 'center', padding: '4px 0' }}>
                  <span>
                    {c.first_name ?? '—'} {c.last_name ?? ''}{' '}
                    {c.is_free ? <Check size={13} aria-label="free" style={{ color: 'green' }} /> : <X size={13} aria-label="busy" style={{ color: '#b45309' }} />}
                    {c.has_phone ? <Phone size={12} aria-label="has phone" style={{ marginLeft: 4, opacity: 0.6 }} /> : <span className="muted small"> no phone</span>}
                  </span>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn btn-ghost btn-small" disabled={busy || c.already_invited}
                      onClick={() => act(() => offerBackup(selected, c.profile_id), `Invite ${c.first_name ?? ''}`)}>
                      <UserPlus size={13} aria-hidden="true" /> {c.already_invited ? 'Invited' : 'Invite'}
                    </button>
                    <button className="btn btn-primary btn-small" disabled={busy}
                      onClick={() => doTransfer(c.profile_id)}
                      title="Assign this call to them now (no need to wait for them to accept)">
                      Transfer now
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-ghost btn-small" disabled={busy}
              onClick={() => act(() => keepPrimary(selected), 'Keep original')}>Keep original &amp; clear backups</button>
          </div>
        </div>
      )}
    </section>
  );
}
