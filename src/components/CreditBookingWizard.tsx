/**
 * Credit booking (membership restructure). A member spends one call credit to
 * book a 45-minute conversation in an available slot. The booking is instant and
 * guaranteed; the companion confirms it, and admin fallback covers no-shows.
 * Replaces the old offer/price booking flow for the membership model.
 */
import { useEffect, useMemo, useState } from 'react';
import { getAllCreditSlots, createCreditBooking, type AvailableSlot } from '../repositories/bookingRepository';
import { getCreditBalance } from '../repositories/creditsRepository';
import { beginMembership } from '../repositories/membershipRepository';
import { slotDayKey, slotDayLabel, slotTimeLabel } from './SupabaseBookingWizard';

interface CompanionLike { id: string; firstName?: string; timezone?: string }

export function CreditBookingWizard({
  companion, memberProfileId, onClose, onBooked,
}: {
  companion: CompanionLike;
  memberProfileId: string;
  onClose: () => void;
  onBooked?: () => void;
}) {
  const tz = companion.timezone || 'Europe/London';
  const [balance, setBalance] = useState<number | null>(null);
  const [slots, setSlots] = useState<AvailableSlot[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [noCredits, setNoCredits] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let live = true;
    getCreditBalance(memberProfileId).then((b) => { if (live) setBalance(b?.balance ?? 0); }).catch(() => { if (live) setBalance(0); });
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 31 * 86400000).toISOString();
    getAllCreditSlots({ companionProfileId: companion.id, from, to })
      .then((s) => { if (live) setSlots(s); }).catch(() => { if (live) setSlots([]); });
    return () => { live = false; };
  }, [companion.id, memberProfileId]);

  const days = useMemo(() => {
    const map = new Map<string, AvailableSlot[]>();
    for (const s of slots ?? []) {
      const k = slotDayKey(s.startsAt, tz);
      (map.get(k) ?? map.set(k, []).get(k)!).push(s);
    }
    return [...map.entries()];
  }, [slots, tz]);

  const book = async () => {
    if (!selected) return;
    setBusy(true); setErr(null);
    const r = await createCreditBooking(companion.id, memberProfileId, selected);
    setBusy(false);
    if (r.ok) { setDone(true); onBooked?.(); return; }
    if (r.error === 'no_credits') { setNoCredits(true); setBalance(0); return; }
    setErr(r.error ?? 'We couldn’t book that call.');
  };

  const startMembership = async () => {
    setBusy(true);
    await beginMembership(memberProfileId);   // redirects to Stripe
    setBusy(false);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(32,28,25,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }} onClick={onClose}>
      <div className="col" style={{ width: '100%', maxWidth: 560, maxHeight: '90vh', background: '#FCFAF7', borderRadius: 16, overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div className="row between" style={{ padding: '16px 20px', borderBottom: '1px solid #FBE9DE', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: '1.2em' }}>Book a call with {companion.firstName ?? 'this companion'}</h2>
          <button className="btn btn-ghost btn-small" onClick={onClose}>Close</button>
        </div>

        <div className="col" style={{ gap: 12, padding: 20, overflowY: 'auto' }}>
          {done ? (
            <div className="col" style={{ gap: 12, textAlign: 'center', padding: '20px 0' }}>
              <strong style={{ fontSize: '1.1em' }}>Your call is booked</strong>
              <p className="muted" style={{ margin: 0 }}>It’s confirmed for {selected ? `${slotDayLabel(selected, tz)}, ${slotTimeLabel(selected, tz)}` : ''}. {companion.firstName ?? 'Your companion'} will confirm shortly.</p>
              <button className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          ) : noCredits || balance === 0 ? (
            <div className="col" style={{ gap: 10, textAlign: 'center', padding: '10px 0' }}>
              <strong>No credits available</strong>
              <p className="muted" style={{ margin: 0 }}>You need a call credit to book. Your membership adds 3 credits each week — or start your membership now.</p>
              <button className="btn btn-primary" disabled={busy} onClick={startMembership}>Start your first week — £25</button>
            </div>
          ) : (
            <>
              <p className="muted" style={{ margin: 0 }}>
                {balance === null ? 'Loading your credits…' : `${balance} credit${balance === 1 ? '' : 's'} available · each call is 45 minutes and uses 1 credit.`}
              </p>
              {err && <p style={{ margin: 0, color: '#C8643D', fontSize: 13 }}>{err}</p>}
              {slots === null ? (
                <p className="muted" style={{ margin: 0 }}>Loading available times…</p>
              ) : days.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>No available times in the next few weeks. Please check back soon.</p>
              ) : (
                <div className="col" style={{ gap: 14 }}>
                  {days.map(([key, daySlots]) => (
                    <div key={key} className="col" style={{ gap: 6 }}>
                      <strong style={{ fontSize: 14 }}>{slotDayLabel(daySlots[0].startsAt, tz)}</strong>
                      <div className="row wrap" style={{ gap: 6 }}>
                        {daySlots.map((s) => (
                          <button key={s.startsAt}
                            className={`btn btn-small ${selected === s.startsAt ? 'btn-primary' : 'btn-secondary'}`}
                            onClick={() => setSelected(s.startsAt)}>
                            {slotTimeLabel(s.startsAt, tz)}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {!done && !(noCredits || balance === 0) && (
          <div className="row" style={{ padding: '14px 20px', borderTop: '1px solid #FBE9DE', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" disabled={!selected || busy} onClick={book}>
              {busy ? 'Booking…' : selected ? `Book ${slotTimeLabel(selected, tz)} (1 credit)` : 'Choose a time'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
