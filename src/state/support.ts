/**
 * Support/admin authorisation for the internal issue queue (Phase 2G4E).
 *
 * The answer is ALWAYS server-derived (public.am_i_support → the DB-backed
 * support_admins role). No frontend booleans, email allowlists, local-storage
 * flags or query-string claims are ever trusted. Mock mode has no support
 * concept, so it always resolves to "no".
 */
import { useEffect, useState } from 'react';
import { isSupabaseMode } from '../config/dataMode';
import { amISupport } from '../repositories/internalIssueRepository';

export type SupportStatus = 'loading' | 'yes' | 'no';

export function useIsSupport(): SupportStatus {
  const [status, setStatus] = useState<SupportStatus>('loading');
  useEffect(() => {
    if (!isSupabaseMode()) {
      setStatus('no');
      return;
    }
    let live = true;
    amISupport()
      .then((v) => live && setStatus(v ? 'yes' : 'no'))
      .catch(() => live && setStatus('no'));
    return () => {
      live = false;
    };
  }, []);
  return status;
}
