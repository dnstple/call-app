/** "You were invited by Sarah" — shown on the landing page and sign-up when a valid invite code is stored. */
import { useEffect, useState } from 'react';
import { Gift } from 'lucide-react';
import { isSupabaseMode } from '../config/dataMode';
import { previewReferral, type ReferralPreview } from '../repositories/referralRepository';
import { getStoredRef } from './refCapture';

export function InvitedBanner({ compact = false }: { compact?: boolean }) {
  const [p, setP] = useState<ReferralPreview | null>(null);
  useEffect(() => {
    const code = getStoredRef();
    if (!code || !isSupabaseMode()) return;
    let live = true;
    previewReferral(code).then((r) => { if (live) setP(r); }).catch(() => { /* hide */ });
    return () => { live = false; };
  }, []);
  if (!p?.valid) return null;
  const name = p.first_name || 'someone you know';
  const isCompanion = p.referrer_role === 'companion' && Boolean(p.companion_profile_id);
  return (
    <div className="banner" role="status" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', margin: compact ? '0 0 12px' : '12px auto', maxWidth: 720 }}>
      <Gift size={20} aria-hidden="true" style={{ flex: 'none', marginTop: 2 }} />
      <span>
        <strong>You’ve been invited by {name}.</strong>{' '}
        {isCompanion
          ? `Your first call is free, and once you’ve joined you can book it with ${name}.`
          : 'Your first call is free.'}
      </span>
    </div>
  );
}
