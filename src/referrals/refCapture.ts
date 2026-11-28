/**
 * Invite-link capture. A companion's link is https://www.apricoti.co.uk/?ref=CODE
 * (the app uses HashRouter, so the code arrives in location.search, or inside the
 * hash as #/signup?ref=CODE). We remember it for 30 days so the visitor can look
 * around, sign up later, and the invite is still credited (see ReferralAttacher).
 */
const KEY = 'apricoti_ref';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_RE = /^[A-Z0-9]{6,12}$/;

export function normaliseRefCode(raw: string | null | undefined): string | null {
  const c = (raw ?? '').trim().toUpperCase();
  return CODE_RE.test(c) ? c : null;
}

function readFromUrl(loc: Pick<Location, 'search' | 'hash'>): string | null {
  const fromSearch = new URLSearchParams(loc.search).get('ref');
  const q = loc.hash.indexOf('?');
  const fromHash = q >= 0 ? new URLSearchParams(loc.hash.slice(q + 1)).get('ref') : null;
  return normaliseRefCode(fromSearch) ?? normaliseRefCode(fromHash);
}

/** Call once at start-up. A newer link always replaces an older stored code. */
export function captureRefFromUrl(loc: Pick<Location, 'search' | 'hash'> = window.location): string | null {
  const code = readFromUrl(loc);
  if (code) {
    try { localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() })); } catch { /* storage blocked */ }
  }
  return code;
}

/** Store a code typed by hand (e.g. from a printed flyer). Returns false if it isn't a valid format. */
export function storeRefCode(raw: string): boolean {
  const code = normaliseRefCode(raw);
  if (!code) return false;
  try { localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() })); } catch { return false; }
  return true;
}

export function getStoredRef(now = Date.now()): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { code?: string; at?: number };
    if (!v.at || now - v.at > TTL_MS) { localStorage.removeItem(KEY); return null; }
    return normaliseRefCode(v.code);
  } catch {
    return null;
  }
}

export function clearStoredRef(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** The shareable link for a code. */
export function inviteLink(origin: string, code: string): string {
  return `${origin.replace(/\/$/, '')}/?ref=${encodeURIComponent(code)}`;
}
