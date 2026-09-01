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

/** Post the recruitment IN-APP message to every active companion. */
export async function recruitCompanionsInApp(): Promise<MarketingResult> {
  const client = getSupabaseClient() as unknown as {
    rpc: (fn: string) => Promise<{ data: unknown; error: unknown }>;
  };
  const { data, error } = await client.rpc('support_recruit_companions_inapp');
  if (error) return { ok: false, message: 'Could not post the in-app message. Please try again.' };
  const r = (data ?? {}) as { ok?: boolean; notified?: number };
  if (!r.ok) return { ok: false, message: 'Could not post the message.' };
  return { ok: true, message: `Posted the recruitment message to ${r.notified ?? 0} companion(s).` };
}

/** Send the recruitment EMAIL to every active companion (manual admin push). */
export async function sendCompanionRecruitEmail(): Promise<MarketingResult> {
  const { data, error } = await getSupabaseClient().functions.invoke('campaign-companion-recruit', { body: {} });
  if (error) return { ok: false, message: 'Could not send the recruitment email. Please try again.' };
  const r = (data ?? {}) as { ok?: boolean; sent?: number; skipped?: number; failed?: number };
  if (!r.ok) return { ok: false, message: 'The recruitment email did not send.' };
  return { ok: true, message: `Recruitment email — ${r.sent ?? 0} sent, ${r.skipped ?? 0} skipped, ${r.failed ?? 0} failed.` };
}

/* -------- Verify-phone reminder (admin-only, via campaign-verify-phone fn) ---- */

async function callVerifyPhone(body: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const { data, error } = await getSupabaseClient().functions.invoke('campaign-verify-phone', { body });
  if (error) return { ok: false, data: { error: 'request_failed' } };
  const r = (data ?? {}) as Record<string, unknown>;
  return { ok: Boolean(r.ok), data: r };
}

/** Preview the verify-your-mobile reminder to the configured test recipient only. */
export async function sendVerifyPhoneTest(subject?: string): Promise<MarketingResult> {
  const { ok, data } = await callVerifyPhone({ action: 'test', subject });
  if (!ok) return { ok: false, message: String(data.detail ?? data.error ?? 'Test send failed.') };
  return { ok: true, message: `Test sent to ${data.recipient}.` };
}

/** Email the verify-your-mobile reminder to every unverified account. Requires SEND. */
export async function sendVerifyPhoneCampaign(subject?: string): Promise<MarketingResult> {
  const { ok, data } = await callVerifyPhone({ action: 'send', subject, confirm: 'SEND' });
  if (!ok) return { ok: false, message: String(data.detail ?? data.error ?? 'Campaign send failed.') };
  return { ok: true, message: `Reminder sent — ${data.sent ?? 0} sent, ${data.skipped ?? 0} skipped, ${data.failed ?? 0} failed (of ${data.total ?? 0} unverified).` };
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
 * Preview the "book your first call" nudge audience WITHOUT sending — members
 * with no active membership. Returns how many would get email vs text.
 */
export async function previewFirstCallNudge(): Promise<MarketingResult> {
  const { data, error } = await getSupabaseClient().functions.invoke('nudge-book-first-call', { body: { dryRun: true } });
  if (error) return { ok: false, message: 'Could not check the first-call audience. Please try again.' };
  const r = (data ?? {}) as { ok?: boolean; audience?: number; would_email?: number; would_sms?: number };
  if (!r.ok) return { ok: false, message: 'Could not check the first-call audience.' };
  return { ok: true, message: `${r.audience ?? 0} member(s) would be nudged — ${r.would_email ?? 0} by email, ${r.would_sms ?? 0} by text. Nothing sent yet.` };
}

/**
 * Send the one-off "book your first call" nudge to members without an active
 * membership: in-app + email + SMS (verified mobiles only). Skips anyone already nudged.
 */
export async function sendFirstCallNudge(): Promise<MarketingResult> {
  const { data, error } = await getSupabaseClient().functions.invoke('nudge-book-first-call', { body: { limit: 1000 } });
  if (error) return { ok: false, message: 'Could not run the first-call nudge. Please try again.' };
  const r = (data ?? {}) as { ok?: boolean; audience?: number; in_app?: number; emails?: number; texts?: number; email_failed?: number; sms_failed?: number };
  if (!r.ok) return { ok: false, message: 'The first-call nudge did not run.' };
  const fails = (r.email_failed ?? 0) + (r.sms_failed ?? 0);
  return {
    ok: true,
    message: `First-call nudge complete — ${r.in_app ?? 0} in-app, ${r.emails ?? 0} email, ${r.texts ?? 0} text sent`
      + (fails > 0 ? ` (${r.email_failed ?? 0} email / ${r.sms_failed ?? 0} sms failed).` : '.'),
  };
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
