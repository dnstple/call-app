import { useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, Flag, XCircle } from 'lucide-react';
import type { Booking, CompletionOutcome, User } from '../types';
import { useAppState } from '../state/store';
import { currentUser, userById } from '../state/selectors';
import {
  acceptProposedTime,
  cancelBooking,
  recordOutcome,
  reportUser,
  rescheduleBooking,
  respondToRequest,
  submitRating,
} from '../state/actions';
import { MEDIUM_LABELS, formatDateTime, formatTime } from '../domain/format';
import { formatPence } from '../domain/commission';
import { generateSlots, toDateString, type Slot } from '../domain/availability';
import {
  ConfirmDialog,
  Modal,
  OverflowMenu,
  ProfilePhoto,
  StarInput,
  StatusBadge,
  type MenuItem,
} from './ui';

type DialogKind =
  | null
  | 'cancel'
  | 'reschedule'
  | 'outcome'
  | 'rate'
  | 'report'
  | 'propose'
  | 'details';

/* ================= Shared hooks/logic ================= */

function useBookingContext(booking: Booking) {
  const state = useAppState();
  const me = currentUser(state);
  const member = userById(state, booking.memberId);
  const companion = userById(state, booking.companionId);
  const otherParty = me.id === booking.companionId ? member : companion;
  const iAmParticipant = me.id === booking.memberId || me.id === booking.companionId;
  const isCompanionView = me.id === booking.companionId;
  const myConfirmation = state.confirmations.find(
    (c) => c.bookingId === booking.id && c.userId === me.id,
  );
  const otherConfirmed = state.confirmations.some(
    (c) => c.bookingId === booking.id && c.userId !== me.id,
  );
  const canRate =
    booking.status === 'completed' &&
    (me.id === booking.memberId || me.id === booking.coordinatorId);
  const hasRated =
    companion !== undefined &&
    state.ratings.some((r) => r.active && r.reviewerId === me.id && r.revieweeId === companion.id);
  return {
    state,
    me,
    member,
    companion,
    otherParty,
    iAmParticipant,
    isCompanionView,
    myConfirmation,
    otherConfirmed,
    canRate,
    hasRated,
  };
}

/** One natural-language line: time, duration, method (+ source when relevant). */
function summaryLine(booking: Booking): string {
  const parts = [
    `${formatTime(booking.start)}`,
    `${booking.durationMins} mins`,
    MEDIUM_LABELS[booking.medium],
  ];
  if (booking.isTrial) parts.push(`trial ${booking.pricePence > 0 ? formatPence(booking.pricePence) : ''}`.trim());
  else if (booking.offerKind === 'package') parts.push('plan credit');
  return parts.join(' · ');
}

/* ================= Conversation row ================= */

export function ConversationRow({ booking }: { booking: Booking }) {
  const ctx = useBookingContext(booking);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const { me, member, companion, otherParty, isCompanionView, iAmParticipant, myConfirmation, otherConfirmed, canRate, hasRated } = ctx;

  if (!member || !companion || !otherParty) return null;

  const subdued = ['cancelled', 'missed'].includes(booking.status);
  const start = new Date(booking.start);

  // One contextual action per row.
  let contextual: { label: string; primary?: boolean; onClick: () => void } | null = null;
  if (booking.status === 'requested' && isCompanionView && !booking.proposedStart) {
    contextual = { label: 'Accept', primary: true, onClick: () => respondToRequest(booking.id, 'accept') };
  } else if (booking.status === 'requested' && !isCompanionView && booking.proposedStart) {
    contextual = { label: 'Accept new time', primary: true, onClick: () => acceptProposedTime(booking.id) };
  } else if (booking.status === 'awaiting_completion' && iAmParticipant && !myConfirmation) {
    contextual = { label: 'Confirm', primary: true, onClick: () => setDialog('outcome') };
  } else if (canRate && !hasRated) {
    contextual = { label: 'Rate', primary: true, onClick: () => setDialog('rate') };
  } else if (booking.status === 'confirmed') {
    contextual = { label: 'Reschedule', onClick: () => setDialog('reschedule') };
  }

  // Everything else lives in the overflow menu / details.
  const menuItems: MenuItem[] = [];
  menuItems.push({ label: 'View details', icon: <CalendarClock size={18} aria-hidden="true" />, onSelect: () => setDialog('details') });
  if (booking.status === 'requested' && isCompanionView && !booking.proposedStart) {
    menuItems.push({ label: 'Propose a new time', icon: <CalendarClock size={18} aria-hidden="true" />, onSelect: () => setDialog('propose') });
    menuItems.push({ label: 'Decline', icon: <XCircle size={18} aria-hidden="true" />, destructive: true, onSelect: () => respondToRequest(booking.id, 'decline') });
  }
  if (booking.status === 'requested' && !isCompanionView) {
    menuItems.push({ label: 'Withdraw request', icon: <XCircle size={18} aria-hidden="true" />, destructive: true, onSelect: () => setDialog('cancel') });
  }
  if (booking.status === 'confirmed') {
    menuItems.push({ label: 'Cancel conversation', icon: <XCircle size={18} aria-hidden="true" />, destructive: true, onSelect: () => setDialog('cancel') });
  }
  if (canRate && hasRated) {
    menuItems.push({ label: 'Update rating', icon: <CalendarClock size={18} aria-hidden="true" />, onSelect: () => setDialog('rate') });
  }
  menuItems.push({ label: 'Report a concern', icon: <Flag size={18} aria-hidden="true" />, destructive: true, onSelect: () => setDialog('report') });

  return (
    <article className={`card card-tight convo-row ${subdued ? 'subdued' : ''}`}>
      <div className="date-block" aria-hidden="true">
        <div className="m">{start.toLocaleDateString('en-GB', { month: 'short' })}</div>
        <div className="d">{start.getDate()}</div>
      </div>
      <div className="body col" style={{ gap: 4 }}>
        <div className="row wrap" style={{ gap: 8 }}>
          <span className="bold">
            {me.id === booking.memberId ? companion.firstName : me.id === booking.companionId ? member.firstName : `${member.firstName} & ${companion.firstName}`}
          </span>
          <StatusBadge status={booking.status} />
        </div>
        <span className="muted small">{summaryLine(booking)}</span>
        {booking.status === 'awaiting_completion' && myConfirmation && !otherConfirmed && (
          <span className="faint">Waiting for the other person to confirm.</span>
        )}
        {booking.proposedStart && booking.status === 'requested' && (
          <span className="faint">New time suggested: {formatDateTime(booking.proposedStart)}</span>
        )}
      </div>
      {contextual && (
        <button
          className={`btn btn-small ${contextual.primary ? 'btn-primary' : 'btn-secondary'}`}
          onClick={contextual.onClick}
        >
          {contextual.label}
        </button>
      )}
      <OverflowMenu items={menuItems} label={`More options for conversation with ${otherParty.firstName}`} />

      <RowDialogs booking={booking} ctx={ctx} dialog={dialog} setDialog={setDialog} />
    </article>
  );
}

/* ================= Primary feature card (Home) ================= */

export function NextConversationCard({ booking }: { booking: Booking }) {
  const ctx = useBookingContext(booking);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const { me, member, companion, otherParty, isCompanionView, iAmParticipant, myConfirmation } = ctx;
  if (!member || !companion || !otherParty) return null;

  const needsConfirm = booking.status === 'awaiting_completion' && iAmParticipant && !myConfirmation;
  const isRequestForMe = booking.status === 'requested' && isCompanionView && !booking.proposedStart;

  const heading = needsConfirm
    ? 'How did your conversation go?'
    : isRequestForMe
      ? 'New conversation request'
      : booking.status === 'requested'
        ? 'Waiting for a reply'
        : 'Your next conversation';

  const primary = needsConfirm
    ? { label: 'Confirm outcome', onClick: () => setDialog('outcome') }
    : isRequestForMe
      ? { label: 'Accept request', onClick: () => respondToRequest(booking.id, 'accept') }
      : { label: 'View details', onClick: () => setDialog('details') };

  const secondary =
    booking.status === 'confirmed'
      ? { label: 'Reschedule', onClick: () => setDialog('reschedule') }
      : isRequestForMe
        ? { label: 'Propose a new time', onClick: () => setDialog('propose') }
        : null;

  const menuItems: MenuItem[] = [];
  if (['confirmed', 'requested'].includes(booking.status)) {
    menuItems.push({
      label: booking.status === 'requested' && !isCompanionView ? 'Withdraw request' : 'Cancel conversation',
      icon: <XCircle size={18} aria-hidden="true" />,
      destructive: true,
      onSelect: () => setDialog('cancel'),
    });
  }
  menuItems.push({
    label: 'Report a concern',
    icon: <Flag size={18} aria-hidden="true" />,
    destructive: true,
    onSelect: () => setDialog('report'),
  });

  return (
    <section className="card card-feature" aria-label={heading}>
      <div className="row between mb-4">
        <h2 style={{ margin: 0 }}>{heading}</h2>
        <OverflowMenu items={menuItems} />
      </div>
      <div className="row" style={{ gap: 20, alignItems: 'flex-start' }}>
        <ProfilePhoto user={otherParty} size={72} radius={18} />
        <div className="col grow" style={{ gap: 4 }}>
          <span className="bold" style={{ fontSize: '1.15em' }}>
            {me.id === booking.memberId || me.id === booking.coordinatorId ? companion.firstName : member.firstName}
            {me.role === 'coordinator' && ` with ${member.firstName}`}
          </span>
          <span className="muted">{formatDateTime(booking.start)}</span>
          <span className="muted small">
            {booking.durationMins} minutes · {MEDIUM_LABELS[booking.medium]}
            {booking.isTrial ? ' · trial conversation' : booking.offerKind === 'package' ? ' · plan credit' : ''}
          </span>
        </div>
      </div>
      <div className="row wrap mt-5" style={{ gap: 12 }}>
        <button className="btn btn-primary" onClick={primary.onClick}>
          {primary.label}
        </button>
        {secondary && (
          <button className="btn btn-ghost" onClick={secondary.onClick}>
            {secondary.label}
          </button>
        )}
      </div>

      <RowDialogs booking={booking} ctx={ctx} dialog={dialog} setDialog={setDialog} />
    </section>
  );
}

/* ================= Dialog host ================= */

function RowDialogs({
  booking,
  ctx,
  dialog,
  setDialog,
}: {
  booking: Booking;
  ctx: ReturnType<typeof useBookingContext>;
  dialog: DialogKind;
  setDialog: (d: DialogKind) => void;
}) {
  const { me, companion, otherParty } = ctx;
  if (!dialog || !companion || !otherParty) return null;
  const close = () => setDialog(null);

  return (
    <>
      {dialog === 'cancel' && <CancelDialog booking={booking} onClose={close} />}
      {dialog === 'reschedule' && <RescheduleDialog booking={booking} onClose={close} />}
      {dialog === 'propose' && <ProposeDialog booking={booking} onClose={close} />}
      {dialog === 'outcome' && (
        <OutcomeDialog booking={booking} me={me} otherName={otherParty.firstName} onClose={close} />
      )}
      {dialog === 'rate' && (
        <RatingDialog booking={booking} reviewerId={me.id} reviewee={companion} onClose={close} />
      )}
      {dialog === 'report' && (
        <ReportDialog reportedUser={otherParty} bookingId={booking.id} onClose={close} />
      )}
      {dialog === 'details' && <DetailModal booking={booking} ctx={ctx} onClose={close} setDialog={setDialog} />}
    </>
  );
}

/* ================= Detail modal ================= */

function DetailModal({
  booking,
  ctx,
  onClose,
  setDialog,
}: {
  booking: Booking;
  ctx: ReturnType<typeof useBookingContext>;
  onClose: () => void;
  setDialog: (d: DialogKind) => void;
}) {
  const { state, me, member, companion, isCompanionView, iAmParticipant, myConfirmation, canRate, hasRated } = ctx;
  const purchase = booking.packagePurchaseId
    ? state.purchases.find((p) => p.id === booking.packagePurchaseId)
    : undefined;
  const offer = state.offers.find((o) => o.id === booking.offerId);

  return (
    <Modal title="Conversation details" onClose={onClose}>
      <div className="col" style={{ gap: 16 }}>
        <div className="row between wrap">
          <div className="bold">
            {member?.firstName} & {companion?.firstName}
          </div>
          <StatusBadge status={booking.status} />
        </div>
        <div className="muted">
          {formatDateTime(booking.start)} · {booking.durationMins} minutes · {MEDIUM_LABELS[booking.medium]}
        </div>
        <div className="muted small">
          {offer?.title}
          {booking.pricePence > 0 && ` · ${formatPence(booking.pricePence)}`}
          {purchase && ` · plan credit (${purchase.callsTotal - purchase.callsUsed} of ${purchase.callsTotal} remaining)`}
        </div>

        {booking.status === 'confirmed' && (
          <div className="banner banner-success small">
            Contact details are shared once a conversation is confirmed, with permission. They stay
            hidden in this prototype.
          </div>
        )}
        {booking.status === 'needs_review' && (
          <div className="banner banner-danger small">
            <AlertTriangle size={18} aria-hidden="true" style={{ flex: 'none' }} />
            This conversation is with our (simulated) support team for review.
          </div>
        )}
        {booking.status === 'cancelled' && booking.cancelReason && (
          <div className="muted small">Cancelled — {booking.cancelReason}</div>
        )}

        <div className="row wrap" style={{ gap: 10 }}>
          {booking.status === 'requested' && isCompanionView && !booking.proposedStart && (
            <>
              <button className="btn btn-primary btn-small" onClick={() => { onClose(); respondToRequest(booking.id, 'accept'); }}>Accept</button>
              <button className="btn btn-secondary btn-small" onClick={() => setDialog('propose')}>Propose new time</button>
              <button className="btn btn-danger btn-small" onClick={() => { onClose(); respondToRequest(booking.id, 'decline'); }}>Decline</button>
            </>
          )}
          {booking.status === 'confirmed' && (
            <>
              <button className="btn btn-secondary btn-small" onClick={() => setDialog('reschedule')}>Reschedule</button>
              <button className="btn btn-danger btn-small" onClick={() => setDialog('cancel')}>Cancel</button>
            </>
          )}
          {booking.status === 'requested' && !isCompanionView && (
            <button className="btn btn-danger btn-small" onClick={() => setDialog('cancel')}>Withdraw request</button>
          )}
          {booking.status === 'awaiting_completion' && iAmParticipant && !myConfirmation && (
            <button className="btn btn-primary btn-small" onClick={() => setDialog('outcome')}>Confirm outcome</button>
          )}
          {canRate && (
            <button className="btn btn-primary btn-small" onClick={() => setDialog('rate')}>
              {hasRated ? 'Update rating' : 'Rate'}
            </button>
          )}
          <button className="btn btn-danger btn-small" onClick={() => setDialog('report')}>Report a concern</button>
        </div>

        <div>
          <h4>History</h4>
          <div className="col" style={{ gap: 6 }}>
            {booking.history.map((h, i) => (
              <div key={i} className="faint">
                {formatDateTime(h.at)} — {h.event}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ================= Individual dialogs ================= */

function CancelDialog({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  return (
    <ConfirmDialog
      title="Cancel this conversation?"
      body={
        <p>
          {formatDateTime(booking.start)} — cancelling more than 24 hours ahead returns the full
          simulated payment or plan credit. Closer to the time, the (simulated) cancellation policy applies.
        </p>
      }
      confirmLabel="Cancel conversation"
      danger
      onConfirm={() => {
        cancelBooking(booking.id, 'Cancelled in prototype');
        onClose();
      }}
      onClose={onClose}
    />
  );
}

function SlotPicker({
  companionId,
  durationMins,
  ignoreBookingId,
  onPick,
}: {
  companionId: string;
  durationMins: number;
  ignoreBookingId?: string;
  onPick: (slot: Slot) => void;
}) {
  const state = useAppState();
  const [selected, setSelected] = useState<Slot | null>(null);
  const slots = useMemo(
    () =>
      generateSlots(
        state.availabilityRules,
        state.availabilityExceptions,
        state.bookings.filter((b) => b.id !== ignoreBookingId),
        companionId,
        durationMins,
        new Date(),
        14,
      ),
    [state, companionId, durationMins, ignoreBookingId],
  );
  const byDay = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const s of slots) {
      const key = toDateString(new Date(s.startISO));
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return [...map.entries()].slice(0, 5);
  }, [slots]);

  return (
    <div className="col" style={{ gap: 16 }}>
      {byDay.length === 0 && (
        <div className="banner">No alternative times available in the next two weeks.</div>
      )}
      {byDay.map(([day, daySlots]) => (
        <div key={day}>
          <h4>{new Date(day).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</h4>
          <div className="slot-grid">
            {daySlots.slice(0, 6).map((s) => (
              <button
                key={s.startISO}
                className="slot-btn"
                aria-pressed={selected?.startISO === s.startISO}
                onClick={() => setSelected(s)}
              >
                {formatTime(s.startISO)}
              </button>
            ))}
          </div>
        </div>
      ))}
      <button className="btn btn-primary" disabled={!selected} onClick={() => selected && onPick(selected)}>
        Confirm time
      </button>
    </div>
  );
}

function RescheduleDialog({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Reschedule conversation" onClose={onClose}>
      <p className="muted">
        Currently {formatDateTime(booking.start)}. Everyone involved is notified of changes.
      </p>
      {error && <div className="banner banner-danger mb-4" role="alert">{error}</div>}
      <SlotPicker
        companionId={booking.companionId}
        durationMins={booking.durationMins}
        ignoreBookingId={booking.id}
        onPick={(slot) => {
          const res = rescheduleBooking(booking.id, slot.startISO);
          if (!res.ok) setError(res.error ?? 'Could not reschedule');
          else onClose();
        }}
      />
    </Modal>
  );
}

function ProposeDialog({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  return (
    <Modal title="Propose a different time" onClose={onClose}>
      <p className="muted">The requester will be asked to accept your suggested time.</p>
      <SlotPicker
        companionId={booking.companionId}
        durationMins={booking.durationMins}
        ignoreBookingId={booking.id}
        onPick={(slot) => {
          respondToRequest(booking.id, 'propose', slot.startISO);
          onClose();
        }}
      />
    </Modal>
  );
}

function OutcomeDialog({
  booking,
  me,
  otherName,
  onClose,
}: {
  booking: Booking;
  me: User;
  otherName: string;
  onClose: () => void;
}) {
  const [outcome, setOutcome] = useState<CompletionOutcome | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const options: { value: CompletionOutcome; label: string; hint: string }[] = [
    { value: 'completed', label: 'It happened — all good', hint: 'The conversation took place as planned.' },
    { value: 'did_not_happen', label: 'It didn’t happen', hint: 'The call never took place.' },
    { value: 'concern', label: 'I’d like to raise a concern', hint: 'Something didn’t feel right. Support will review it with care.' },
  ];
  return (
    <Modal title="How did the conversation go?" onClose={onClose}>
      <div className="col" style={{ gap: 12 }}>
        {options.map((o) => (
          <button
            key={o.value}
            className="card card-tight card-click card-selectable"
            style={{ textAlign: 'left' }}
            aria-pressed={outcome === o.value}
            onClick={() => setOutcome(o.value)}
          >
            <div className="bold">{o.label}</div>
            <div className="faint">{o.hint}</div>
          </button>
        ))}
        {outcome === 'concern' && (
          <div className="field">
            <label htmlFor="concern-note">Tell us what happened (kept private)</label>
            <textarea id="concern-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        )}
        <p className="faint">
          Both people record an outcome. When you and {otherName} agree, the conversation is finalised;
          if you disagree, our (simulated) support team reviews it.
        </p>
        <div className="row between">
          <button className="btn btn-ghost" onClick={onClose}>Not now</button>
          <button
            className="btn btn-primary"
            disabled={!outcome || busy}
            onClick={() => {
              if (!outcome || busy) return;
              setBusy(true);
              recordOutcome(booking.id, me.id, outcome, note || undefined);
              onClose();
            }}
          >
            Save outcome
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function RatingDialog({
  booking,
  reviewerId,
  reviewee,
  onClose,
}: {
  booking: Booking;
  reviewerId: string;
  reviewee: User;
  onClose: () => void;
}) {
  const state = useAppState();
  const existing = state.ratings.find(
    (r) => r.active && r.reviewerId === reviewerId && r.revieweeId === reviewee.id,
  );
  const [stars, setStars] = useState(existing?.stars ?? 0);
  const [publicComment, setPublicComment] = useState(existing?.publicComment ?? '');
  const [privateFeedback, setPrivateFeedback] = useState(existing?.privateFeedback ?? '');
  const [busy, setBusy] = useState(false);

  return (
    <Modal title={`Rate ${reviewee.firstName}`} onClose={onClose}>
      <div className="col" style={{ gap: 12 }}>
        {existing && (
          <div className="banner small">
            You’ve rated {reviewee.firstName} before ({existing.stars}★). One person, one rating —
            saving updates your existing rating.
          </div>
        )}
        <StarInput value={stars} onChange={setStars} />
        <div className="field">
          <label htmlFor="rate-public">Public comment (optional)</label>
          <textarea
            id="rate-public"
            value={publicComment}
            onChange={(e) => setPublicComment(e.target.value)}
            placeholder="Shown on their profile"
          />
        </div>
        <div className="field">
          <label htmlFor="rate-private">Private feedback (optional)</label>
          <textarea
            id="rate-private"
            value={privateFeedback}
            onChange={(e) => setPrivateFeedback(e.target.value)}
            placeholder="Only seen by the platform team"
          />
        </div>
        <div className="row between">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={stars === 0 || busy}
            onClick={() => {
              if (busy) return;
              setBusy(true);
              submitRating({
                reviewerId,
                revieweeId: reviewee.id,
                bookingId: booking.id,
                stars,
                publicComment: publicComment || undefined,
                privateFeedback: privateFeedback || undefined,
              });
              onClose();
            }}
          >
            {existing ? 'Update rating' : 'Submit rating'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function ReportDialog({
  reportedUser,
  bookingId,
  onClose,
}: {
  reportedUser: User;
  bookingId?: string;
  onClose: () => void;
}) {
  const [category, setCategory] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const categories = [
    'Asked for money or financial details',
    'Tried to move payment off the platform',
    'Unkind or inappropriate behaviour',
    'Repeated missed calls',
    'Safety worry about the other person',
    'Something else',
  ];
  return (
    <Modal title={`Report a concern about ${reportedUser.firstName}`} onClose={onClose}>
      <div className="col" style={{ gap: 12 }}>
        <div className="banner banner-danger small">
          <AlertTriangle size={18} aria-hidden="true" style={{ flex: 'none' }} />
          <span>
            <strong>This is not an emergency service.</strong> If someone is in immediate danger, call
            999. For urgent health concerns, contact their GP or NHS 111.
          </span>
        </div>
        <div className="field">
          <label htmlFor="report-cat">What happened?</label>
          <select id="report-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Choose a category…</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="report-details">Details</label>
          <textarea id="report-details" value={details} onChange={(e) => setDetails(e.target.value)} />
          <span className="hint">Reports are private and reviewed by a person. In the prototype this is simulated.</span>
        </div>
        <div className="row between">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            style={{ background: 'var(--danger)' }}
            disabled={!category || busy}
            onClick={() => {
              if (busy) return;
              setBusy(true);
              reportUser(reportedUser.id, category, details, bookingId);
              onClose();
            }}
          >
            Submit report
          </button>
        </div>
      </div>
    </Modal>
  );
}
