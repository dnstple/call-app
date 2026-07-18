/**
 * Stage 2F2B — "Message" entry point for eligible relationships.
 *
 * Rendered only where the caller believes a qualifying relationship
 * exists (confirmed/completed booking, accepted plan). The backend stays
 * authoritative: if it refuses, the user sees a neutral notice that never
 * explains other people's relationships.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';
import { messagingRepository, MessagingError } from '../repositories/messagingRepository';
import { announceMessagesChanged } from './hooks';
import { isSupabaseMode } from '../config/dataMode';
import { useAuthSnapshot } from '../state/authBridge';

export function MessageActionButton({ memberProfileId, companionProfileId, label, small }: {
  memberProfileId: string;
  companionProfileId: string;
  label: string;
  small?: boolean;
}) {
  const navigate = useNavigate();
  const snapshot = useAuthSnapshot();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // A Coordinator without the explicit can_message permission would be
  // refused by the server — show them the way to the switch instead of a
  // button that cannot work. (Owners are unaffected.)
  const memberAccess = isSupabaseMode()
    ? snapshot.profiles.find((p) => p.profile.id === memberProfileId)?.access
    : undefined;
  const needsPermission =
    memberAccess?.access_role === 'coordinator' && !memberAccess.can_message;

  if (needsPermission) {
    return (
      <span className="col" style={{ gap: 2, alignSelf: 'flex-start' }}>
        <button className={`btn btn-secondary${small ? ' btn-small' : ''}`} disabled>
          <MessageCircle size={small ? 16 : 18} aria-hidden="true" /> {label}
        </button>
        <span className="faint">
          <Link to="/settings">Turn on messaging on their behalf in Settings</Link>
        </span>
      </span>
    );
  }

  const open = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      // DEV-only: surface the exact ids sent, for comparison against the
      // live plan row when diagnosing eligibility issues.
      if (import.meta.env?.DEV) {
        console.warn('[messaging] get_or_create_conversation', {
          memberProfileId, companionProfileId,
        });
      }
      const conversation = await messagingRepository()
        .getOrCreateConversation(memberProfileId, companionProfileId);
      announceMessagesChanged();
      navigate(`/messages/${conversation.id}`);
    } catch (e) {
      // Neutral by design — no detail about why messaging is closed.
      setNotice(
        e instanceof MessagingError && e.code === 'not_eligible'
          ? 'Messaging opens once a conversation is confirmed.'
          : 'Messaging isn’t available here right now.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="col" style={{ gap: 4 }}>
      <button
        className={`btn btn-secondary${small ? ' btn-small' : ''}`}
        disabled={busy}
        onClick={() => void open()}
      >
        <MessageCircle size={small ? 16 : 18} aria-hidden="true" /> {busy ? 'Opening…' : label}
      </button>
      {notice && <span className="faint" role="status">{notice}</span>}
    </span>
  );
}
