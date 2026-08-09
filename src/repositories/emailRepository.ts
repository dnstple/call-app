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

/* -------- Marketing broadcast (admin-only, via marketing-broadcast fn) -------- */

export interface MarketingResult {
  ok: boolean;
  message: string;
}

async function callMarketing(body: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const { data, error } = await getSupabaseClient().functions.invoke('marketing-broadcast', { body });
  if (error) return { ok: false, data: { error: 'request_failed' } };
  const r = (data ?? {}) as Record<string, unknown>;
  return { ok: Boolean(r.ok), data: r };
}

/** Push active users into the Resend marketing audience. */
export async function syncMarketingAudience(): Promise<MarketingResult> {
  const { ok, data } = await callMarketing({ action: 'sync' });
  if (!ok) return { ok: false, message: String(data.detail ?? data.error ?? 'Sync failed.') };
  return { ok: true, message: `Synced audience: ${data.added} added, ${data.skipped} skipped (${data.scanned} scanned).` };
}

/** Send the campaign to the configured test recipient only. */
export async function sendMarketingTest(subject?: string): Promise<MarketingResult> {
  const { ok, data } = await callMarketing({ action: 'test', subject });
  if (!ok) return { ok: false, message: String(data.detail ?? data.error ?? 'Test send failed.') };
  return { ok: true, message: `Test sent to ${data.recipient}.` };
}

/** Send the campaign to EVERYONE in the audience. Requires the SEND confirmation. */
export async function sendMarketingCampaign(subject?: string): Promise<MarketingResult> {
  const { ok, data } = await callMarketing({ action: 'send', subject, confirm: 'SEND' });
  if (!ok) return { ok: false, message: String(data.detail ?? data.error ?? 'Campaign send failed.') };
  return { ok: true, message: `Campaign sent (broadcast ${data.broadcast_id}).` };
}

/** Post an IN-APP notification to every Companion whose profile isn't publishable yet. */
export async function nudgeIncompleteCompanions(): Promise<MarketingResult> {
  const client = getSupabaseClient() as unknown as {
    rpc: (fn: string) => Promise<{ data: unknown; error: unknown }>;
  };
  const { data, error } = await client.rpc('support_nudge_incomplete_companions');
  if (error) return { ok: false, message: 'Could not post the in-app notifications. Please try again.' };
  const r = (data ?? {}) as { ok?: boolean; notified?: number };
  if (!r.ok) return { ok: false, message: 'Could not notify companions.' };
  return { ok: true, message: `Sent an in-app message to ${r.notified ?? 0} incomplete companion(s).` };
}
