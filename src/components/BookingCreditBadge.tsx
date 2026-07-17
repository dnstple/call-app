/**
 * Stage 2E3B2B — credit state for a package-credit booking.
 *
 * The authoritative state ALWAYS comes from get_booking_credit_state
 * (server-side ledger flags) — never from React alone. Ordinary
 * single-offer bookings render nothing (not applicable).
 */
import { useEffect, useState } from 'react';
import { Package } from 'lucide-react';
import type { MyBookingRow } from '../supabase/database.types';
import {
  getBookingCreditState,
  getPackagePurchase,
  type BookingCreditState,
} from '../repositories/packageRepository';

export function creditStateLabel(
  state: Pick<BookingCreditState, 'reserved' | 'released' | 'consumed'>,
  bookingStatus: MyBookingRow['status'],
): string {
  if (state.consumed) return 'Package credit used — conversation completed';
  if (state.released) return 'Package credit released — returned to your package';
  if (bookingStatus === 'needs_review') return 'Package credit reserved while this is looked into';
  if (state.reserved) return 'Package credit reserved';
  return 'Package credit';
}

export function BookingCreditPanel({ booking }: { booking: MyBookingRow }) {
  const isPackage = booking.booking_source === 'package_credit';
  const [state, setState] = useState<BookingCreditState | null>(null);
  const [title, setTitle] = useState<string | null>(null);

  useEffect(() => {
    if (!isPackage) return;
    let live = true;
    getBookingCreditState(booking.id)
      .then((s) => live && setState(s))
      .catch(() => undefined);
    if (booking.package_purchase_id) {
      // Package titles are readable by the member side; companions see a
      // generic label instead (purchase records stay private to buyers).
      getPackagePurchase(booking.package_purchase_id)
        .then((p) => live && setTitle(p?.title ?? null))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [isPackage, booking.id, booking.package_purchase_id, booking.status]);

  if (!isPackage) return null; // ordinary offer booking: not applicable

  return (
    <section className="section-tight" aria-label="Package credit">
      <h2>Package</h2>
      <div className="card card-tight col" style={{ gap: 6, maxWidth: 460 }}>
        <span className="row bold" style={{ gap: 8 }}>
          <Package size={18} aria-hidden="true" />
          {title ?? 'Conversation package'}
        </span>
        <span className="muted">
          {state ? creditStateLabel(state, booking.status) : 'Checking credit status…'}
        </span>
        <p className="faint" style={{ margin: '4px 0 0' }}>
          This conversation uses one credit from a simulated package. No payment will be taken.
        </p>
      </div>
    </section>
  );
}
