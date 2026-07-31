/**
 * In-app contact messages.
 *
 * Visitors submit via submit_contact_message (a SECURITY DEFINER RPC callable by
 * anyone, incl. signed-out visitors). Support admins read and resolve them via
 * the admin_* RPCs, which re-check app_private.is_support_admin() server-side.
 * No email is involved — messages live in the database and are read in-app.
 */
import { getSupabaseClient } from '../supabase/client';

export interface ContactMessage {
  id: string;
  name: string | null;
  email: string | null;
  message: string;
  handled: boolean;
  created_at: string;
  from_member: boolean;
}
export interface ContactList { total: number; limit: number; offset: number; rows: ContactMessage[]; }

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const client = getSupabaseClient() as unknown as {
    rpc: (fn: string, params?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  };
  const { data, error } = await client.rpc(name, args);
  if (error) throw error;
  return data as T;
}

export function submitContactMessage(name: string, email: string, message: string): Promise<{ ok: boolean; id: string }> {
  return rpc('submit_contact_message', { p_name: name, p_email: email, p_message: message });
}

export function adminListContactMessages(handled?: boolean | null, limit = 50, offset = 0): Promise<ContactList> {
  return rpc('admin_list_contact_messages', { p_handled: handled ?? null, p_limit: limit, p_offset: offset });
}

export function adminMarkContactHandled(id: string, handled: boolean): Promise<{ id: string; handled: boolean }> {
  return rpc('admin_mark_contact_handled', { p_id: id, p_handled: handled });
}
