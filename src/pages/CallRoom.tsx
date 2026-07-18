/**
 * Stage 2E4D — /calls/:bookingId: the in-app call room boundary.
 *
 * Authenticated participants only: the booking loads through RLS-guarded
 * reads, so an unrelated account simply gets "not found". The page shows
 * who the conversation is with, when it happens and where it sits relative
 * to the (future) join window — and is honest that no provider is
 * integrated yet. See src/calls/CallProvider.ts for the integration seam.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Clock, Loader2, ShieldQuestion, Video } from 'lucide-react';
import { isSupabaseMode } from '../config/dataMode';
import { getBookingById } from '../repositories/bookingRepository';
import type { MyBookingRow } from '../supabase/database.types';
import { browserTimezone } from '../domain/timezones';
import { EmptyState } from '../components/ui';
import { IN_APP_CALL_EXPLAINER, IN_APP_CALL_LABEL } from '../components/FlowModal';
import { callWindowState, type CallWindowState } from '../calls/CallProvider';

const WINDOW_COPY: Record<CallWindowState, { title: string; body: string }> = {
  before: {
    title: 'Your conversation has not started yet',
    body: 'Your in-app conversation will be available here. Come back a little before the scheduled time.',
  },
  open: {
    title: 'In-app calling is being added',
    body: 'This page is ready for the call experience. Until it arrives, this room is a placeholder — the call cannot be joined yet.',
  },
  ended: {
    title: 'This conversation has ended',
    body: 'Thank you for talking. You can confirm how it went from the conversation page.',
  },
};

export default function CallRoom() {
  const { bookingId } = useParams();
  const navigate = useNavigate();
  const viewerTz = browserTimezone();
  const [booking, setBooking] = useState<MyBookingRow | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  useEffect(() => {
    if (!isSupabaseMode() || !bookingId) {
      setState('unavailable');
      return;
    }
    let live = true;
    getBookingById(bookingId)
      .then((b) => {
        if (!live) return;
        // RLS already restricts reads to participants; a null here means
        // "doesn't exist or not yours" — deliberately indistinguishable.
        setBooking(b);
        setState(b ? 'ready' : 'unavailable');
      })
      .catch(() => live && setState('unavailable'));
    return () => {
      live = false;
    };
  }, [bookingId]);

  if (state === 'loading') {
    return (
      <div className="row" style={{ gap: 10, padding: 48, justifyContent: 'center' }}>
        <Loader2 size={22} aria-hidden="true" />
        <span className="muted">Preparing your call room…</span>
      </div>
    );
  }

  if (state === 'unavailable' || !booking) {
    return (
      <EmptyState
        icon={<ShieldQuestion size={36} aria-hidden="true" />}
        title="This call isn’t available"
        body="The conversation doesn’t exist, or you’re not one of its participants."
        action={<Link to="/conversations" className="btn btn-primary">Go to Conversations</Link>}
      />
    );
  }

  const cancelled = ['cancelled', 'declined'].includes(booking.status);
  const windowState = cancelled ? 'ended' : callWindowState(booking.starts_at, booking.ends_at);
  const copy = cancelled
    ? { title: 'This conversation was cancelled', body: 'There is nothing to join — check the conversation page for details.' }
    : WINDOW_COPY[windowState];
  const when = new Intl.DateTimeFormat('en-GB', {
    timeZone: viewerTz, weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(booking.starts_at));

  return (
    <div className="col" style={{ gap: 14, maxWidth: 640 }}>
      <button className="btn btn-ghost btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => navigate(-1)}>
        <ArrowLeft size={18} aria-hidden="true" /> Back
      </button>

      <section className="card col" style={{ gap: 8, alignItems: 'center', textAlign: 'center', padding: 32 }}>
        <Video size={40} aria-hidden="true" />
        <h1 style={{ margin: 0, fontSize: 22 }}>
          {booking.member_first_name} &amp; {booking.companion_first_name}
          {booking.companion_last_initial ? ` ${booking.companion_last_initial}.` : ''}
        </h1>
        <span className="muted row" style={{ gap: 6 }}>
          <Clock size={16} aria-hidden="true" />
          {when} · {booking.duration_minutes} minutes · {IN_APP_CALL_LABEL}
        </span>
        <h2 style={{ margin: '10px 0 0' }}>{copy.title}</h2>
        <p className="muted longform" style={{ margin: 0 }}>{copy.body}</p>
        <p className="faint longform" style={{ margin: 0 }}>{IN_APP_CALL_EXPLAINER}</p>
        <Link to={`/conversations/${booking.id}`} className="btn btn-primary">
          View this conversation
        </Link>
      </section>
    </div>
  );
}
