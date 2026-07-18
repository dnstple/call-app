/**
 * Real booking detail (Supabase mode, Stage 2D) — /conversations/:bookingId.
 * Participant-only (RLS); shows status, snapshot pricing (no payment taken),
 * audited history, pending time proposals and only the actions the current
 * account may genuinely perform. The server re-checks every action.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarDays, Clock, Loader2, Phone, ShieldQuestion } from 'lucide-react';
import { isSupabaseMode } from '../config/dataMode';
import { useAuthSnapshot } from '../state/authBridge';
import {
  acceptBooking,
  acceptTimeProposal,
  cancelBooking,
  canRescheduleBooking,
  declineBooking,
  derivedStatusLabel,
  RESCHEDULE_CLOSED_COPY,
  RESCHEDULE_OPEN_COPY,
  getBookingById,
  getBookingHistory,
  getPendingProposal,
  proposeBookingTime,
  rejectTimeProposal,
  type AvailableSlot,
} from '../repositories/bookingRepository';
import { RepoError } from '../repositories/profileRepository';
import { formatMinor } from '../repositories/availabilityRepository';
import { browserTimezone } from '../domain/timezones';
import { MEDIUM_LABELS } from '../domain/format';
import type { BookingHistoryRow, BookingProposalRow, MyBookingRow } from '../supabase/database.types';
import { EmptyState } from '../components/ui';
import { SlotPicker, slotDayLabel, slotTimeLabel } from '../components/SupabaseBookingWizard';
import { getAvailablePackageSlots } from '../repositories/packageRepository';
import { DateTimeSlotPicker } from '../components/DateTimeSlotPicker';
import { CompletionPanel } from '../components/CompletionPanel';
import { IN_APP_CALL_EXPLAINER, IN_APP_CALL_LABEL } from '../components/FlowModal';
import { RatingPanel } from '../components/RatingPanel';
import { BookingCreditPanel } from '../components/BookingCreditBadge';

const STATUS_BADGE: Record<string, string> = {
  requested: 'badge-neutral',
  confirmed: 'badge-success',
  declined: 'badge-danger',
  change_proposed: 'badge-neutral',
  cancelled: 'badge-danger',
  completed: 'badge-success',
  needs_review: 'badge-neutral',
};

const HISTORY_LABELS: Record<string, string> = {
  requested: 'Request sent',
  confirmed: 'Confirmed',
  declined: 'Declined',
  change_proposed: 'A new time was proposed',
  cancelled: 'Cancelled',
  completed: 'Completed — confirmed by both sides',
  needs_review: 'Flagged for review',
};

export default function BookingDetail() {
  const { bookingId } = useParams();
  const navigate = useNavigate();
  const auth = useAuthSnapshot();
  const viewerTz = browserTimezone();

  const [booking, setBooking] = useState<MyBookingRow | null>(null);
  const [history, setHistory] = useState<BookingHistoryRow[]>([]);
  const [proposal, setProposal] = useState<BookingProposalRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [reason, setReason] = useState('');
  const [proposedSlot, setProposedSlot] = useState<AvailableSlot | null>(null);

  const load = useCallback(async () => {
    if (!bookingId) return;
    try {
      const b = await getBookingById(bookingId);
      setBooking(b);
      if (b) {
        const [h, p] = await Promise.all([
          getBookingHistory(b.id).catch(() => []),
          getPendingProposal(b.id).catch(() => null),
        ]);
        setHistory(h);
        setProposal(p);
      }
    } catch (e) {
      setError(e instanceof RepoError ? e.message : 'We couldn’t load this conversation.');
    } finally {
      setLoading(false);
    }
  }, [bookingId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Which side(s) of this booking is the signed-in account?
  const isCompanionSide = useMemo(
    () => !!booking && auth.profiles.some((p) => p.profile.id === booking.companion_profile_id),
    [booking, auth.profiles],
  );
  const isRequesterSide = useMemo(
    () =>
      !!booking &&
      (booking.booked_by_account_id === auth.userId ||
        auth.profiles.some((p) => p.profile.id === booking.member_profile_id && p.access.can_book)),
    [booking, auth.userId, auth.profiles],
  );

  if (!isSupabaseMode()) {
    return (
      <EmptyState
        title="Not available in mock mode"
        body="Booking details live in the Conversations list in the prototype data mode."
        action={<Link to="/conversations" className="btn btn-primary">Go to Conversations</Link>}
      />
    );
  }

  if (loading) {
    return (
      <div className="row" style={{ justifyContent: 'center', padding: 64 }}>
        <Loader2 size={26} aria-hidden="true" />
        <span className="muted">Loading conversation…</span>
      </div>
    );
  }

  if (error || !booking) {
    return (
      <EmptyState
        icon={<ShieldQuestion size={36} aria-hidden="true" />}
        title="Conversation not found"
        body={error ?? 'This conversation doesn’t exist, or you don’t have permission to see it.'}
        action={<Link to="/conversations" className="btn btn-secondary">Back to Conversations</Link>}
      />
    );
  }

  const ended = new Date(booking.ends_at).getTime() <= Date.now();
  // Once a conversation has ended, reschedule/cancel no longer make sense —
  // the completion panel takes over.
  const active = ['requested', 'confirmed', 'change_proposed'].includes(booking.status) && !ended;
  const iProposed = proposal?.proposed_by_account_id === auth.userId;

  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      setDeclining(false);
      setCancelling(false);
      setProposing(false);
      setReason('');
      setProposedSlot(null);
      await load();
    } catch (e) {
      setActionError(e instanceof RepoError ? e.message : 'That didn’t work. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button className="btn btn-ghost btn-small mb-4" onClick={() => navigate('/conversations')}>
        <ArrowLeft size={18} aria-hidden="true" /> All conversations
      </button>

      <header className="row wrap between" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="col" style={{ gap: 4 }}>
          <h1 style={{ margin: 0 }}>
            {booking.member_first_name} &amp; {booking.companion_first_name}
            {booking.companion_last_initial ? ` ${booking.companion_last_initial}.` : ''}
          </h1>
          <span className="muted">
            {booking.is_trial ? 'Trial conversation' : 'Standard conversation'} · {booking.duration_minutes} minutes
          </span>
        </div>
        <span className={`badge ${STATUS_BADGE[booking.status] ?? 'badge-neutral'}`}>
          {derivedStatusLabel(booking)}
        </span>
      </header>

      {actionError && (
        <p role="alert" className="badge badge-danger mt-4" style={{ display: 'block' }}>{actionError}</p>
      )}

      <section className="section-tight">
        <div className="card col" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 10 }}>
            <CalendarDays size={18} aria-hidden="true" />
            <span className="bold">{slotDayLabel(booking.starts_at, viewerTz)}</span>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <Clock size={18} aria-hidden="true" />
            <span>
              {slotTimeLabel(booking.starts_at, viewerTz)}–{slotTimeLabel(booking.ends_at, viewerTz)}{' '}
              <span className="faint">(your timezone, {viewerTz})</span>
            </span>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <Phone size={18} aria-hidden="true" />
            <span className="grow">{IN_APP_CALL_LABEL}</span>
          </div>
          <p className="faint longform" style={{ margin: 0 }}>
            {IN_APP_CALL_EXPLAINER}{' '}
            {canRescheduleBooking(booking) ? RESCHEDULE_OPEN_COPY : ''}
          </p>
          {/* 2F1: the way into the call room. The room itself opens ten
              minutes before the start; the server decides admission. */}
          {booking.status === 'confirmed' && !ended && (
            <div className="col" style={{ gap: 4 }}>
              <Link to={`/calls/${booking.id}`} className="btn btn-primary" style={{ alignSelf: 'flex-start' }}>
                <Phone size={18} aria-hidden="true" /> Open the call room
              </Link>
              <span className="faint">
                The room opens ten minutes before your conversation starts.
              </span>
            </div>
          )}
        </div>
      </section>

      {/* Pending alternative time */}
      {proposal && booking.status === 'change_proposed' && (
        <section className="section-tight">
          <div className="card card-muted col" style={{ gap: 10 }}>
            <div className="bold">New time proposed</div>
            <span>
              {slotDayLabel(proposal.proposed_starts_at, viewerTz)},{' '}
              {slotTimeLabel(proposal.proposed_starts_at, viewerTz)}–{slotTimeLabel(proposal.proposed_ends_at, viewerTz)}{' '}
              <span className="faint">({viewerTz})</span>
            </span>
            {proposal.message && <p className="muted" style={{ margin: 0 }}>“{proposal.message}”</p>}
            {iProposed ? (
              <p className="faint" style={{ margin: 0 }}>Waiting for the other side to reply.</p>
            ) : (
              <div className="row wrap" style={{ gap: 10 }}>
                <button className="btn btn-primary btn-small" disabled={busy} onClick={run(() => acceptTimeProposal(proposal.id))}>
                  Accept new time
                </button>
                <button className="btn btn-secondary btn-small" disabled={busy} onClick={run(() => rejectTimeProposal(proposal.id))}>
                  Keep it as it was
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Completion confirmation (Stage 2E1B) — ended conversations only */}
      <CompletionPanel booking={booking} onStatusChange={() => void load()} />

      {/* Rating (Stage 2E2B) — member side, completed conversations only */}
      <RatingPanel booking={booking} />

      {/* Price snapshot — honest payment boundary. Package-credit bookings
          show their credit state instead of a payable price. */}
      {booking.booking_source === 'package_credit' ? (
        <BookingCreditPanel booking={booking} />
      ) : (
      <section className="section-tight">
        <h2>Price</h2>
        <div className="card card-tight col" style={{ gap: 4, maxWidth: 420 }}>
          <div className="row between">
            <span className="muted">Conversation price</span>
            <span className="bold">{formatMinor(booking.price_minor, booking.currency)}</span>
          </div>
          <div className="row between">
            <span className="muted">Estimated platform fee ({Number(booking.platform_fee_rate)}%)</span>
            <span>{formatMinor(booking.platform_fee_minor, booking.currency)}</span>
          </div>
          <p className="faint" style={{ margin: '6px 0 0' }}>
            No payment has been taken. Payments will be added in a later stage.
          </p>
        </div>
      </section>
      )}

      {/* Actions */}
      {active && (isCompanionSide || isRequesterSide) && (
        <section className="section-tight">
          <h2>Actions</h2>
          <div className="row wrap" style={{ gap: 10 }}>
            {isCompanionSide && booking.status === 'requested' && (
              <>
                <button className="btn btn-primary" disabled={busy} onClick={run(() => acceptBooking(booking.id))}>
                  Accept request
                </button>
                <button className="btn btn-secondary" disabled={busy} onClick={() => setDeclining(true)}>
                  Decline
                </button>
                {booking.offer_id && canRescheduleBooking(booking) && (
                  <button className="btn btn-secondary" disabled={busy} onClick={() => setProposing(true)}>
                    Propose another time
                  </button>
                )}
              </>
            )}
            {booking.status === 'confirmed' && (isCompanionSide || isRequesterSide)
              && (booking.offer_id || booking.package_purchase_id) && canRescheduleBooking(booking) && (
              <button className="btn btn-secondary" disabled={busy} onClick={() => setProposing(true)}>
                {booking.plan_id ? 'Change this conversation only' : 'Propose a new time'}
              </button>
            )}
            <button className="btn btn-ghost" disabled={busy} onClick={() => setCancelling(true)}>
              Cancel conversation
            </button>
          </div>
          {/* The server is authoritative: it re-checks the cutoff with its
              own clock, so this copy only explains what will happen. */}
          {!canRescheduleBooking(booking) && (
            <p className="faint longform mt-2">{RESCHEDULE_CLOSED_COPY}</p>
          )}
          {booking.plan_id && canRescheduleBooking(booking) && (
            <p className="faint longform mt-2">
              This change applies only to this conversation — your weekly plan schedule stays the same.
            </p>
          )}

          {declining && (
            <div className="card card-tight col mt-4" style={{ gap: 10, maxWidth: 480 }}>
              <label className="col" style={{ gap: 6 }}>
                <span className="bold">Reason (optional)</span>
                <input type="text" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
              </label>
              <div className="row" style={{ gap: 10 }}>
                <button className="btn btn-primary btn-small" disabled={busy} onClick={run(() => declineBooking(booking.id, reason || undefined))}>
                  Confirm decline
                </button>
                <button className="btn btn-ghost btn-small" onClick={() => setDeclining(false)}>Back</button>
              </div>
            </div>
          )}

          {cancelling && (
            <div className="card card-tight col mt-4" style={{ gap: 10, maxWidth: 480 }}>
              <label className="col" style={{ gap: 6 }}>
                <span className="bold">Reason (optional)</span>
                <input type="text" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
              </label>
              <div className="row" style={{ gap: 10 }}>
                <button className="btn btn-primary btn-small" disabled={busy} onClick={run(() => cancelBooking(booking.id, reason || undefined))}>
                  Confirm cancellation
                </button>
                <button className="btn btn-ghost btn-small" onClick={() => setCancelling(false)}>Back</button>
              </div>
            </div>
          )}

          {/* Offer bookings pick from offer slots; plan/package conversations
              pick from the same server availability via the package RPC.
              Either way the server re-checks everything on submission. */}
          {proposing && (booking.offer_id || booking.package_purchase_id) && (
            <div className="card card-tight col mt-4" style={{ gap: 12 }}>
              <div className="bold">Choose an alternative time</div>
              {booking.offer_id ? (
                <SlotPicker
                  companionProfileId={booking.companion_profile_id}
                  offerId={booking.offer_id}
                  selected={proposedSlot}
                  onSelect={setProposedSlot}
                />
              ) : (
                <PackageSlotPicker
                  purchaseId={booking.package_purchase_id!}
                  selected={proposedSlot}
                  onSelect={setProposedSlot}
                />
              )}
              <div className="row" style={{ gap: 10 }}>
                <button
                  className="btn btn-primary btn-small"
                  disabled={busy || !proposedSlot}
                  onClick={run(() => proposeBookingTime(booking.id, { startsAt: proposedSlot!.startsAt }))}
                >
                  Propose this time
                </button>
                <button className="btn btn-ghost btn-small" onClick={() => setProposing(false)}>Back</button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Cancellation details */}
      {booking.status === 'cancelled' && (
        <section className="section-tight">
          <h2>Cancellation</h2>
          <p className="muted">
            Cancelled{booking.cancelled_at ? ` on ${slotDayLabel(booking.cancelled_at, viewerTz)}` : ''}
            {booking.cancellation_reason ? ` — “${booking.cancellation_reason}”` : ''}. No payment was taken.
          </p>
        </section>
      )}

      {/* Audited status history */}
      {history.length > 0 && (
        <section className="section-tight">
          <h2>History</h2>
          <div className="col" style={{ gap: 8 }}>
            {history.map((h) => (
              <p key={h.id} className="muted" style={{ margin: 0 }}>
                <strong style={{ color: 'var(--color-text-primary)' }}>
                  {HISTORY_LABELS[h.new_status] ?? h.new_status}
                </strong>{' '}
                · {slotDayLabel(h.created_at, viewerTz)}, {slotTimeLabel(h.created_at, viewerTz)}
                {h.reason ? ` — “${h.reason}”` : ''}
              </p>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** Server-availability picker for plan/package conversations (no offer). */
function PackageSlotPicker({ purchaseId, selected, onSelect }: {
  purchaseId: string;
  selected: AvailableSlot | null;
  onSelect: (slot: AvailableSlot) => void;
}) {
  const [slots, setSlots] = useState<AvailableSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const from = new Date(Date.now() + 2 * 3600_000).toISOString();
    const to = new Date(Date.now() + 28 * 86400_000).toISOString();
    getAvailablePackageSlots(purchaseId, from, to)
      .then((s) => setSlots(s))
      .catch(() => setError('We couldn’t load available times. Please try again.'))
      .finally(() => setLoading(false));
  }, [purchaseId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <DateTimeSlotPicker
      slots={slots}
      loading={loading}
      error={error}
      selected={selected}
      onSelect={onSelect}
      onRetry={load}
      emptyMessage="No free times in the next four weeks."
    />
  );
}
