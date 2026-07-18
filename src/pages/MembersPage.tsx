/**
 * Redesign Phase B — Members (Coordinator).
 *
 * The people this account arranges conversations for. Replaces the
 * generic Profile area in coordinator navigation. Managed Members have
 * no login: everything here is coordinator-side context.
 */
import { Link } from 'react-router-dom';
import { UserRound, Users } from 'lucide-react';
import { EmptyState, PageHeader } from '../components/ui';
import { useManagedMember } from '../state/managedMember';

export default function MembersPage() {
  const ctx = useManagedMember();

  return (
    <div>
      <PageHeader
        title="Members"
        subtitle="The people you arrange conversations for. Members join their calls through secure guest invitations — they don’t need their own account."
      />

      {ctx.members.length === 0 ? (
        <EmptyState
          icon={<Users size={32} aria-hidden="true" />}
          title="No Members yet"
          body="Your Member was set up during sign-up. If you need to add another person you arrange conversations for, contact support in this prototype."
        />
      ) : (
        <ul className="stack-list" aria-label="Managed Members" style={{ listStyle: 'none', padding: 0 }}>
          {ctx.members.map((m) => {
            const managing = ctx.selected?.profileId === m.profileId;
            return (
              <li key={m.profileId} className="card row wrap" style={{ gap: 14, alignItems: 'center' }}>
                <span className="avatar-fallback" aria-hidden="true"><UserRound size={22} /></span>
                <span className="col grow" style={{ gap: 2 }}>
                  <span className="bold">{m.name}</span>
                  <span className="muted small">
                    {managing ? 'Currently managing' : 'Managed Member'}
                  </span>
                </span>
                <span className="row" style={{ gap: 8 }}>
                  {!managing && ctx.members.length > 1 && (
                    <button className="btn btn-secondary btn-small" onClick={() => ctx.select(m.profileId)}>
                      Manage {m.name.split(' ')[0]}
                    </button>
                  )}
                  <Link className="btn btn-ghost btn-small" to="/conversations">View conversations</Link>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
