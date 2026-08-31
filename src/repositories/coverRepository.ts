/**
 * Backup-cover response (companion side of the call-failover feature). Reached
 * from the SMS link with an offer id + single-purpose token, so it works without
 * a login. All logic is server-side (get_backup_offer / respond_backup_offer);
 * before assignment we only ever expose date/time/duration — never member info.
 */
import { getSupabaseClient, isSupabaseConfigured } from '../supabase/client';

export interface BackupOfferView {
  ok: boolean;
  state: string; // offered / available / declined / expired / released / selected / not_found / forbidden
  batch?: 'initial' | 'emergency';
  startsAt?: string;
  durationMinutes?: number;
  timezone?: string;
  isOpen?: boolean;
}

type Rpc = { rpc: (fn: string, p: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }> };

export async function getBackupOffer(offerId: string, token: string): Promise<BackupOfferView> {
  if (!isSupabaseConfigured()) return { ok: false, state: 'not_found' };
  const client = getSupabaseClient() as unknown as Rpc;
  const { data, error } = await client.rpc('get_backup_offer', { p_offer: offerId, p_token: token });
  if (error) return { ok: false, state: 'error' };
  const d = (data ?? {}) as Record<string, unknown>;
  return {
    ok: Boolean(d.ok),
    state: String(d.state ?? 'error'),
    batch: d.batch as 'initial' | 'emergency' | undefined,
    startsAt: d.starts_at as string | undefined,
    durationMinutes: d.duration_minutes as number | undefined,
    timezone: d.timezone as string | undefined,
    isOpen: Boolean(d.is_open),
  };
}

export async function respondBackupOffer(
  offerId: string,
  token: string,
  available: boolean,
): Promise<{ ok: boolean; state: string }> {
  if (!isSupabaseConfigured()) return { ok: false, state: 'error' };
  const client = getSupabaseClient() as unknown as Rpc;
  const { data, error } = await client.rpc('respond_backup_offer', {
    p_offer: offerId, p_token: token, p_available: available,
  });
  if (error) return { ok: false, state: 'error' };
  const d = (data ?? {}) as Record<string, unknown>;
  return { ok: Boolean(d.ok), state: String(d.state ?? 'error') };
}
