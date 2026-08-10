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

export interface OnboardingNudgeConfig {
  enabled: boolean;
  cadence_days: number;
  max_reminders: number;
}

/** Read the account-setup reminder cadence config (support-admin only). */
export async function getOnboardingNudgeConfig(): Promise<OnboardingNudgeConfig | null> {
  const client = getSupabaseClient() as unknown as {
    rpc: (fn: string) => Promise<{ data: unknown; error: unknown }>;
  };
  const { data, error } = await client.rpc('admin_get_onboarding_nudge_config');
  if (error || !data) return null;
  const d = data as Partial<OnboardingNudgeConfig>;
  return {
    enabled: Boolean(d.enabled),
    cadence_days: Number(d.cadence_days ?? 7),
    max_reminders: Number(d.max_reminders ?? 8),
  };
}

/** Update the cadence config (any omitted field is left unchanged). */
export async function setOnboardingNudgeConfig(patch: Partial<OnboardingNudgeConfig>): Promise<OnboardingNudgeConfig | null> {
  const client = getSupabaseClient() as unknown as {
    rpc: (fn: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  };
  const { data, error } = await client.rpc('admin_set_onboarding_nudge_config', {
    p_enabled: patch.enabled ?? null,
    p_cadence_days: patch.cadence_days ?? null,
    p_max_reminders: patch.max_reminders ?? null,
  });
  if (error || !data) return null;
  const d = data as Partial<OnboardingNudgeConfig>;
  return { enabled: Boolean(d.enabled), cadence_days: Number(d.cadence_days ?? 7), max_reminders: Number(d.max_reminders ?? 8) };
}

/**
 * Trigger a run of the automated "finish setting up your account" email campaign
 * now (it also runs daily on its own). Admin-only server-side; sends only to
 * accounts that are DUE per the weekly cadence, cap and unsubscribe list.
 */
export async function nudgeIncompleteOnboarding(): Promise<MarketingResult> {
  const { data, error } = await getSupabaseClient().functions.invoke('nudge-incomplete-onboarding', { body: { limit: 200 } });
  if (error) return { ok: false, message: 'Could not run the account-setup reminder campaign. Please try again.' };
  const r = (data ?? {}) as { ok?: boolean; sent?: number; skipped?: number; failed?: number; total?: number };
  if (!r.ok) return { ok: false, message: 'The reminder campaign did not run.' };
  return { ok: true, message: `Reminder run complete — ${r.sent ?? 0} sent, ${r.skipped ?? 0} skipped (not due), ${r.failed ?? 0} failed.` };
}

/**
 * Trigger the "confirm your email" resend for people who signed up but never
 * confirmed (also runs daily). Sends a magic link that confirms + signs them in.
 */
export async function resendConfirmations(): Promise<MarketingResult> {
  const { data, error } = await getSupabaseClient().functions.invoke('resend-confirmations', { body: { limit: 200 } });
  if (error) return { ok: false, message: 'Could not run the confirmation resend. Please try again.' };
  const r = (data ?? {}) as { ok?: boolean; sent?: number; skipped?: number; failed?: number; scanned?: number; skipped_reason?: string };
  if (!r.ok) return { ok: false, message: 'The confirmation resend did not run.' };
  return { ok: true, message: `Confirmation resend complete — ${r.sent ?? 0} sent, ${r.skipped ?? 0} skipped (not due), ${r.failed ?? 0} failed.` };
}
