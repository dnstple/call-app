/**
 * Local-storage-backed store — the Stage 1 stand-in for a real backend.
 * The action functions in actions.ts form the repository/service layer;
 * swap their implementations for API calls in Stage 2 without touching the UI.
 */
import { useMemo, useSyncExternalStore } from 'react';
import type { AppState } from '../types';
import { createSeedState } from '../data/seed';
import { isSupabaseMode } from '../config/dataMode';
import { buildSupabaseViewState, getAuthSnapshot, subscribeAuthSnapshot } from './authBridge';

const STORAGE_KEY = 'companionship-prototype-state-v1';

type Listener = () => void;
const listeners = new Set<Listener>();

function load(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AppState;
      if (parsed.version === 1) return parsed;
    }
  } catch {
    // fall through to fresh seed
  }
  const seeded = createSeedState();
  persist(seeded);
  return seeded;
}

function persist(state: AppState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage may be unavailable (private mode); prototype continues in memory
  }
}

let state: AppState = load();

export function getState(): AppState {
  return state;
}

export function setState(updater: (prev: AppState) => AppState): void {
  state = updater(state);
  persist(state);
  listeners.forEach((l) => l());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * React hook: subscribe to the application view state.
 *
 * Mock mode: the full seeded prototype store (unchanged Stage 1 behaviour).
 * Supabase mode: a state built ONLY from the authenticated account's
 * accessible profiles — seeded mock activity (bookings, packages, ratings,
 * notifications, favourites) can never leak into a real account, and an
 * empty database result stays empty. Safe UI preferences (settings) pass
 * through, keyed by profile UUID so they are namespaced per account.
 */
export function useAppState(): AppState {
  const real = useSyncExternalStore(subscribe, getState);
  const auth = useSyncExternalStore(subscribeAuthSnapshot, getAuthSnapshot);
  return useMemo(
    () => (isSupabaseMode() ? buildSupabaseViewState(auth, real.settings) : real),
    [real, auth],
  );
}

/** Deterministic demo reset — restores the original seeded data. */
export function resetDemoData(): void {
  const seeded = createSeedState();
  state = seeded;
  persist(seeded);
  listeners.forEach((l) => l());
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

/* ---------- Ephemeral toast store (not persisted) ---------- */

export interface Toast {
  id: string;
  message: string;
  tone: 'neutral' | 'ok' | 'warn' | 'danger';
}

let toasts: Toast[] = [];
const toastListeners = new Set<Listener>();

export function pushToast(message: string, tone: Toast['tone'] = 'neutral'): void {
  const toast: Toast = { id: newId('toast'), message, tone };
  toasts = [...toasts, toast];
  toastListeners.forEach((l) => l());
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== toast.id);
    toastListeners.forEach((l) => l());
  }, 4200);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (l) => {
      toastListeners.add(l);
      return () => toastListeners.delete(l);
    },
    () => toasts,
  );
}
