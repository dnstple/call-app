/**
 * Marketplace reads (Supabase mode) — discoverable Companion profiles served
 * by the safe discovery view. Profiles carry NO relationship to the current
 * account. Empty results stay empty; there is no mock fallback.
 */
import { getPublicCompanionProfile } from '../repositories/profileRepository';
import type { User } from '../types';

export const marketplaceCache = new Map<string, User>();

export function cacheMarketplaceUsers(users: User[]): void {
  for (const u of users) marketplaceCache.set(u.id, u);
}

export async function loadMarketplaceProfile(id: string): Promise<User | null> {
  const cached = marketplaceCache.get(id);
  if (cached) return cached;
  const user = await getPublicCompanionProfile(id);
  if (user) marketplaceCache.set(user.id, user);
  return user;
}
