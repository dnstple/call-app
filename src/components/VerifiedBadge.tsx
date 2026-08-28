/**
 * Blue "Verified" trust badge, shown on any profile whose owner has verified
 * their mobile number.
 *
 * Presentational only: it takes a `verified` boolean and renders nothing when
 * false. The verified state is carried by the data the surrounding screen has
 * already loaded (the discoverable_companions view's owner_verified column, or
 * the signed-in account row), so dropping this badge onto a card or profile
 * costs ZERO extra network requests — unlike the earlier per-card RPC version.
 */
import { BadgeCheck } from 'lucide-react';

export function VerifiedBadge({ verified, size = 15 }: { verified?: boolean; size?: number }) {
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
