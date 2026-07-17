/**
 * Corrective Stage 2E4B — the in-app call boundary: /calls/:bookingId.
 *
 * Every conversation happens inside the app. This route is the documented
 * seam where a calling provider (LiveKit, Daily, Twilio…) will attach —
 * NOT an implementation. It is deliberately honest: the room does not
 * work yet and says so.
 *
 * Future integration contract (kept provider-neutral on purpose):
 *
 *   interface CallProvider {
 *     // Mint a short-lived, server-signed join token for this booking.
 *     getJoinToken(bookingId: string): Promise<{ token: string; url: string }>;
 *     // Render/attach the room UI for that token.
 *     join(target: HTMLElement, token: string): Promise<CallSession>;
 *   }
 *
 * Rules for whoever implements it:
 *  - tokens are issued SERVER-side for booking participants only (RLS),
 *    scoped to the booking's time window; the browser never mints them;
 *  - joining must not change booking state — completion stays the
 *    two-sided confirmation flow (Stage 2E1A);
 *  - no provider identifiers or room URLs are stored on the booking until
 *    that milestone genuinely lands.
 */
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Video } from 'lucide-react';
import { EmptyState } from '../components/ui';
import { IN_APP_CALL_EXPLAINER } from '../components/FlowModal';

export default function CallRoom() {
  const { bookingId } = useParams();
  const navigate = useNavigate();

  return (
    <div>
      <button className="btn btn-ghost btn-small mb-4" onClick={() => navigate(-1)}>
        <ArrowLeft size={18} aria-hidden="true" /> Back
      </button>
      <EmptyState
        icon={<Video size={36} aria-hidden="true" />}
        title="In-app calling is coming soon"
        body={`${IN_APP_CALL_EXPLAINER} The call room isn’t built yet — this page marks where it will live. Your conversation details are on the booking page.`}
        action={
          bookingId ? (
            <Link to={`/conversations/${bookingId}`} className="btn btn-primary">
              View this conversation
            </Link>
          ) : (
            <Link to="/conversations" className="btn btn-primary">Go to Conversations</Link>
          )
        }
      />
    </div>
  );
}
