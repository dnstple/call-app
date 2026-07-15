/**
 * Favourites store (Supabase mode) — per-account, persisted in the database.
 * Optimistic toggles with rollback; duplicate inserts are handled server-side.
 * Mock mode keeps its own localStorage implementation in the mock store.
 */
import { useSyncExternalStore } from 'react';
import { pushToast } from './store';
import * as repo from '../repositories/profileRepository';

interface FavState {
  ids: Set<string>;
  loaded: boolean;
  loading: boolean;
}

let state: FavState = { ids: new Set(), loaded: false, loading: false };
const listeners = new Set<() => void>();
let snapshot: { ids: string[]; loaded: boolean } = { ids: [], loaded: false };

// Injectable persistence for tests.
export const persistence = {
  load: () => repo.getFavouriteIds(),
  add: (id: string) => repo.addFavourite(id),
  remove: (id: string) => repo.removeFavourite(id),
};

function emit() {
  snapshot = { ids: [...state.ids], loaded: state.loaded };
  listeners.forEach((l) => l());
}

export function resetFavourites(): void {
  state = { ids: new Set(), loaded: false, loading: false };
  emit();
}

export async function ensureFavouritesLoaded(): Promise<void> {
  if (state.loaded || state.loading) return;
  state.loading = true;
  try {
    const ids = await persistence.load();
    state = { ids: new Set(ids), loaded: true, loading: false };
  } catch {
    state.loading = false; // retry on next call
  }
  emit();
}

export function isFavouriteId(profileId: string): boolean {
  return state.ids.has(profileId);
}

/** Optimistic toggle with rollback on failure. */
export async function toggleFavouriteSupabase(profileId: string): Promise<void> {
  const wasFavourite = state.ids.has(profileId);
  if (wasFavourite) state.ids.delete(profileId);
  else state.ids.add(profileId);
  emit();
  try {
    if (wasFavourite) await persistence.remove(profileId);
    else await persistence.add(profileId);
  } catch {
    // Roll back the optimistic change.
    if (wasFavourite) state.ids.add(profileId);
    else state.ids.delete(profileId);
    emit();
    pushToast('We couldn’t save that favourite. Please try again.', 'danger');
  }
}

export function useSupabaseFavourites(): { ids: string[]; loaded: boolean } {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}
