/**
 * Support-only profile preview (/internal/access/preview/:accountId).
 *
 * Renders the COMPLETE profile a person entered — for any role and any
 * authorisation state — so support can see what their account will look like
 * before it is approved. Unlike the public marketplace page (which only lists
 * approved, discoverable companions), this reads app-authoritative data through
 * the support-gated admin_profile_preview RPC. Read-only: no booking, favourite
 * or messaging actions. Guarded by <SupportOnly> in the router AND re-checked
 * server-side inside the RPC.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { adminProfilePreview } from '../repositories/accessRepository';
import { avatarUrl } from '../repositories/profileRepository';

const ISO_DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function pretty(s: string | null | undefined): string {
  if (!s) return '—';
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function hour(h: number): string {
  const hh = ((h % 24) + 24) % 24;
  const suffix = hh < 12 ? 'am' : 'pm';
  const twelve = hh % 12 === 0 ? 12 : hh % 12;
  return `${twelve}${suffix}`;
}
function price(minor: number, currency: string): string {
  const sym = currency === 'GBP' ? '£' : '';
  return `${sym}${(minor / 100).toFixed(2)}`;
}

export default function InternalProfilePreview() {
  const { accountId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [photo, setPhoto] = useState<string | undefined>();

  const load = useCallback(() => {
    if (!accountId) { setState('error'); return; }
    setState('loading');
    adminProfilePreview(accountId)
      .then(async (d) => {
        if (!d || d.found !== true) { setData(d ?? null); setState('empty'); return; }
        setData(d);
        setState('ready');
        const prof = (d.profile as Record<string, unknown>) ?? {};
        const path = prof.avatar_path ? String(prof.avatar_path) : null;
        if (path) {
          try { setPhoto(await avatarUrl(path)); } catch { /* optional */ }
        } else if (prof.photo_url) {
          setPhoto(String(prof.photo_url));
        }
      })
      .catch(() => setState('error'));
  }, [accountId]);
  useEffect(() => { load(); }, [load]);

  const d = data ?? {};
  const p = (d.profile as Record<string, unknown>) ?? {};
  const name = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || '—';
  const interests = Array.isArray(p.interests) ? (p.interests as string[]) : [];
  const languages = Array.isArray(p.languages) ? (p.languages as string[]) : [];
  const places = Array.isArray(p.connected_places) ? (p.connected_places as string[]) : [];
  const fluency = (p.language_fluency as Record<string, string>) ?? {};
  const availability = Array.isArray(d.availability) ? (d.availability as Array<Record<string, unknown>>) : [];
  const offers = Array.isArray(d.offers) ? (d.offers as Array<Record<string, unknown>>) : [];

  return (
    <div className="col" style={{ gap: 16, maxWidth: 760, margin: '0 auto' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <button className="btn btn-ghost btn-small" onClick={() => navigate(-1)}>
          <ArrowLeft size={16} aria-hidden="true" /> Back
        </button>
        <Link className="btn btn-ghost btn-small" to="/internal/access">Access console</Link>
      </div>

      <div className="banner" role="note" style={{ background: 'var(--surface-muted)' }}>
        <strong>Support preview.</strong> This is how the profile will appear once approved —
        visible only to you, using the information the person entered. No actions are available here.
      </div>

      {state === 'loading' && (
        <div className="row" style={{ justifyContent: 'center', padding: 40 }}>
          <Loader2 size={22} aria-hidden="true" /><span className="visually-hidden">Loading</span>
        </div>
      )}

      {state === 'error' && (
        <section className="card"><p className="text-secondary" style={{ margin: 0 }}>
          We couldn’t load this preview. You may not be authorised, or the account no longer exists.
        </p></section>
      )}

      {state === 'empty' && (
        <section className="card"><p className="text-secondary" style={{ margin: 0 }}>
          This account has no profile yet ({pretty(d.role as string)} · {pretty(d.application_status as string)}).
        </p></section>
      )}

      {state === 'ready' && (
        <>
          <section className="card">
            <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
              {photo ? (
                <img src={photo} alt="" style={{ width: 96, height: 96, borderRadius: 16, objectFit: 'cover', flex: 'none' }} />
              ) : (
                <div className="text-secondary" style={{ width: 96, height: 96, borderRadius: 16, background: 'var(--surface-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontSize: '0.8rem' }}>No photo</div>
              )}
              <div className="col" style={{ gap: 4 }}>
                <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <h1 style={{ margin: 0, fontSize: '1.5rem' }}>{name}</h1>
                  <span className="access-badge">{pretty(d.role as string)}</span>
                  <span className={`access-badge s-${d.application_status}`}>{pretty(d.application_status as string)}</span>
                </div>
                {p.preferred_name ? <span className="text-secondary">Prefers “{String(p.preferred_name)}”</span> : null}
                {p.headline ? <p style={{ margin: '2px 0 0' }}>{String(p.headline)}</p> : null}
                <span className="text-secondary" style={{ fontSize: '0.9rem' }}>
                  {[p.age_band, p.region, p.country_of_residence].map((x) => (x ? String(x) : null)).filter(Boolean).join(' · ') || '—'}
                </span>
              </div>
            </div>
          </section>

          {p.bio ? (
            <section className="card">
              <h2 style={{ marginTop: 0, fontSize: '1.05rem' }}>About</h2>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{String(p.bio)}</p>
            </section>
          ) : null}

          <section className="card">
            <h2 style={{ marginTop: 0, fontSize: '1.05rem' }}>Details</h2>
            <div className="col" style={{ gap: 10 }}>
              <PreviewRow label="Interests" value={interests.length ? interests.join(', ') : '—'} />
              <PreviewRow
                label="Languages"
                value={languages.length ? languages.map((l) => (fluency[l] ? `${l} (${fluency[l]})` : l)).join(', ') : '—'}
              />
              {places.length > 0 && <PreviewRow label="Places & cultures" value={places.join(', ')} />}
            </div>
          </section>

          <section className="card">
            <h2 style={{ marginTop: 0, fontSize: '1.05rem' }}>Availability</h2>
            {availability.length > 0 ? (
              <ul className="access-mini-list">
                {availability.map((a, i) => (
                  <li key={i}>{ISO_DAYS[Number(a.day_of_week)] ?? '—'}: {hour(Number(a.start_hour))}–{hour(Number(a.end_hour))} <span className="text-secondary">({String(a.time_zone)})</span></li>
                ))}
              </ul>
            ) : (
              <p className="text-secondary" style={{ margin: 0 }}>No availability entered yet.</p>
            )}
          </section>

          <section className="card">
            <h2 style={{ marginTop: 0, fontSize: '1.05rem' }}>Conversation offers</h2>
            {offers.length > 0 ? (
              <ul className="access-mini-list">
                {offers.map((o, i) => (
                  <li key={i}>
                    {pretty(String(o.offer_type))}{o.title ? ` — ${String(o.title)}` : ''}: {Number(o.duration_minutes)} min · {price(Number(o.price_minor), String(o.currency))}
                    {o.active ? '' : ' (inactive)'}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-secondary" style={{ margin: 0 }}>
                No offers or pricing yet — companions set these in their dashboard after approval.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row between" style={{ gap: 16, alignItems: 'flex-start' }}>
      <span className="text-secondary" style={{ flex: 'none' }}>{label}</span>
      <span style={{ textAlign: 'right' }}>{value}</span>
    </div>
  );
}
