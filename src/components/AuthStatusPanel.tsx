/**
 * Development-only authentication diagnostic (Prototype tools).
 * Never displays tokens, passwords, secrets or auth headers.
 */
import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Modal } from './ui';
import { useAuth } from '../auth/AuthProvider';
import { getDataMode } from '../config/dataMode';
import { isSupabaseConfigured } from '../supabase/client';
import { roleLabel } from './Shell';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row between" style={{ gap: 16 }}>
      <span className="muted">{label}</span>
      <span style={{ textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

export function AuthStatusPanel({ onClose }: { onClose: () => void }) {
  const auth = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const mode = getDataMode();
  const dev = Boolean(import.meta.env?.DEV);

  const expiresAt = auth.session?.expires_at
    ? new Date(auth.session.expires_at * 1000).toLocaleString('en-GB')
    : '—';

  return (
    <Modal title="Authentication status" onClose={onClose}>
      <div className="col" style={{ gap: 10 }}>
        <Row label="Data source" value={mode} />
        <Row label="Supabase configured" value={isSupabaseConfigured() ? 'yes' : 'no'} />
        <Row label="Session" value={auth.status === 'authenticated' ? 'signed in' : auth.status} />
        {dev && auth.user && <Row label="Auth user id (dev only)" value={auth.user.id} />}
        <Row label="Email" value={auth.user?.email ?? '—'} />
        <Row
          label="Account bootstrap"
          value={auth.account ? `ok · status ${auth.account.status}` : auth.status === 'authenticated' ? 'missing' : '—'}
        />
        <Row
          label="Onboarding"
          value={auth.account ? (auth.account.onboarding_complete ? 'complete' : 'incomplete') : '—'}
        />
        <Row label="Accessible profiles" value={String(auth.profiles.length)} />
        <Row
          label="Active profile"
          value={
            auth.activeProfileId
              ? (() => {
                  const p = auth.profiles.find((x) => x.profile.id === auth.activeProfileId);
                  return p ? `${p.profile.first_name} (${roleLabel(p.profile.role)})` : auth.activeProfileId;
                })()
              : '—'
          }
        />
        <Row label="Session expires" value={expiresAt} />
        {mode === 'supabase' && auth.status === 'authenticated' && (
          <button
            className="btn btn-secondary btn-small mt-2"
            style={{ alignSelf: 'flex-start' }}
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              try {
                await auth.refreshProfiles();
              } finally {
                setRefreshing(false);
              }
            }}
          >
            <RefreshCw size={16} aria-hidden="true" /> Reload profile access
          </button>
        )}
        <p className="faint" style={{ margin: 0 }}>
          Tokens, passwords and headers are never shown here.
        </p>
      </div>
    </Modal>
  );
}
