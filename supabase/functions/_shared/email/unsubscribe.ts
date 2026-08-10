/**
 * Signed one-click unsubscribe tokens for lifecycle emails. The link in an email
 * carries the account id, a category and an HMAC-SHA256 token so the public
 * unsubscribe endpoint can trust it WITHOUT a login — the token can only have
 * been produced by someone holding the server secret, and it can't be forged or
 * enumerated. Dependency-free (Web Crypto), so it runs under Deno and jsdom.
 */

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}

/** Constant-time-ish comparison to avoid leaking match position via timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function unsubscribePayload(accountId: string, category: string): string {
  return `${accountId}:${category}`;
}

/** HMAC-SHA256(secret, "account:category") as lowercase hex. */
export async function signUnsubscribe(accountId: string, category: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(unsubscribePayload(accountId, category)));
  return toHex(sig);
}

export async function verifyUnsubscribe(
  accountId: string, category: string, token: string, secret: string,
): Promise<boolean> {
  if (!accountId || !category || !token || !secret) return false;
  const expected = await signUnsubscribe(accountId, category, secret);
  return safeEqual(expected.toLowerCase(), token.toLowerCase());
}

/** Build the full unsubscribe URL the email links to. */
export async function buildUnsubscribeUrl(
  appUrl: string, functionsBaseUrl: string, accountId: string, category: string, secret: string,
): Promise<string> {
  const token = await signUnsubscribe(accountId, category, secret);
  const base = functionsBaseUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({ a: accountId, c: category, t: token });
  // appUrl is retained for callers that want to show a "return to Apricoti" link.
  void appUrl;
  return `${base}/email-unsubscribe?${params.toString()}`;
}
