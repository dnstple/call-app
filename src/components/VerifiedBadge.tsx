/**
 * Blue "Verified" trust badge, shown on any profile whose owner has verified
 * their mobile number. Self-contained: it fetches its own status via the
 * profile_owner_verified RPC and renders nothing if the profile isn't verified
 * (or the check fails), so it can be dropped anywhere a profile id is available.
 */
import { useEffect, useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import { getSupabaseClient } from '../supabase/client';
import { isSupabaseMode } from '../config/dataMode';

export function VerifiedBadge({ profileId, size = 15 }: { profileId?: string; size?: number }) {
  const [verified, setVerified] = useState(false);

  useEffect(() => {
    if (!profileId || !isSupabaseMode()) return;
    let live = true;
    const client = getSupabaseClient() as unknown as {
      rpc: (fn: string, p: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
    };
    client.rpc('profile_owner_verified', { p_profile: profileId })
      .then(({ data, error }) => { if (live && !error) setVerified(Boolean(data)); })
      .catch(() => {});
    return () => { live = false; };
  }, [profileId]);

  if (!verified) return null;

  return (
    <span
      title="This member has verified their mobile number"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#2563EB', fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap' }}
    >
      <BadgeCheck size={size} aria-hidden="true" /> Verified
    </span>
  );
}
