/**
 * Block 2 (Trust & Safety) data path.
 *
 * Every call goes through a SECURITY DEFINER RPC (migrations 0088–0092) that
 * re-derives identity + authority server-side. The browser only names a profile,
 * conversation, category or free-text reason; it can NEVER set an approval
 * outcome, a financial hold, a report resolution or another user's block state.
 * Support-only readers re-check app_private.is_support_admin() on the server.
 */
import { getSupabaseClient } from '../supabase/client';
import { RepoError, type RepoErrorKind } from './profileRepository';

type Rpc = { rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> };
function db(): Rpc { return getSupabaseClient() as unknown as Rpc; }

export class TrustError extends RepoError {
  constructor(message: string, kind: RepoErrorKind = 'database') { super(message, kind); this.name = 'TrustError'; }
}
function fail(e: unknown): TrustError {
  const m = String((e as { message?: string })?.message ?? '').toLowerCase();
  if (m.includes('unauthorised') || m.includes('not_found')) return new TrustError('You don’t have permission to do that.', 'not_found');
  if (m.includes('consent')) return new TrustError('The current terms must be accepted first.', 'validation');
  if (m.includes('reason_required')) return new TrustError('Please provide a reason.', 'validation');
  if (m.includes('description_required')) return new TrustError('Please describe the concern.', 'validation');
  return new TrustError('Something went wrong. Please try again.', 'database');
}

/* ---------------- consent ---------------- */
export interface ConsentItem {
  profile_id: string; role: string; consent_type: string;
  current_version: number; satisfied: boolean; authority: string | null;
}
export async function getMyConsentStatus(): Promise<ConsentItem[]> {
  const { data, error } = await db().rpc('get_my_consent_status');
  if (error) throw fail(error);
  return ((data as { items?: ConsentItem[] })?.items ?? []);
}
export async function acknowledgeConsent(profileId: string, consentType: string): Promise<void> {
  const { error } = await db().rpc('acknowledge_consent', { p_profile: profileId, p_type: consentType });
  if (error) throw fail(error);
}

/* ---------------- reporting ---------------- */
export type ConcernCategory =
  | 'inappropriate_conduct' | 'safeguarding' | 'harassment'
  | 'suspected_fraud' | 'privacy' | 'technical_call_problem' | 'other';
export async function reportConcern(conversationId: string, category: ConcernCategory, description: string): Promise<{ concernId: string; status: string; already: boolean }> {
  const { data, error } = await db().rpc('report_conversation_concern', {
    p_conversation: conversationId, p_category: category, p_description: description,
  });
  if (error) throw fail(error);
  const r = data as { concern_id: string; status: string; already: boolean };
  return { concernId: r.concern_id, status: r.status, already: r.already };
}

/* ---------------- blocking ---------------- */
export async function createBlock(memberProfileId: string, companionProfileId: string, reason?: string): Promise<{ blockId: string; already: boolean }> {
  const { data, error } = await db().rpc('create_block', {
    p_member_profile: memberProfileId, p_companion_profile: companionProfileId, p_reason: reason ?? null,
  });
  if (error) throw fail(error);
  const r = data as { block_id: string; already: boolean };
  return { blockId: r.block_id, already: r.already };
}
export async function removeBlock(memberProfileId: string, companionProfileId: string): Promise<void> {
  const { error } = await db().rpc('remove_block', { p_member_profile: memberProfileId, p_companion_profile: companionProfileId });
  if (error) throw fail(error);
}

/* ---------------- companion moderation (self) ---------------- */
export interface MyCompanionModeration { hasCompanion: boolean; moderationStatus?: string; reason?: string | null }
export async function getMyCompanionModeration(): Promise<MyCompanionModeration> {
  const { data, error } = await db().rpc('get_my_companion_moderation');
  if (error) throw fail(error);
  const r = data as { has_companion: boolean; moderation_status?: string; reason?: string | null };
  return { hasCompanion: r.has_companion, moderationStatus: r.moderation_status, reason: r.reason };
}

/* ---------------- support (authorised) ---------------- */
export interface ModerationRow { profile_id: string; first_name: string; last_initial: string; moderation_status: string; completion_pct: number; moderated_at: string | null }
export async function supportModerationOverview(status?: string): Promise<ModerationRow[]> {
  const { data, error } = await db().rpc('support_companion_moderation_overview', { p_status: status ?? null });
  if (error) throw fail(error);
  return ((data as { companions?: ModerationRow[] })?.companions ?? []);
}
export async function supportSetModeration(profileId: string, status: 'pending' | 'approved' | 'suspended' | 'rejected', reason?: string): Promise<void> {
  const { error } = await db().rpc('support_set_companion_moderation', { p_profile: profileId, p_status: status, p_reason: reason ?? null });
  if (error) throw fail(error);
}
export interface ConcernRow { concern_id: string; conversation_id: string; booking_id: string | null; category: string; priority: string; state: string; reporter_role: string; earning_held: boolean; created_at: string }
export async function supportConcernsOverview(): Promise<ConcernRow[]> {
  const { data, error } = await db().rpc('support_concerns_overview');
  if (error) throw fail(error);
  return ((data as { concerns?: ConcernRow[] })?.concerns ?? []);
}
export async function supportResolveConcern(concernId: string, note?: string): Promise<void> {
  const { error } = await db().rpc('support_resolve_concern', { p_concern: concernId, p_note: note ?? null });
  if (error) throw fail(error);
}
export interface BlockRow { block_id: string; member_profile_id: string; companion_profile_id: string; direction: string; coordinator_authority: boolean; reason_category: string | null; created_at: string; removed_at: string | null }
export async function supportBlockOverview(): Promise<BlockRow[]> {
  const { data, error } = await db().rpc('support_block_overview', {});
  if (error) throw fail(error);
  return ((data as { blocks?: BlockRow[] })?.blocks ?? []);
}
export interface BlockConflictRow { block_id: string; member_profile_id: string; companion_profile_id: string; direction: string; booking_id: string; starts_at: string }
export async function supportBlockConflicts(): Promise<BlockConflictRow[]> {
  const { data, error } = await db().rpc('support_block_conflicts_overview');
  if (error) throw fail(error);
  return ((data as { conflicts?: BlockConflictRow[] })?.conflicts ?? []);
}
export interface ConsentAckRow { consent_type: string; policy_version: number; current_version: number; status: string; on_behalf: boolean; acknowledged_at: string; is_current: boolean }
export async function supportConsentStatus(profileId: string): Promise<ConsentAckRow[]> {
  const { data, error } = await db().rpc('support_consent_status', { p_profile: profileId });
  if (error) throw fail(error);
  return ((data as { acknowledgements?: ConsentAckRow[] })?.acknowledgements ?? []);
}
