/**
 * Phone (SMS) verification switch. Texts go through Twilio, which is paused
 * (Nov 2026), so verification is OFF by default: members and coordinators skip
 * the "Verify your mobile" step and the in-app reminder banner is hidden.
 * Companion sign-up is closed separately (migration 0218) and keeps its
 * mandatory verify step for when it reopens.
 *
 * To turn it back on: set VITE_PHONE_VERIFICATION=on in Vercel and redeploy.
 */
export function isPhoneVerificationEnabled(): boolean {
  return (import.meta.env.VITE_PHONE_VERIFICATION ?? '').toLowerCase() === 'on';
}
