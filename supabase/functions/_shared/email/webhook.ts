/**
 * Resend delivery-webhook helpers: map provider events to our status/timestamp
 * columns, and verify the Svix signature over the RAW body. An email is only
 * ever marked delivered/bounced/etc. from a VERIFIED webhook — never because the
 * initial send API call returned 200.
 */
import type { EmailStatus } from './types.ts';

export interface EventMapping {
  status: EmailStatus | null;   // null ⇒ acknowledge only, don't change status
  tsField: 'sent_at' | 'delivered_at' | 'failed_at' | 'bounced_at' | 'complained_at' | null;
}

/** Maps a Resend event type to the DB status + timestamp column to set. */
export function mapResendEvent(eventType: string): EventMapping | null {
  switch (eventType) {
    case 'email.sent':            return { status: 'sent', tsField: 'sent_at' };
    case 'email.delivered':       return { status: 'delivered', tsField: 'delivered_at' };
    case 'email.delivery_delayed':return { status: null, tsField: null };  // note only, no regression
    case 'email.failed':          return { status: 'failed', tsField: 'failed_at' };
    case 'email.bounced':         return { status: 'bounced', tsField: 'bounced_at' };
    case 'email.complained':      return { status: 'complained', tsField: 'complained_at' };
    default:                      return null;                              // unknown event ignored
  }
}

// ---- Svix signature verification (Resend uses Svix) ----
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToBase64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i += 1) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

/** Constant-time-ish string compare. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;   // space-delimited "v1,<b64> v1,<b64>"
}

/**
 * Verify a Svix/Resend webhook. `secret` is the whsec_… signing secret, `rawBody`
 * is the exact bytes received (never re-serialised JSON). Returns true only when
 * a provided signature matches.
 */
export async function verifyResendSignature(
  secret: string,
  headers: SvixHeaders,
  rawBody: string,
): Promise<boolean> {
  if (!secret) return false;
  if (!headers.id || !headers.timestamp || !headers.signature) return false;

  const key = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(key);
  } catch {
    return false;
  }

  const signedContent = `${headers.id}.${headers.timestamp}.${rawBody}`;
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes.buffer as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sigBuf = await crypto.subtle.sign(
    'HMAC', cryptoKey, new TextEncoder().encode(signedContent).buffer as ArrayBuffer,
  );
  const expected = bytesToBase64(sigBuf);

  // The header may carry multiple space-separated "version,signature" pairs.
  for (const part of headers.signature.split(' ')) {
    const comma = part.indexOf(',');
    const provided = comma === -1 ? part : part.slice(comma + 1);
    if (safeEqual(provided, expected)) return true;
  }
  return false;
}
