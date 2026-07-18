/**
 * Redesign Phase F — the Companion's completion checklist.
 *
 * Mirrors the server's completeness rules (0026). The server is the
 * authority: activation happens only through activate_companion_profile,
 * which re-checks everything; an incomplete profile can never appear in
 * Explore regardless of what the browser claims.
 */
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Circle } from 'lucide-react';
import { getSupabaseClient } from '../supabase/client';
import { isSupabaseMode } from '../config/dataMode';

interface Checklist {
  photo: boolean;
  headline: boolean;
  description: boolean;
  description_length: number;
  interests: boolean;
  availability: boolean;
  pricing: boolean;
  complete: boolean;
}

export function CompanionCompletionChecklist({ profileId }: { profileId: string }) {
  const [list, setList] = useState<Checklist | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!isSupabaseMode()) return;
    getSupabaseClient()
      .rpc('companion_completion_checklist', { p_profile: profileId })
      .then(({ data, error }) => {
        if (!error && data) setList(data as unknown as Checklist);
      });
  }, [profileId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!isSupabaseMode() || !list) return null;

  const items: { key: keyof Checklist; label: string }[] = [
    { key: 'photo', label: 'A real profile photo' },
    { key: 'headline', label: 'A short headline' },
    { key: 'description', label: `A meaningful description (120–1,000 characters — currently ${list.description_length})` },
    { key: 'interests', label: 'At least one interest' },
    { key: 'availability', label: 'Weekly availability' },
    { key: 'pricing', label: 'Conversation pricing' },
  ];

  const activate = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const { error } = await getSupabaseClient().rpc('activate_companion_profile', { p_profile: profileId });
    if (error) {
      setMessage(String(error.message ?? '').includes('incomplete_profile')
        ? 'A few items still need finishing before your profile can go public.'
        : 'We couldn’t update your profile just now. Please try again.');
    } else {
      setMessage('Your profile is now publicly discoverable.');
    }
    load();
    setBusy(false);
  };

  return (
    <section className="card col" style={{ gap: 10 }} aria-label="Profile completion">
      <h3 style={{ margin: 0 }}>
        {list.complete ? 'Your profile is complete' : 'Finish your profile to appear in Explore'}
      </h3>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map(({ key, label }) => (
          <li key={key} className="row" style={{ gap: 8 }}>
            {list[key]
              ? <CheckCircle2 size={18} aria-hidden="true" style={{ color: 'var(--color-success-text)' }} />
              : <Circle size={18} aria-hidden="true" style={{ color: 'var(--color-text-muted)' }} />}
            <span className={list[key] ? '' : 'muted'}>{label}</span>
            <span className="visually-hidden">{list[key] ? 'done' : 'still needed'}</span>
          </li>
        ))}
      </ul>
      {!list.complete && (
        <p className="faint small" style={{ margin: 0 }}>
          Companions appear in Explore only with a photo and a full description —
          this keeps the marketplace warm and trustworthy.
        </p>
      )}
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-small" disabled={busy || !list.complete} onClick={() => void activate()}>
          Make my profile public
        </button>
      </div>
      {message && <p className="small" role="status" style={{ margin: 0 }}>{message}</p>}
    </section>
  );
}
