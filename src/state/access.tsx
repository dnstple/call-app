/**
 * Pilot access state — the single client reflection of the server's authority.
 *
 * The snapshot comes ONLY from current_account_access (SECURITY DEFINER). The
 * client never computes access from role, email or local flags; it renders what
 * the database returns. Mock mode has no pilot concept, so it resolves to full
 * access. No protected shell is rendered before the access state is known
 * (prevents any flash of the full app for a waitlisted account).
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { Loader2 } from 'lucide-react';
import { isSupabaseMode } from '../config/dataMode';
import { useAuth } from '../auth/AuthProvider';
import { fetchCurrentAccess, type AccountAccess } from '../repositories/accessRepository';

export type AccessMode = 'loading' | 'full' | 'pilot' | 'waitlist' | 'blocked';

interface AccessContextValue {
  loading: boolean;
  mode: AccessMode;
  access: AccountAccess | null;
  reload: () => void;
}

const FULL_FALLBACK: AccessContextValue = {
  loading: false, mode: 'full', access: null, reload: () => {},
};

const AccessContext = createContext<AccessContextValue>(FULL_FALLBACK);

export function useAccess(): AccessContextValue {
  return useContext(AccessContext);
}

export function deriveMode(a: AccountAccess | null): AccessMode {
  if (!a) return 'full';
  // Support admins retain full internal + product access regardless of level.
  if (a.isSupportAdmin) return 'full';
  if (a.accessLevel === 'blocked' || a.applicationStatus === 'suspended') return 'blocked';
  if (a.accessLevel === 'full') return 'full';
  if (a.accessLevel === 'pilot') return 'pilot';
  return 'waitlist';
}

export function AccessProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const supabase = isSupabaseMode();
  const authed = auth.status === 'authenticated';
  const [access, setAccess] = useState<AccountAccess | null>(null);
  const [loading, setLoading] = useState<boolean>(supabase);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!supabase || !authed) {
      setAccess(null);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    fetchCurrentAccess()
      .then((a) => { if (live) { setAccess(a); setLoading(false); } })
      .catch(() => { if (live) { setAccess(null); setLoading(false); } });
    return () => { live = false; };
  }, [supabase, authed, tick]);

  const value = useMemo<AccessContextValue>(() => ({
    loading: supabase && authed ? loading : false,
    mode: !supabase || !authed ? 'full' : loading ? 'loading' : deriveMode(access),
    access,
    reload,
  }), [supabase, authed, loading, access, reload]);

  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

/** Full-screen loader used while access resolves (no shell behind it). */
export function AccessLoading() {
  return (
    <div className="row" style={{ justifyContent: 'center', minHeight: '60vh' }}>
      <Loader2 size={30} aria-hidden="true" />
      <span className="visually-hidden">Checking your access</span>
    </div>
  );
}
