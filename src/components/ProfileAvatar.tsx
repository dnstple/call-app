/**
 * Avatar stage — the ONE person-image component.
 *
 * Real photo when a permitted image exists; safe initials otherwise; a
 * neutral silhouette only when even a name is missing. Never a broken
 * image, never a generic person icon where initials are available, and
 * loading never shifts layout (fixed box, object-fit: cover).
 */
import { useState } from 'react';
import { UserRound } from 'lucide-react';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZES: Record<AvatarSize, number> = { xs: 30, sm: 38, md: 52, lg: 80 };

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '';
  return `${first}${last}`.toUpperCase();
}

export function ProfileAvatar({ name, url, size = 'sm', statusDot, eager, alt }: {
  /** Visible display name — drives initials and default alt text. */
  name: string;
  /** Resolved (signed/public) image URL, if the viewer may see one. */
  url?: string | null;
  size?: AvatarSize;
  /** Subtle sage dot for ready/available states only. */
  statusDot?: boolean;
  /** Above-the-fold single avatars (hero) load eagerly. */
  eager?: boolean;
  /** Override alt; empty string when the adjacent name makes it decorative. */
  alt?: string;
}) {
  const [failed, setFailed] = useState(false);
  const px = SIZES[size];
  const initials = initialsFor(name);
  const showImage = Boolean(url) && !failed;

  return (
    <span
      className={`p-avatar p-avatar-${size}`}
      style={{ width: px, height: px }}
      data-status={statusDot ? 'ready' : undefined}
    >
      {showImage ? (
        <img
          src={url as string}
          alt={alt ?? name}
          loading={eager ? undefined : 'lazy'}
          onError={() => setFailed(true)}
        />
      ) : initials ? (
        <span className="p-avatar-initials" role="img" aria-label={alt ?? name}>
          {initials}
        </span>
      ) : (
        <UserRound size={Math.round(px * 0.55)} aria-hidden="true" />
      )}
      {statusDot && <span className="p-avatar-dot" aria-hidden="true" />}
    </span>
  );
}
