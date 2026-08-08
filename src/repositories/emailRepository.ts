/**
 * Admin-only email validation. Invokes the server-side `email-test` Edge
 * Function, which requires a support admin and sends ONLY to the configured
 * EMAIL_TEST_RECIPIENT. The browser supplies no recipient, subject or HTML —
 * it merely asks the trusted function to run its fixed test.
 */
import { getSupabaseClient } from '../supabase/client';

export interface TestEmailResult {
  ok: boolean;
  testRunId?: string;
  recipient?: string;
  messageId?: string;
  error?: string;
}

export async function sendTestEmail(): Promise<TestEmailResult> {
  const { data, error } = await getSupabaseClient().functions.invoke('email-test', { body: {} });
  if (error) {
    return { ok: false, error: 'We couldn’t send the test email. Check the email provider configuration.' };
  }
  const r = (data ?? {}) as {
    ok?: boolean; test_run_id?: string; recipient?: string; message_id?: string; error?: string; detail?: string;
  };
  if (!r.ok) {
    return { ok: false, error: r.detail ?? r.error ?? 'The test email could not be sent.' };
  }
  return { ok: true, testRunId: r.test_run_id, recipient: r.recipient, messageId: r.message_id };
}
