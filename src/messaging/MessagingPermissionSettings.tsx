/**
 * 2F2B follow-up — the missing switch for Coordinator messaging.
 *
 * Coordinators only ever gain access to a managed Member's conversations
 * through the explicit can_message permission (0019). This is its UI:
 * one clear toggle per managed Member, calling the existing
 * set_messaging_permission RPC (owner-or-self-consent rules enforced
 * server-side). Supabase mode only; mock mode has no permission model.
 */
import { useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { isSupabaseMode } from '../config/dataMode';
import { useAuth } from '../auth/AuthProvider';
import { useAuthSnapshot } from '../state/authBridge';
import { setMessagingPermission, MessagingError } from '../repositories/messagingRepository';
import { announceMessagesChanged } from './hooks';
import { Switch } from '../components/ui';
import { pushToast } from '../state/store';

export function MessagingPermissionSettings() {
  const auth = useAuth();
  const snapshot = useAuthSnapshot();
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!isSupabaseMode()) return null;
  const coordinated = snapshot.profiles.filter(
    (p) => p.access.access_role === 'coordinator' && p.profile.role === 'member',
  );
  if (coordinated.length === 0) return null;

  const toggle = async (profileId: string, next: boolean) => {
    if (busyId || !snapshot.userId) return;
    setBusyId(profileId);
    try {
      await setMessagingPermission(profileId, snapshot.userId, next);
      await auth.refreshProfiles(); // snapshot picks up the new can_message
      announceMessagesChanged();    // inbox + badges reflect it immediately
      pushToast(next ? 'Messaging turned on' : 'Messaging turned off', 'ok');
    } catch (e) {
      pushToast(
        e instanceof MessagingError ? e.message : 'We couldn’t change that. Please try again.',
        'danger',
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="card card-tight col" style={{ gap: 10 }} aria-label="Messaging permission">
      <span className="row bold" style={{ gap: 8 }}>
        <MessageCircle size={18} aria-hidden="true" /> Messaging on their behalf
      </span>
      <p className="faint longform" style={{ margin: 0 }}>
        When turned on, you can read and send messages in this person’s conversations with
        their Companions. Messages you send are always shown as coming from you.
      </p>
      {coordinated.map(({ profile, access }) => (
        <div key={profile.id} className="row between wrap" style={{ gap: 8 }}>
          <span>{profile.first_name}{profile.last_name ? ` ${profile.last_name}` : ''}</span>
          <Switch
            label={`Allow messaging for ${profile.first_name}`}
            checked={access.can_message}
            onChange={(v) => void toggle(profile.id, v)}
          />
        </div>
      ))}
      {busyId && <span className="faint">Saving…</span>}
    </div>
  );
}
