/**
 * Redesign Phase B — the managed-Member context line shown near page
 * titles (never in the global identity area).
 *
 * One member  → plain, non-interactive context: "Managing Mary Thompson".
 * Several     → an explicit selector: "Managing: Mary Thompson ▾".
 * None chosen → the selector shows a prompt; member-scoped actions must
 *               wait for the explicit choice.
 */
import { useManagedMember } from '../state/managedMember';

export function ManagingContext() {
  const ctx = useManagedMember();
  if (ctx.members.length === 0) return null;

  if (ctx.members.length === 1) {
    return <p className="managing-context">Managing {ctx.members[0].name}</p>;
  }

  return (
    <label className="managing-context row" style={{ gap: 6 }}>
      <span>Managing:</span>
      <select
        className="quiet"
        value={ctx.selected?.profileId ?? ''}
        onChange={(e) => ctx.select(e.target.value)}
        aria-label="Choose which Member you are managing"
      >
        {!ctx.selected && <option value="">Choose a Member…</option>}
        {ctx.members.map((m) => (
          <option key={m.profileId} value={m.profileId}>{m.name}</option>
        ))}
      </select>
    </label>
  );
}
