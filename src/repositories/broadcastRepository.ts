/**
 * Internal broadcast — send a one-off email or text to whole role segments
 * (members / companions / coordinators). Support-admin only; the send-email /
 * send-sms edge functions re-check the admin bearer and exclude opted-out people.
 */
import { getSupabaseClient } from '../supabase/client';

/* eslint-disable @typescript-eslint/no-explicit-any */
function db(): { functions: { invoke: (name: string, opts: { body: unknown }) => Promise<{ data: any; error: any }> } } {
  return getSupabaseClient() as any;
}

export interface BroadcastResult {
  ok: boolean;
  audience?: number;
  sent?: number;
  failed?: number;
  errors?: string[];
  message: string;
}

export async function broadcast(opts: {
  roles: string[];
  channel: 'email' | 'text';
  subject?: string;
  body: string;
  dryRun?: boolean;
}): Promise<BroadcastResult> {
  const fn = opts.channel === 'email' ? 'send-email' : 'send-sms';
  const payload: Record<string, unknown> = { roles: opts.roles, body: opts.body, dryRun: opts.dryRun ?? false };
  if (opts.channel === 'email') payload.subject = opts.subject ?? '';

  const { data, error } = await db().functions.invoke(fn, { body: payload });
  if (error) return { ok: false, message: 'The send could not be started. Please try again.' };
  const r = (data ?? {}) as { ok?: boolean; dryRun?: boolean; audience?: number; sent?: number; failed?: number; errors?: string[]; error?: string };
  if (!r.ok) return { ok: false, message: r.error ? `Error: ${r.error}` : 'The send did not run.' };
  if (r.dryRun) return { ok: true, audience: r.audience, message: `${r.audience ?? 0} recipient(s) would be contacted. Nothing sent.` };
  return {
    ok: true, audience: r.audience, sent: r.sent, failed: r.failed, errors: r.errors,
    message: `Sent to ${r.sent ?? 0} of ${r.audience ?? 0}${r.failed ? ` (${r.failed} failed)` : ''}.`,
  };
}
