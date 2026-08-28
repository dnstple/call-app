/**
 * Resilient code-splitting for a deployed SPA.
 *
 * Routes are loaded with dynamic import() so the shell paints fast. But after a
 * new build ships, an already-open tab still holds the OLD module graph, whose
 * hashed chunk filenames no longer exist on the server. The next lazy import()
 * then rejects with "Failed to fetch dynamically imported module" /
 * ChunkLoadError, and React's <Suspense> has nothing to fall back to — the page
 * hangs on a spinner until the user does a hard refresh.
 *
 * `lazyWithReload` retries the import once (covers a transient network blip),
 * then forces a single full reload so the browser fetches the fresh index.html
 * (served no-cache) and the new chunk map. A short-lived sessionStorage guard
 * prevents an infinite reload loop if the failure is not actually a stale chunk.
 *
 * `ChunkErrorBoundary` is the backstop: if anything still throws a chunk-load
 * error during render, it triggers the same one-time reload instead of leaving
 * a dead screen.
 */
import { Component, lazy, type ComponentType, type ReactNode } from 'react';

const RELOAD_KEY = 'chunk-reload-at';
const RELOAD_WINDOW_MS = 15000;

/** Force one full reload, guarded so we never loop on a genuine (non-stale) error. */
function reloadOnce(): boolean {
  const now = Date.now();
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RELOAD_KEY) ?? '0');
  } catch {
    /* storage unavailable */
  }
  if (now - last < RELOAD_WINDOW_MS) return false; // already reloaded recently — stop
  try {
    sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    /* ignore */
  }
  window.location.reload();
  return true;
}

function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /ChunkLoadError|dynamically imported module|Importing a module script failed|Loading chunk|failed to fetch/i.test(
    msg,
  );
}

/** lazy() that survives stale chunks after a deploy by reloading once. */
export function lazyWithReload<T extends ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    try {
      return await factory();
    } catch (err) {
      // One retry for a transient blip.
      try {
        return await factory();
      } catch (err2) {
        if (isChunkLoadError(err2) && reloadOnce()) {
          // Return a promise that never resolves so nothing renders before the
          // reload takes effect.
          return new Promise<{ default: T }>(() => {});
        }
        throw err2 ?? err;
      }
    }
  });
}

interface BoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
}
interface BoundaryState {
  failed: boolean;
}

/** Catches chunk-load errors that slip past Suspense and reloads once. */
export class ChunkErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(err: unknown): BoundaryState {
    if (isChunkLoadError(err)) {
      // Side-effect in render is discouraged, but a reload is terminal — the tree
      // is torn down immediately, so this is safe and intentional.
      reloadOnce();
    }
    return { failed: true };
  }

  render() {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}
