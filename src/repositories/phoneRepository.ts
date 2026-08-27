/**
 * Phone verification (restructure Phase 6). Uses Supabase Auth's phone OTP so the
 * SMS provider is a Supabase dashboard setting, not code. Flow: send a code to a
 * UK mobile, verify it, then sync the verified state onto the account.
 */
import { getSupabaseClient } from '../supabase/client';

/** Normalise UK input (07…, 447…, +447…) to +44 E.164, or null if not a UK mobile. */
export function toUkE164(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, '');
  let n = digits;
  if (n.startsWith('+44')) n = '+44' + n.slice(3).replace(/^0+/, '');
  else if (n.startsWith('44')) n = '+44' + n.slice(2).replace(/^0+/, '');
  else if (n.startsWith('0')) n = '+44' + n.slice(1);
  else if (n.startsWith('+')) return null;         // some other country
  else n = '+44' + n;
  return /^\+44[1-9]\d{8,9}$/.test(n) ? n : null;
}

export async function sendPhoneOtp(phoneE164: string): Promise<{ ok: boolean; error?: string }> {
  const { error } = await getSupabaseClient().auth.updateUser({ phone: phoneE164 });
  if (error) return { ok: false, error: friendly(error.message) };
  return { ok: true };
}

export async function verifyPhoneOtp(phoneE164: string, code: string): Promise<{ ok: boolean; error?: string }> {
  const client = getSupabaseClient();
  const { error } = await client.auth.verifyOtp({ phone: phoneE164, token: code.trim(), type: 'phone_change' });
  if (error) return { ok: false, error: friendly(error.message) };
  try {
    await (client as unknown as { rpc: (fn: string) => Promise<unknown> }).rpc('confirm_my_phone');
  } catch { /* the account sync is best-effort; auth is already confirmed */ }
  return { ok: true };
}

export async function getPhoneStatus(): Promise<{ verified: boolean; hasNumber: boolean }> {
  const client = getSupabaseClient() as unknown as { rpc: (fn: string) => Promise<{ data: unknown }> };
  try {
    const { data } = await client.rpc('my_phone_status');
    const d = (data ?? {}) as { verified?: boolean; has_number?: boolean };
    return { verified: Boolean(d.verified), hasNumber: Boolean(d.has_number) };
  } catch {
    return { verified: false, hasNumber: false };
  }
}

function friendly(msg: string): string {
  if (/rate|too many/i.test(msg)) return 'Too many attempts — please wait a minute and try again.';
  if (/invalid|token|expired/i.test(msg)) return 'That code wasn’t right or has expired. Please request a new one.';
  return 'We couldn’t verify your number just now. Please try again.';
}
