/**
 * Support-admin controls for the backup-companion / call-failover engine. All
 * logic is server-side (admin_* RPCs, each guarded by require_support()); this
 * is a thin typed wrapper.
 */
import { getSupabaseClient } from '../supabase/client';
import type { BackupFailoverConfig } from '../config/backupFailover';

type Rpc = { rpc: (fn: string, p?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> };
const client = () => getSupabaseClient() as unknown as Rpc;

function mapConfig(d: Record<string, unknown> | null | undefined): BackupFailoverConfig {
  const r = d ?? {};
  return {
    failoverEnabled: Boolean(r.failover_enabled),
    smsEnabled: Boolean(r.sms_enabled),
    primaryAcceptanceDeadlineMins: Number(r.primary_acceptance_deadline_mins ?? 120),
    backupSearchStartMins: Number(r.backup_search_start_mins ?? 240),
    initialBatchSize: Number(r.initial_batch_size ?? 4),
    emergencyBatchSize: Number(r.emergency_batch_size ?? 8),
  };
}

export async function getFailoverConfig(): Promise<BackupFailoverConfig | null> {
  const { data, error } = await client().rpc('admin_get_failover_config');
  if (error || !data) return null;
  return mapConfig(data as Record<string, unknown>);
}

export async function setFailoverConfig(patch: {
  failoverEnabled?: boolean; smsEnabled?: boolean;
  primaryDeadlineMins?: number; searchStartMins?: number;
  initialBatch?: number; emergencyBatch?: number;
}): Promise<BackupFailoverConfig | null> {
  const { data, error } = await client().rpc('admin_set_failover_config', {
    p_failover_enabled: patch.failoverEnabled ?? null,
    p_sms_enabled: patch.smsEnabled ?? null,
    p_primary_deadline_mins: patch.primaryDeadlineMins ?? null,
    p_search_start_mins: patch.searchStartMins ?? null,
    p_initial_batch: patch.initialBatch ?? null,
    p_emergency_batch: patch.emergencyBatch ?? null,
  });
  if (error || !data) return null;
  return mapConfig(data as Record<string, unknown>);
}

/**
 * Invoke the call-failover transport (SMS worker) directly with the admin's own
 * session — bypasses the cron/Vault wiring. Surfaces the real outcome so a Twilio
 * misconfiguration is visible instead of silent.
 */
export async function flushPendingSms(): Promise<{ ok: boolean; detail: string }> {
  const { data, error } = await getSupabaseClient().functions.invoke('call-failover', { body: {} });
  if (error) return { ok: false, detail: 'Could not reach the SMS worker — is the call-failover function deployed?' };
  const r = (data ?? {}) as Record<string, unknown>;
  if (r.skipped === 'sms_disabled') return { ok: false, detail: 'SMS is disabled — turn on “Enable SMS” first.' };
  if (r.error === 'twilio_not_configured') return { ok: false, detail: 'Twilio isn’t configured — set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER.' };
  if (r.error) return { ok: false, detail: `Worker error: ${String(r.error)}` };
  const sent = Number(r.sent_offers ?? 0) + Number(r.sent_notices ?? 0);
  const failed = Number(r.failed ?? 0);
  const skipped = Number(r.skipped ?? 0);
  if (sent === 0 && failed > 0) return { ok: false, detail: `Twilio rejected ${failed} message(s) — check the from-number is an SMS-capable Twilio number. See twilio_status on the offer.` };
  if (sent === 0 && skipped > 0) return { ok: false, detail: `${skipped} skipped — recipients have no verified phone.` };
  return { ok: true, detail: `Sent ${sent} message(s); ${failed} failed, ${skipped} skipped.` };
}

/** Run the window-aware backfill/tick now (idempotent). */
export async function runBackfill(): Promise<{ ok: boolean; detail: string }> {
  const { data, error } = await client().rpc('backfill_backup_failover');
  if (error) return { ok: false, detail: 'Backfill failed (is the feature enabled?).' };
  const r = (data ?? {}) as Record<string, unknown>;
  if (r.enabled === false) return { ok: true, detail: 'Feature is disabled — enable failover first, then run backfill.' };
  return { ok: true, detail: `Backfill ran — ${r.searches_started ?? 0} searches, ${r.failovers ?? 0} failovers, ${r.cover_required ?? 0} need cover.` };
}

export interface ActiveFailoverCall {
  booking_id: string;
  starts_at: string;
  duration_minutes: number;
  backup_state: string;
  status: string;
  member_first: string | null;
  companion_first: string | null;
  companion_last: string | null;
  offers_out: number;
  available_count: number;
}

export async function getActiveFailovers(): Promise<ActiveFailoverCall[]> {
  const { data, error } = await client().rpc('admin_failover_active');
  if (error || !data) return [];
  return (data as ActiveFailoverCall[]) ?? [];
}

export async function getFailoverOverview(bookingId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await client().rpc('admin_failover_overview', { p_booking: bookingId });
  if (error || !data) return null;
  return data as Record<string, unknown>;
}

export async function startBackupSearch(bookingId: string, emergency = false): Promise<boolean> {
  const { error } = await client().rpc('admin_start_backup_search', { p_booking: bookingId, p_emergency: emergency });
  return !error;
}

export async function switchNow(bookingId: string): Promise<{ ok: boolean; outcome: string }> {
  const { data, error } = await client().rpc('admin_switch_now', { p_booking: bookingId });
  if (error) return { ok: false, outcome: 'error' };
  return { ok: true, outcome: String((data as Record<string, unknown>)?.outcome ?? 'unknown') };
}

export async function keepPrimary(bookingId: string): Promise<boolean> {
  const { error } = await client().rpc('admin_keep_primary', { p_booking: bookingId });
  return !error;
}

export async function assignCompanion(bookingId: string, companionProfileId: string): Promise<{ ok: boolean; outcome: string }> {
  const { data, error } = await client().rpc('admin_assign_companion', { p_booking: bookingId, p_companion: companionProfileId });
  if (error) return { ok: false, outcome: 'error' };
  return { ok: true, outcome: String((data as Record<string, unknown>)?.outcome ?? 'unknown') };
}

/* ---------------- Manual (hand-picked) backups (0180) ---------------- */

export interface UpcomingCreditCall {
  booking_id: string;
  starts_at: string;
  duration_minutes: number;
  status: string;
  kind: string;
  backup_state: string | null;
  confirmation_deadline_at: string | null;
  member_first: string | null;
  companion_first: string | null;
  companion_last: string | null;
  primary_confirmed: boolean;
  reassigned: boolean;
  offers_live: number;
  available_count: number;
}

export async function getUpcomingCreditCalls(): Promise<UpcomingCreditCall[]> {
  const { data, error } = await client().rpc('admin_upcoming_credit_calls');
  if (error || !data) return [];
  return (data as UpcomingCreditCall[]) ?? [];
}

export interface CandidateCompanion {
  profile_id: string;
  first_name: string | null;
  last_name: string | null;
  is_free: boolean;
  has_phone: boolean;
  already_invited: boolean;
}

export async function getCandidateCompanions(bookingId: string): Promise<CandidateCompanion[]> {
  const { data, error } = await client().rpc('admin_candidate_companions', { p_booking: bookingId });
  if (error || !data) return [];
  return (data as CandidateCompanion[]) ?? [];
}

export async function offerBackup(bookingId: string, companionProfileId: string): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await client().rpc('admin_offer_backup', { p_booking: bookingId, p_companion: companionProfileId });
  if (error) return { ok: false, error: 'request_failed' };
  const r = (data ?? {}) as Record<string, unknown>;
  return { ok: Boolean(r.ok), error: r.error ? String(r.error) : undefined };
}
