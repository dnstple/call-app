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
import { getSupabaseClient } from '../supabase/client';
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
import { getAllAvailablePackageSlots } from '../repositories/packageRepository';
import { DateTimeSlotPicker, SLOT_WINDOW_DAYS } from '../components/DateTimeSlotPicker';
import { CompletionPanel } from '../components/CompletionPanel';
import { MessageActionButton } from '../messaging/MessageAction';
import { IN_APP_CALL_EXPLAINER, IN_APP_CALL_LABEL } from '../components/FlowModal';
import { RatingPanel } from '../components/RatingPanel';
import { BookingCreditPanel } from '../components/BookingCreditBadge';
import { GuestInvitationPanel } from '../components/GuestInvitationPanel';
import { AttendanceCard } from '../components/AttendanceCard';
import { CoordinatorPostConversationCard } from '../components/CoordinatorPostConversationCard';
import { ProfileAvatar } from '../components/ProfileAvatar';
import { useProfileAvatars } from '../state/avatars';

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
  const detailAvatarOf = useProfileAvatars([
    booking ? (isCompanionSide ? booking.member_profile_id : booking.companion_profile_id) : null,
  ]);
  const isRequesterSide = useMemo(
    () =>
      !!booking &&
      (booking.booked_by_account_id === auth.userId ||
        auth.profiles.some((p) => p.profile.id === booking.member_profile_id && p.access.can_book)),
    [booking, auth.userId, auth.profiles],
  );

  // 2G4B/2G4C authority: ask the SERVER (never the client) whether this is a
  // real, FUNDED conversation. For a funded booking after it ends there is
  // exactly ONE role-appropriate post-conversation card — AttendanceCard for
  // the Companion, CoordinatorPostConversationCard for the member side — and
  // the legacy CompletionPanel/RatingPanel are never rendered. Each side
  // reads its OWN authoritative RPC (the Companion cannot read the payment
  // order directly). null = unknown (nothing legacy shows while we wait);
  // false = a non-funded historical/mock record where the legacy outcome +
  // rating UI may still appear.
  const [funded, setFunded] = useState<boolean | null>(null);
  useEffect(() => {
    const hasEnded = !!booking && new Date(booking.ends_at).getTime() <= Date.now();
    if (!isSupabaseMode() || !booking || !hasEnded) {
      setFunded(null);
      return;
    }
    let live = true;
    const request = isCompanionSide
      ? getSupabaseClient().rpc('get_companion_completion_state', { p_booking: booking.id })
      : getSupabaseClient().rpc('get_review_state', { p_booking: booking.id });
    request.then(({ data, error: e }) => {
      if (!live || e || !data) return;
      const r = data as Record<string, unknown>;
      // completion-state exposes `funded`; review-state exposes `eligible`.
      setFunded(Boolean(r.funded ?? r.eligible));
    });
    return () => {
      live = false;
    };
  }, [booking, isCompanionSide]);

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
        {/* The counterpart's picture + name link to their profile when one
            exists (Companions have public pages; managed Members don't). */}
        {(() => {
          const identity = (
            <div className="row" style={{ gap: 14, alignItems: 'center' }}>
              <ProfileAvatar
                name={isCompanionSide ? booking.member_first_name : booking.companion_first_name}
                url={detailAvatarOf(isCompanionSide ? booking.member_profile_id : booking.companion_profile_id)}
                size="md"
                eager
              />
              <div className="col" style={{ gap: 4 }}>
                <h1 style={{ margin: 0 }}>
                  Conversation with {isCompanionSide
                    ? booking.member_first_name
                    : `${booking.companion_first_name}${booking.companion_last_initial ? ` ${booking.companion_last_initial}.` : ''}`}
                </h1>
                <span className="muted">
                  {!isCompanionSide && `For ${booking.member_first_name} · `}
                  {booking.is_trial ? 'Trial conversation' : 'Standard conversation'} · {booking.duration_minutes} minutes
                </span>
              </div>
            </div>
          );
          return isCompanionSide ? identity : (
            <Link
              to={`/people/${booking.companion_profile_id}`}
              aria-label={`View ${booking.companion_first_name}’s profile`}
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              {identity}
            </Link>
          );
        })()}
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
          {/* Stage 3A: the way into the secure audio call. Admission (window +
              participant check) is decided by the server; the page opens the
              pre-join screen and the server issues a short-lived token. */}
          {booking.status === 'confirmed' && !ended && (
            <div className="col" style={{ gap: 4 }}>
              <Link to={`/conversations/${booking.id}/call`} className="btn btn-primary" style={{ alignSelf: 'flex-start' }}>
                <Phone size={18} aria-hidden="true" /> Join the audio call
              </Link>
              <span className="faint">
                Audio only · opens ten minutes before your conversation starts · not recorded.
              </span>
            </div>
          )}
          {/* 2F2B: messaging opens for confirmed/completed conversations.
              The server re-checks eligibility and participation. */}
          {['confirmed', 'completed'].includes(booking.status) && (
            <MessageActionButton
              memberProfileId={booking.member_profile_id}
              companionProfileId={booking.companion_profile_id}
              label={isCompanionSide
                ? `Message ${booking.member_first_name}`
                : `Message ${booking.companion_first_name}`}
            />
          )}
        </div>
      </section>

      {/* Funded, ended conversations get EXACTLY ONE post-conversation card
          per role. Each card self-hides unless the server confirms the
          booking is funded & eligible, so the legacy CompletionPanel /
          RatingPanel below are additionally gated on `funded === false`.

          Member side → the single combined outcome + review card. */}
      {!isCompanionSide && isRequesterSide && ended && (
        <section className="section-tight">
          <CoordinatorPostConversationCard
            bookingId={booking.id}
            memberName={booking.member_first_name}
            companionName={booking.companion_first_name}
            onConfirmed={() => void load()}
          />
        </section>
      )}

      {/* Companion side → ONLY the 2G4B attendance card (no status gate, so a
          funded booking the old flow moved confirmed → completed still shows
          it; the card self-hides unless ended & funded). */}
      {isCompanionSide && ended && (
        <section className="section-tight">
          <AttendanceCard bookingId={booking.id} memberName={booking.member_first_name} onConfirmed={() => void load()} />
        </section>
      )}

      {/* Redesign Phase C: guest access for the managed Member. Only the
          member-side (Coordinator) sees this; the server re-checks. */}
      {booking.status === 'confirmed' && !ended && isRequesterSide && !isCompanionSide && (
        <section className="section-tight">
          <GuestInvitationPanel bookingId={booking.id} memberName={booking.member_first_name} />
        </section>
      )}

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

      {/* Legacy completion (2E1B) + rating (2E2B). These are the OLD mutual
          "Did it take place?" + direct-`ratings` writer. For a funded booking
          they are fully replaced by the single role card above, so they are
          shown ONLY when the server explicitly says the booking is NOT funded
          (`funded === false`) — i.e. a historical/mock non-funded record.
          While unknown (null) or funded (true) neither renders, so a funded
          conversation never shows two overlapping completion systems. */}
      {funded === false && <CompletionPanel booking={booking} onStatusChange={() => void load()} />}
      {funded === false && <RatingPanel booking={booking} />}

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
    const to = new Date(Date.now() + SLOT_WINDOW_DAYS * 86400_000).toISOString();
    getAllAvailablePackageSlots(purchaseId, from, to)
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
      emptyMessage="No free times found."
    />
  );
}
