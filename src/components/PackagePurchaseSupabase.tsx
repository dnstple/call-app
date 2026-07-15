/**
 * Stage 2E3B1 — public package cards + SIMULATED purchase flow.
 *
 * Members (or Coordinators with can_book) pick an active package, review it
 * and confirm. The browser sends ONLY the member and offer ids — buyer,
 * price and credits are all derived server-side. No payment is taken and
 * the flow says so plainly. packageRepository is the only data path.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Loader2, Package, X } from 'lucide-react';
import type { PackageOfferRow } from '../supabase/database.types';
import type { User } from '../types';
import {
  createSimulatedPurchase,
  getPublicPackageOffers,
  PackageError,
} from '../repositories/packageRepository';
import { formatMinor } from '../repositories/availabilityRepository';
import { MEDIUM_LABELS } from '../domain/format';
import { useAuthSnapshot } from '../state/authBridge';
import { perConversationLabel } from './PackageOfferEditor';

/** Active package offers on a public Companion profile. */
export function PublicPackages({ companion }: { companion: User }) {
  const auth = useAuthSnapshot();
  const [offers, setOffers] = useState<PackageOfferRow[] | null>(null);
  const [buying, setBuying] = useState<PackageOfferRow | null>(null);

  useEffect(() => {
    let live = true;
    getPublicPackageOffers(companion.id)
      .then((rows) => live && setOffers(rows))
      .catch(() => live && setOffers([]));
    return () => {
      live = false;
    };
  }, [companion.id]);

  const canBuy = auth.profiles.some(
    (p) => p.profile.role === 'member' && p.access.can_book && p.access.consent_status !== 'withdrawn',
  );

  if (!offers || offers.length === 0) return null; // profiles stay calm without packages

  return (
    <section className="section-tight" aria-label="Conversation packages">
      <h2>Conversation packages</h2>
      <div className="grid-2">
        {offers.map((o) => (
          <div key={o.id} className="card card-tight col" style={{ gap: 8 }}>
            <div className="row" style={{ gap: 8 }}>
              <Package size={18} aria-hidden="true" />
              <span className="bold">{o.title}</span>
            </div>
            <span className="muted small">
              {o.conversation_count} × {o.duration_minutes}-minute conversations ·{' '}
              {(o.supported_methods ?? []).map((m) => MEDIUM_LABELS[m as keyof typeof MEDIUM_LABELS] ?? m).join(', ')}
            </span>
            <div className="row between wrap" style={{ gap: 8 }}>
              <span>
                <span className="bold" style={{ fontSize: '1.15em' }}>{formatMinor(o.price_minor)}</span>{' '}
                <span className="faint">{perConversationLabel(o.price_minor, o.conversation_count)}</span>
              </span>
              {canBuy && (
                <button className="btn btn-secondary btn-small" onClick={() => setBuying(o)}>
                  Buy plan
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="faint mt-2">No payment will be taken yet — purchases are simulated until payments arrive.</p>
      {buying && (
        <PackagePurchaseDialogSupabase companion={companion} offer={buying} onClose={() => setBuying(null)} />
      )}
    </section>
  );
}

/** Review + confirm a SIMULATED purchase. */
export function PackagePurchaseDialogSupabase({
  companion,
  offer,
  onClose,
}: {
  companion: User;
  offer: PackageOfferRow;
  onClose: () => void;
}) {
  const auth = useAuthSnapshot();

  const bookableMembers = useMemo(
    () =>
      auth.profiles
        .filter((p) => p.profile.role === 'member' && p.access.can_book && p.access.consent_status !== 'withdrawn')
        .map((p) => p.profile),
    [auth.profiles],
  );
  const [memberId, setMemberId] = useState(bookableMembers[0]?.id ?? '');
  const member = bookableMembers.find((m) => m.id === memberId);
  const multipleMembers = bookableMembers.length > 1;

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const confirm = async () => {
    if (submitting || !member) return; // duplicate-click protection
    setSubmitting(true);
    setError(null);
    try {
      await createSimulatedPurchase(member.id, offer.id);
      setDone(true);
    } catch (e) {
      setError(e instanceof PackageError ? e.message : 'That didn’t work. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <Dialog title={done ? 'Package added' : 'Review this package'} onClose={onClose}>
      {done ? (
        <div className="col" style={{ gap: 12 }}>
          <p role="status" style={{ margin: 0 }}>
            The package has been added for {member?.first_name}. Remaining conversations appear on
            your Home page.
          </p>
          <p className="muted" style={{ margin: 0 }}>
            This was a prototype purchase — no payment was taken and these credits can’t be used for
            booking yet.
          </p>
          <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={onClose}>
            Done
          </button>
        </div>
      ) : (
        <div className="col" style={{ gap: 14 }}>
          {error && (
            <p role="alert" className="badge badge-danger" style={{ display: 'block' }}>{error}</p>
          )}

          {multipleMembers && (
            <div>
              <div className="bold mb-2">Who is this package for?</div>
              <div className="col" style={{ gap: 8 }}>
                {bookableMembers.map((m) => (
                  <label key={m.id} className="card card-tight row" style={{ cursor: 'pointer', gap: 10 }}>
                    <input
                      type="radio"
                      name="package-member"
                      checked={memberId === m.id}
                      onChange={() => setMemberId(m.id)}
                    />
                    <span className="bold">{m.first_name} {m.last_name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="card card-muted col" style={{ gap: 6 }}>
            <span className="bold">{offer.title}</span>
            <span className="muted">
              {offer.conversation_count} × {offer.duration_minutes}-minute conversations with {companion.firstName}
            </span>
            {member && <span className="muted">For {member.first_name} {member.last_name}</span>}
            <div className="row between mt-2">
              <span className="muted">Total price</span>
              <span className="bold">{formatMinor(offer.price_minor)}</span>
            </div>
          </div>

          <p className="badge badge-neutral" style={{ display: 'block' }}>
            This is a prototype purchase. No payment will be taken.
          </p>

          <div className="row" style={{ gap: 10 }}>
            <button className="btn btn-primary" disabled={submitting || !member} onClick={() => void confirm()}>
              {submitting ? 'Adding…' : 'Confirm package'}
            </button>
            <button className="btn btn-ghost" disabled={submitting} onClick={onClose}>Cancel</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal card"
        style={{ maxWidth: 520, width: '100%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row between mb-4">
          <h2 style={{ margin: 0, fontSize: '1.15em' }}>{title}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
