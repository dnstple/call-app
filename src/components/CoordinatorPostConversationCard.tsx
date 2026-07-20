/**
 * The SINGLE combined Coordinator/member post-conversation card for a real
 * FUNDED Supabase booking (2G4C).
 *
 * Before this existed, the conversation detail rendered two overlapping
 * systems for the member side: the standalone review card AND the legacy
 * "Did this conversation take place?" completion panel. They are now merged
 * into one coherent flow here: for a funded conversation the OUTCOME and the
 * REVIEW are the same decision — approving ("Everything was fine") or rating
 * the conversation IS the successful-outcome confirmation, while a problem
 * surfaces as the server-managed "under review" state. The legacy
 * CompletionPanel / RatingPanel are no longer shown for funded bookings.
 *
 * ReviewCard is the server-authoritative engine (get_review_state /
 * submit_conversation_review → conversation_reviews); it self-hides unless the
 * booking is funded & eligible, so this card is always safe to render on the
 * member side of an ended conversation. Companion attendance stays entirely
 * separate in AttendanceCard.
 */
import { ReviewCard } from './ReviewCard';

export function CoordinatorPostConversationCard({ bookingId, memberName, companionName }: {
  bookingId: string;
  memberName: string;
  companionName: string;
}) {
  return (
    <ReviewCard bookingId={bookingId} memberName={memberName} companionName={companionName} />
  );
}
