/**
 * Stage 2E3B1 — Companion package editor (Supabase mode).
 *
 * Create, edit, archive and re-activate real package offers through
 * packageRepository only. Prices are totals in pounds; the approximate
 * per-conversation price is shown as a guide. No payment is taken
 * anywhere — purchases stay simulated until the payments milestone.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { PackageOfferRow } from '../supabase/database.types';
import {
  archivePackageOffer,
  createPackageOffer,
  getPackageOffers,
  PackageError,
  PACKAGE_DURATIONS,
  updatePackageOffer,
  validatePackageOfferInput,
} from '../repositories/packageRepository';
import { formatMinor, poundsToMinor } from '../repositories/availabilityRepository';

export function perConversationLabel(priceMinor: number, count: number): string {
  if (count < 1) return '';
  return `≈ ${formatMinor(Math.round(priceMinor / count))} per conversation`;
}

const COUNTS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20];

export function PackageOfferEditor({ profileId, methods }: { profileId: string; methods: string[] }) {
  const [offers, setOffers] = useState<PackageOfferRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PackageOfferRow | null>(null);
  const [title, setTitle] = useState('');
  const [count, setCount] = useState(4);
  const [duration, setDuration] = useState(30);
  const [price, setPrice] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOffers(await getPackageOffers(profileId));
    } catch {
      setError('We couldn’t load your packages.');
    }
  }, [profileId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setTitle('');
    setCount(4);
    setDuration(30);
    setPrice('');
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (offer: PackageOfferRow) => {
    setEditing(offer);
    setTitle(offer.title);
    setCount(offer.conversation_count);
    setDuration(offer.duration_minutes);
    setPrice((offer.price_minor / 100).toFixed(2));
    setFormError(null);
    setFormOpen(true);
  };

  const save = async () => {
    if (saving) return; // duplicate-click protection
    const priceMinor = poundsToMinor(price);
    const input = {
      title: title.trim() || undefined,
      conversationCount: count,
      durationMinutes: duration,
      priceMinor,
      supportedMethods: ['in_app'],
    };
    const invalid = validatePackageOfferInput(input);
    if (invalid) {
      setFormError(invalid.message);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (editing) await updatePackageOffer(editing.id, input);
      else await createPackageOffer(profileId, input);
      setFormOpen(false);
      await load();
    } catch (e) {
      setFormError(e instanceof PackageError ? e.message : 'We couldn’t save this package.');
    } finally {
      setSaving(false);
    }
  };

  const setActive = async (offer: PackageOfferRow, active: boolean) => {
    try {
      if (active) await updatePackageOffer(offer.id, { active: true });
      else await archivePackageOffer(offer.id);
      await load();
    } catch (e) {
      setError(e instanceof PackageError ? e.message : 'We couldn’t update this package.');
    }
  };

  const priceMinor = poundsToMinor(price);

  return (
    <section className="card section-tight" aria-label="Conversation packages">
      <h2>Conversation packages</h2>
      <div className="banner mb-4">
        Packages are bundles of conversations at one price. Purchases are simulated for now — no
        payment is taken until payments are introduced.
      </div>

      {error && <p className="muted" role="alert">{error}</p>}

      {offers === null ? (
        <div className="row" style={{ gap: 10 }}>
          <Loader2 size={18} aria-hidden="true" />
          <span className="muted">Loading packages…</span>
        </div>
      ) : offers.length === 0 && !formOpen ? (
        <p className="muted">No conversation packages yet.</p>
      ) : (
        <div className="stack-list mb-4">
          {offers.map((o) => (
            <div key={o.id} className="card card-tight row between wrap" style={{ gap: 10 }}>
              <div className="col" style={{ gap: 2 }}>
                <span className="bold">
                  {o.title}
                  {!o.active && <span className="badge badge-neutral" style={{ marginLeft: 8 }}>Archived</span>}
                </span>
                <span className="muted small">
                  {o.conversation_count} × {o.duration_minutes} mins · {formatMinor(o.price_minor)} ·{' '}
                  {perConversationLabel(o.price_minor, o.conversation_count)}
                </span>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-ghost btn-small" onClick={() => openEdit(o)}>Edit</button>
                {o.active ? (
                  <button className="btn btn-secondary btn-small" onClick={() => void setActive(o, false)}>
                    Archive
                  </button>
                ) : (
                  <button className="btn btn-secondary btn-small" onClick={() => void setActive(o, true)}>
                    Re-activate
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {!formOpen && (
        <button className="btn btn-secondary" onClick={openCreate}>Add a package</button>
      )}

      {formOpen && (
        <div className="card card-muted col" style={{ gap: 12, maxWidth: 560 }}>
          <h3 style={{ margin: 0 }}>{editing ? 'Edit package' : 'New package'}</h3>
          {formError && (
            <p role="alert" className="badge badge-danger" style={{ display: 'block' }}>{formError}</p>
          )}
          <label className="col" style={{ gap: 6 }}>
            <span className="bold">Title (optional)</span>
            <input
              type="text"
              value={title}
              maxLength={80}
              placeholder={`${count} × ${duration}-minute conversations`}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <div className="row wrap" style={{ gap: 14 }}>
            <label className="col" style={{ gap: 6 }}>
              <span className="bold">Conversations</span>
              <select value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="Number of conversations">
                {COUNTS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="col" style={{ gap: 6 }}>
              <span className="bold">Duration each</span>
              <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} aria-label="Duration per conversation">
                {PACKAGE_DURATIONS.map((d) => <option key={d} value={d}>{d} minutes</option>)}
              </select>
            </label>
            <label className="col" style={{ gap: 6 }}>
              <span className="bold">Total price (£)</span>
              <input
                type="number"
                min={1}
                max={2000}
                step="0.50"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                aria-label="Total package price in pounds"
              />
            </label>
          </div>
          {Number.isFinite(priceMinor) && priceMinor >= 100 && (
            <p className="muted" style={{ margin: 0 }}>{perConversationLabel(priceMinor, count)}</p>
          )}
          <div className="row" style={{ gap: 10 }}>
            <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Create package'}
            </button>
            <button className="btn btn-ghost" disabled={saving} onClick={() => setFormOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
