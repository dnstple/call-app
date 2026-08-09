/**
 * Membership Agreement — reads the caller's consent status (0088) and records a
 * signed acknowledgement (0140) for every profile that still needs it. The
 * browser only names the profile + consent type; the server owns versions,
 * timestamps and enforcement.
 */
import { getSupabaseClient } from '../supabase/client';

export interface ConsentItem {
  profile_id: string;
  role: string;
  consent_type: string;
  current_version: number;
  satisfied: boolean;
  authority: string | null;
}

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const client = getSupabaseClient() as unknown as {
    rpc: (fn: string, params?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  };
  const { data, error } = await client.rpc(name, args);
  if (error) throw error;
  return data as T;
}

export async function getConsentItems(): Promise<ConsentItem[]> {
  const res = await rpc<{ ok: boolean; items: ConsentItem[] }>('get_my_consent_status');
  return res?.items ?? [];
}

/** True when the signed-in account (or a managed Member) still needs to sign. */
export async function needsAgreement(): Promise<boolean> {
  try {
    const items = await getConsentItems();
    return items.some((i) => i.authority !== null && !i.satisfied);
  } catch {
    return false; // never hard-block the app on a status read failure
  }
}

export interface SignInput {
  signedName: string;
  isProfessionalCarer: boolean;
  employerPermitted: boolean | null;
}

/** Sign the Agreement for every profile the caller is authorised to act for. */
export async function recordAgreement(input: SignInput): Promise<{ ok: boolean; signed: number }> {
  const items = await getConsentItems();
  const pending = items.filter((i) => i.authority !== null && !i.satisfied);
  if (pending.length === 0) return { ok: true, signed: 0 };
  for (const it of pending) {
    await rpc('record_membership_agreement', {
      p_profile: it.profile_id,
      p_consent_type: it.consent_type,
      p_signed_name: input.signedName,
      p_is_professional_carer: input.isProfessionalCarer,
      p_employer_permitted: input.employerPermitted,
    });
  }
  return { ok: true, signed: pending.length };
}
