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
import { MessageCircle, Send } from 'lucide-react';
import {
  messagingRepository,
  MessagingError,
  sendMessageRequest,
} from '../repositories/messagingRepository';
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
  const [composing, setComposing] = useState(false);
  const [intro, setIntro] = useState('');

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
      const conversation = await messagingRepository()
        .getOrCreateConversation(memberProfileId, companionProfileId);
      announceMessagesChanged();
      navigate(`/messages/${conversation.id}`);
    } catch (e) {
      if (e instanceof MessagingError && e.code === 'not_eligible') {
        // 0027: no relationship yet — offer ONE introductory message
        // through the dedicated atomic operation instead.
        setComposing(true);
      } else {
        // Neutral by design — no detail about why messaging is closed.
        setNotice('Messaging isn’t available here right now.');
      }
    } finally {
      setBusy(false);
    }
  };

  const sendIntro = async () => {
    if (busy || intro.trim() === '') return;
    setBusy(true);
    setNotice(null);
    try {
      const message = await sendMessageRequest(memberProfileId, companionProfileId, intro);
      announceMessagesChanged();
      navigate(`/messages/${message.conversationId}`);
    } catch (e) {
      setNotice(
        e instanceof MessagingError && e.code === 'request_pending'
          ? 'Your introduction has already been sent — the Companion needs to accept first.'
          : e instanceof MessagingError && e.code === 'request_declined'
            ? 'This introduction was closed.'
            : e instanceof MessagingError && ['empty_message', 'message_too_long', 'rate_limited'].includes(e.code)
              ? e.message
              : 'We couldn’t send your introduction right now.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (composing) {
    return (
      <span className="col" style={{ gap: 6, alignSelf: 'stretch', maxWidth: 420 }}>
        <label className="small bold" htmlFor={`intro-${companionProfileId}`}>
          Send one introductory message
        </label>
        <textarea
          id={`intro-${companionProfileId}`}
          rows={3}
          maxLength={2000}
          placeholder="Introduce yourself and the person you’re arranging conversations for…"
          value={intro}
          onChange={(e) => setIntro(e.target.value)}
        />
        <span className="faint small">
          The Companion accepts or declines your introduction before full messaging opens.
        </span>
        <span className="row" style={{ gap: 8 }}>
          <button
            className="btn btn-primary btn-small"
            disabled={busy || intro.trim() === ''}
            onClick={() => void sendIntro()}
          >
            <Send size={16} aria-hidden="true" /> Send introduction
          </button>
          <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => setComposing(false)}>
            Cancel
          </button>
        </span>
        {notice && <span className="faint" role="status">{notice}</span>}
      </span>
    );
  }

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
