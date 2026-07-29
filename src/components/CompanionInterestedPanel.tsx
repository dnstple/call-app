/**
 * Block 11 — "Interested in you" (Companion view).
 *
 * A restrained panel showing the people who have favourited this Companion,
 * with a one-time introduction ("Say hello"). Everything shown is safe
 * (first name + region only, resolved from the server), and every action is
 * server-enforced: one favourite-gated, rate-limited introduction per person,
 * subject to the same blocks/consent/suspension trust as any message.
 */
import { useCallback, useEffect, useState } from 'react';
import { Heart, Loader2 } from 'lucide-react';
import {
  companionIntroduce,
  getCompanionFavouriters,
  type CompanionFavouriter,
} from '../repositories/messagingRepository';
import { useAuthSnapshot } from '../state/authBridge';
import { pushToast } from '../state/store';

export function CompanionInterestedPanel() {
  const auth = useAuthSnapshot();
  const companionProfileId = auth.activeProfileId ?? '';
  const [people, setPeople] = useState<CompanionFavouriter[] | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setPeople(await getCompanionFavouriters()); }
    catch { setPeople([]); } // a private teaser failing is never a blocker
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!people || people.length === 0) return null;

  const say = async (memberProfileId: string) => {
    if (busy || !companionProfileId) return;
    if (!message.trim()) { setError('Add a short hello first.'); return; }
    setBusy(true); setError(null);
    try {
      await companionIntroduce(companionProfileId, memberProfileId, message.trim());
      setOpenFor(null); setMessage('');
      pushToast('Introduction sent.', 'ok');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^[a-z_]+: /, '') : 'We couldn’t send that.');
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = (s: string | null) =>
    s === 'active' ? 'Connected' : s === 'request_pending' ? 'Introduction sent' : s === 'declined' ? 'Not now' : null;

  return (
    <section className="card" aria-label="People interested in you">
      <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 8 }}>
        <Heart size={18} aria-hidden="true" fill="currentColor" style={{ color: 'var(--color-brand-strong)' }} />
        <h2 style={{ margin: 0, fontSize: '1.1em' }}>Interested in you</h2>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        People who saved your profile. You can send one friendly hello.
      </p>
      {error && <div className="banner banner-danger mt-2" role="alert">{error}</div>}
      <div className="stack-list mt-2">
        {people.map((p) => {
          const label = statusLabel(p.conversationStatus);
          return (
            <div key={p.memberProfileId} className="card card-tight col" style={{ gap: 8 }}>
              <div className="row between wrap" style={{ gap: 8 }}>
                <div className="col" style={{ gap: 2 }}>
                  <span className="bold">
                    {p.memberFirstName}
                    {p.memberRegion ? <span className="muted" style={{ fontWeight: 500 }}> · {p.memberRegion}</span> : null}
                  </span>
                  {p.viaCoordinator && <span className="faint small">Arranged by a coordinator</span>}
                </div>
                {label ? (
                  <span className="badge badge-neutral">{label}</span>
                ) : openFor === p.memberProfileId ? null : (
                  <button className="btn btn-secondary btn-small" onClick={() => { setOpenFor(p.memberProfileId); setMessage(''); setError(null); }}>
                    Say hello
                  </button>
                )}
              </div>
              {openFor === p.memberProfileId && (
                <div className="col" style={{ gap: 8 }}>
                  <label className="visually-hidden" htmlFor={`hello-${p.memberProfileId}`}>Your hello to {p.memberFirstName}</label>
                  <textarea
                    id={`hello-${p.memberProfileId}`}
                    rows={2}
                    maxLength={2000}
                    value={message}
                    placeholder={`A friendly hello to ${p.memberFirstName}…`}
                    onChange={(e) => setMessage(e.target.value)}
                  />
                  <div className="row" style={{ gap: 8 }}>
                    <button className="btn btn-primary btn-small" disabled={busy} onClick={() => void say(p.memberProfileId)}>
                      {busy ? 'Sending…' : 'Send introduction'}
                    </button>
                    <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => { setOpenFor(null); setError(null); }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
