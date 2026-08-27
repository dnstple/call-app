/**
 * Role-specific agreement signing (restructure Phase 6). Button-press signing:
 * scroll to the end, press "I agree and sign". Records the exact key/version/role
 * server-side (0166).
 */
import { getSupabaseClient } from '../supabase/client';

function rpc() {
  return getSupabaseClient() as unknown as {
    rpc: (fn: string, p?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  };
}

export async function getRoleAgreementSigned(key: string, version: number): Promise<boolean> {
  try {
    const { data, error } = await rpc().rpc('my_role_agreement_status', { p_agreement_key: key, p_version: version });
    if (error) return true;   // fail open — never lock someone out on a read error
    return Boolean((data as { signed?: boolean })?.signed);
  } catch {
    return true;
  }
}

export async function recordRoleAgreement(role: string, key: string, version: number): Promise<boolean> {
  const { error } = await rpc().rpc('record_role_agreement', { p_role: role, p_agreement_key: key, p_version: version });
  return !error;
}
