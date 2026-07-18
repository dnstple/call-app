/**
 * Supabase client — Stage 2B.
 *
 * Lazy singleton so mock mode needs no configuration and the app never
 * crashes without env vars. From Stage 2B the client persists sessions using
 * Supabase's supported storage handling — tokens are never written to
 * localStorage manually and never logged.
 *
 * Only the anon/public key belongs in the browser. RLS is the security
 * boundary; no privileged key may ever appear in frontend code.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

export type TypedSupabaseClient = SupabaseClient<Database>;

let client: TypedSupabaseClient | null = null;

export interface SupabaseEnv {
  url: string | undefined;
  anonKey: string | undefined;
}

export function supabaseEnv(): SupabaseEnv {
  try {
    return {
      url: import.meta.env?.VITE_SUPABASE_URL,
      anonKey: import.meta.env?.VITE_SUPABASE_ANON_KEY,
    };
  } catch {
    return { url: undefined, anonKey: undefined };
  }
}

export function isSupabaseConfigured(): boolean {
  const { url, anonKey } = supabaseEnv();
  return Boolean(url && anonKey && url.startsWith('http'));
}

/** Throws a helpful error when not configured — call isSupabaseConfigured() first in UI paths. */
export function getSupabaseClient(): TypedSupabaseClient {
  if (client) return client;
  const { url, anonKey } = supabaseEnv();
  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured. Copy .env.example to .env and set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then restart the dev server.',
    );
  }
  client = createClient<Database>(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
    },
  });
  // DEV-only: expose the client for console diagnostics (never in builds).
  if (import.meta.env?.DEV) {
    (window as unknown as { __sb?: unknown }).__sb = client;
  }
  return client;
}
