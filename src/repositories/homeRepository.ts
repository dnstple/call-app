/**
 * Home recommendations + prompt-suppression data path.
 *
 * All matching authority is server-side (recommended_companions_for_member /
 * recommended_members_for_companion re-check relationship, product access,
 * visibility, blocks, moderation and offers). Dismissals are stored durably
 * (dismiss_home_prompt / my_home_dismissals) so "Not now" persists across
 * devices — never browser-local. The client only reflects what the server
 * returns; the Home feed is advisory and booking/message RPCs stay authoritative.
 */
import { getSupabaseClient } from '../supabase/client';

export interface CompanionMatch {
  companion_profile_id: string;
  display_name: string;
  bio_excerpt: string | null;
  photo_url: string | null;
  overlap: number;
  shared_interests: string[];
  offers_trial: boolean;
  from_price_minor: number | null;
  trial_price_minor: number | null;
  profile_ready: boolean;
}

export interface MemberSuggestion {
  member_profile_id: string;
  display_name: string;
  overlap: number;
  shared_interests: string[];
  relationship_status: 'none' | 'request_pending' | 'active';
}

export interface HomeDismissal {
  prompt_key: string;
  subject_profile_id: string | null;
  expires_at: string | null;
}

// These RPCs aren't in the generated database.types until types:generate runs
// post-apply; call through a loosely-typed client view (names are literal).
async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const client = getSupabaseClient() as unknown as {
    rpc: (fn: string, params?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  };
  const { data, error } = await client.rpc(name, args);
  if (error) throw error;
  return data as T;
}

export function recommendedCompanions(memberProfileId: string, limit = 4): Promise<CompanionMatch[]> {
  return rpc<CompanionMatch[]>('recommended_companions_for_member', {
    p_member_profile_id: memberProfileId, p_limit: limit,
  }).then((r) => r ?? []);
}

export function recommendedMembers(companionProfileId: string, limit = 4): Promise<MemberSuggestion[]> {
  return rpc<MemberSuggestion[]>('recommended_members_for_companion', {
    p_companion_profile_id: companionProfileId, p_limit: limit,
  }).then((r) => r ?? []);
}

export function dismissHomePrompt(promptKey: string, subject?: string, cooldownDays = 14): Promise<{ ok: boolean }> {
  return rpc('dismiss_home_prompt', { p_prompt_key: promptKey, p_subject: subject ?? null, p_cooldown_days: cooldownDays });
}

export function myHomeDismissals(): Promise<HomeDismissal[]> {
  return rpc<HomeDismissal[]>('my_home_dismissals').then((r) => r ?? []);
}

/** Was a (promptKey[, subject]) prompt dismissed and still within cooldown? */
export function isDismissed(dismissals: HomeDismissal[], promptKey: string, subject?: string | null): boolean {
  return dismissals.some((d) =>
    d.prompt_key === promptKey && (subject == null || d.subject_profile_id === subject));
}

/** "3 interests in common" / "1 interest in common" — natural grammar. */
export function sharedInterestLabel(count: number): string {
  return `${count} interest${count === 1 ? '' : 's'} in common`;
}
