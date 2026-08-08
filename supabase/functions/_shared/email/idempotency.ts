/**
 * Deterministic idempotency keys. The SAME logical email always produces the
 * SAME key, so a retry, a repeated webhook or a double-submit collapses to one
 * send (enforced by the unique DB index AND passed to Resend as Idempotency-Key).
 */
import type { EmailEvent } from './types.ts';

/** e.g. booking_requested/{booking_id}/{recipient_user_id} */
export function entityEmailKey(event: EmailEvent, entityId: string, recipientUserId: string): string {
  return `${event}/${entityId}/${recipientUserId}`;
}

/** e.g. test_email/{test_run_id} */
export function testEmailKey(testRunId: string): string {
  return `test_email/${testRunId}`;
}
