/**
 * Call-credit balance for a member (membership restructure). Reads the
 * server-side my_call_credits() RPC (0160), which returns only credits the
 * signed-in account may act for. Read-only.
 */
import { getSupabaseClient } from '../supabase/client';

export interface CreditBalance {
  balance: number;
  nextExpiry: string | null;
  expiringSoon: number;
}

export async function getCreditBalance(memberProfileId: string): Promise<CreditBalance | null> {
  const client = getSupabaseClient() as unknown as {
    rpc: (fn: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  };
  const { data, error } = await client.rpc('my_call_credits', { p_member_profile: memberProfileId });
  if (error || !data) return null;
  const d = data as { balance?: number; next_expiry?: string | null; expiring_soon?: number };
  return {
    balance: Number(d.balance ?? 0),
    nextExpiry: d.next_expiry ?? null,
    expiringSoon: Number(d.expiring_soon ?? 0),
  };
}
