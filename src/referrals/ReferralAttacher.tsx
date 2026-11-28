/**
 * Credits a stored invite code to the newly signed-in account, once. Renders
 * nothing. The server only accepts accounts created in the last 14 days, so an
 * existing user who clicks a link is simply ignored. Never blocks or errors.
 */
import { useEffect, useRef } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { isSupabaseMode } from '../config/dataMode';
import { attachReferral } from '../repositories/referralRepository';
import { clearStoredRef, getStoredRef } from './refCapture';

export function ReferralAttacher() {
  const { status } = useAuth();
  const tried = useRef(false);
  useEffect(() => {
    if (status !== 'authenticated' || tried.current || !isSupabaseMode()) return;
    const code = getStoredRef();
    if (!code) return;
    tried.current = true;
    attachReferral(code)
      .then(() => clearStoredRef()) // ok, or a final answer (self, not new, invalid…)
      .catch(() => { tried.current = false; }); // network/server hiccup: retry next time
  }, [status]);
  return null;
}
