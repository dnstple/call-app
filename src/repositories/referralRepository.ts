/**
 * Referrals — a pilot participant invites others; the invitee redeems the code
 * to move from waitlist to pilot. Server (0118) holds all authority; the client
 * only reflects it. RPC names aren't in the generated types yet, so a loose cast
 * is used (mirrors homeRepository).
 */
import { getSupabaseClient } from '../supabase/client';

export interface MyReferral {
  code: string;
  uses: number;
  max_uses: number;
  remaining: number;
  accepted: number;
}

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const client = getSupabaseClient() as unknown as {
    rpc: (fn: string, params?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  };
  const { data, error } = await client.rpc(name, args);
  if (error) throw error;
  return data as T;
}

export function myReferral(): Promise<MyReferral> {
  return rpc<MyReferral>('my_referral_code');
}

export async function redeemReferral(code: string): Promise<void> {
  await rpc('redeem_referral_code', { p_code: code });
}

/** Map the server's stable hints/codes to calm, non-technical copy. */
export function referralErrorMessage(e: unknown): string {
  const err = e as { hint?: string; message?: string } | null;
  const key = (err?.hint || err?.message || '').toLowerCase();
  if (key.includes('referral_invalid')) return 'That code isn’t valid. Please check it and try again.';
  if (key.includes('referral_exhausted')) return 'That invite has already been fully used.';
  if (key.includes('referral_self')) return 'You can’t use your own invite code.';
  if (key.includes('referral_already_used')) return 'You’ve already used an invite code.';
  if (key.includes('referral_not_needed')) return 'You already have access — no code needed.';
  if (key.includes('referral_unavailable')) return 'This code can’t be applied to your account.';
  if (key.includes('referral_not_eligible')) return 'Only members can invite others yet.';
  return 'We couldn’t apply that code just now. Please try again.';
}

// ---------------------------------------------------------------------------
// 0226 — invite links that work for any new account (attribution only).
// ---------------------------------------------------------------------------
export interface ReferralPreview {
  valid: boolean;
  first_name?: string | null;
  referrer_role?: string | null;
  companion_profile_id?: string | null;
}
export interface MyReferrer { first_name: string | null; companion_profile_id: string | null }
export interface ReferralStats { joined: number; booked: number; paying: number }
export interface ReferralOverviewRow {
  referrer_account_id: string; referrer_name: string | null; referrer_role: string | null; code: string;
  joined: number; booked: number; paying: number; paid_calls: number; last_joined_at: string | null;
}

export function previewReferral(code: string): Promise<ReferralPreview> {
  return rpc<ReferralPreview>('referral_preview', { p_code: code });
}
export function attachReferral(code: string): Promise<{ ok: boolean; reason?: string }> {
  return rpc<{ ok: boolean; reason?: string }>('attach_referral', { p_code: code });
}
export function myReferrer(): Promise<MyReferrer | null> {
  return rpc<MyReferrer | null>('my_referrer');
}
export function myReferralStats(): Promise<ReferralStats> {
  return rpc<ReferralStats>('my_referral_stats');
}
export function supportReferralOverview(): Promise<ReferralOverviewRow[]> {
  return rpc<ReferralOverviewRow[]>('support_referral_overview');
}
