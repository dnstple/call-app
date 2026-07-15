/**
 * Data-mode switch.
 *
 *   "mock"      — the complete Stage 1 prototype: seeded fictional data,
 *                 localStorage persistence, no network, no authentication.
 *   "supabase"  — real authentication, accounts, profile access and RLS
 *                 (Stage 2B). Feature data (bookings, Explore, favourites…)
 *                 still runs locally until Stage 2C migrates it.
 *
 * Resolution order: localStorage override (Prototype tools)
 *   → VITE_DATA_SOURCE (preferred) → VITE_DATA_MODE (legacy) → "mock".
 */
export type DataMode = 'mock' | 'supabase';

const OVERRIDE_KEY = 'companionship-data-mode-v1';

function envMode(): DataMode {
  try {
    const v = (
      import.meta.env?.VITE_DATA_SOURCE ??
      import.meta.env?.VITE_DATA_MODE ??
      ''
    ).toLowerCase();
    return v === 'supabase' ? 'supabase' : 'mock';
  } catch {
    return 'mock';
  }
}

export function getDataMode(): DataMode {
  try {
    const v = localStorage.getItem(OVERRIDE_KEY);
    if (v === 'supabase' || v === 'mock') return v;
  } catch {
    /* localStorage unavailable (tests, SSR) */
  }
  return envMode();
}

/** Runtime override set from Prototype tools. */
export function setDataMode(mode: DataMode): void {
  try {
    localStorage.setItem(OVERRIDE_KEY, mode);
  } catch {
    /* ignore */
  }
}

export function clearDataModeOverride(): void {
  try {
    localStorage.removeItem(OVERRIDE_KEY);
  } catch {
    /* ignore */
  }
}

export function isSupabaseMode(): boolean {
  return getDataMode() === 'supabase';
}
