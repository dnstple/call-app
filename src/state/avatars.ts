/**
 * Avatar stage — batched, cached profile-image resolution.
 *
 * Any number of rows may ask for avatars in the same render pass; the
 * store queues the profile ids and flushes them in ONE
 * get_profile_avatar_paths RPC (microtask-batched), then signs all the
 * returned paths in ONE createSignedUrls call. Results are cached
 * (path cache permanent per session, signed URLs ~55 min like the
 * repository cache), so list re-renders and range navigation never
 * re-request. No N+1, ever.
 *
 * Privacy is enforced server-side (0029): the RPC returns paths only for
 * profiles the caller may see; the storage policy gates the signing.
 * This module just plumbs.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { getSupabaseClient, isSupabaseConfigured } from '../supabase/client';
import { isSupabaseMode } from '../config/dataMode';

const pathCache = new Map<string, string | null>();   // profileId -> avatar_path (null = none/forbidden)
const urlCache = new Map<string, { url: string; expires: number }>(); // path -> signed url
const urlByProfile = new Map<string, string>();

let version = 0;
const listeners = new Set<() => void>();
function bump() {
  version += 1;
  listeners.forEach((l) => l());
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

let queue = new Set<string>();
let flushScheduled = false;

async function flush(): Promise<void> {
  flushScheduled = false;
  const ids = [...queue].filter((id) => !pathCache.has(id));
  queue = new Set();
  if (ids.length === 0 || !isSupabaseMode() || !isSupabaseConfigured()) return;

  try {
    // ONE batched RPC for every id requested this tick.
    const { data } = await getSupabaseClient().rpc('get_profile_avatar_paths', {
      p_profiles: ids,
    });
    const rows = (data ?? []) as { profile_id: string; avatar_path: string | null }[];
    const byId = new Map(rows.map((r) => [r.profile_id, r.avatar_path]));
    for (const id of ids) pathCache.set(id, byId.get(id) ?? null);

    // ONE batched signing call for the fresh paths.
    const now = Date.now();
    const toSign = rows
      .map((r) => r.avatar_path)
      .filter((p): p is string => Boolean(p))
      .filter((p) => !(urlCache.get(p) && urlCache.get(p)!.expires > now));
    if (toSign.length > 0) {
      const { data: signed } = await getSupabaseClient()
        .storage.from('profile-avatars')
        .createSignedUrls(toSign, 3600);
      for (const s of signed ?? []) {
        if (s.path && s.signedUrl) {
          urlCache.set(s.path, { url: s.signedUrl, expires: now + 55 * 60_000 });
        }
      }
    }
    for (const r of rows) {
      const cached = r.avatar_path ? urlCache.get(r.avatar_path) : undefined;
      if (cached) urlByProfile.set(r.profile_id, cached.url);
    }
  } catch {
    for (const id of ids) if (!pathCache.has(id)) pathCache.set(id, null);
  }
  bump();
}

function request(ids: string[]): void {
  let added = false;
  for (const id of ids) {
    if (id && !pathCache.has(id) && !queue.has(id)) {
      queue.add(id);
      added = true;
    }
  }
  if (added && !flushScheduled) {
    flushScheduled = true;
    // Microtask+timeout batching: every row mounted in this pass shares
    // one request, even across separate components.
    setTimeout(() => void flush(), 0);
  }
}

/**
 * Resolve avatar URLs for the given profile ids. Returns a lookup of
 * profileId -> signed URL (undefined while loading or when no permitted
 * image exists — callers fall back to initials).
 */
export function useProfileAvatars(profileIds: (string | null | undefined)[]): (id: string | null | undefined) => string | undefined {
  useSyncExternalStore(subscribe, () => version);
  const key = profileIds.filter(Boolean).join(',');
  useEffect(() => {
    request(profileIds.filter((x): x is string => Boolean(x)));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (id) => (id ? urlByProfile.get(id) : undefined);
}

/** Test hook. */
export function __resetAvatarCache(): void {
  pathCache.clear();
  urlCache.clear();
  urlByProfile.clear();
  queue = new Set();
  flushScheduled = false;
  bump();
}
