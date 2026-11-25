/**
 * Deno-side helpers shared by the charity outreach edge functions:
 * auth (cron secret OR support admin), service client, Graph credentials.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { GraphMailer, validateCredentials, type GraphCredentials } from '../graph/graphMail.ts';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info, x-billing-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
export const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

export function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
}

/** x-billing-secret (pg_cron) or a support-admin bearer token. Returns caller label or null. */
export async function authorise(req: Request, admin: SupabaseClient): Promise<string | null> {
  const cron = Deno.env.get('BILLING_CRON_SECRET') ?? '';
  if (cron && (req.headers.get('x-billing-secret') ?? '') === cron) return 'cron';
  const h = req.headers.get('Authorization') ?? '';
  if (!h.startsWith('Bearer ')) return null;
  const user = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: h } }, auth: { persistSession: false },
  });
  const { data } = await user.auth.getUser();
  if (!data.user) return null;
  const { data: row } = await admin.from('support_admins').select('account_id').eq('account_id', data.user.id).maybeSingle();
  return row ? `admin:${data.user.id}` : null;
}

export function graphCredentialsFromEnv(): Partial<GraphCredentials> {
  return {
    tenantId: Deno.env.get('MS_GRAPH_TENANT_ID') ?? '',
    clientId: Deno.env.get('MS_GRAPH_CLIENT_ID') ?? '',
    clientSecret: Deno.env.get('MS_GRAPH_CLIENT_SECRET') ?? '',
    mailbox: Deno.env.get('MS_GRAPH_MAILBOX') ?? '',
  };
}

/** Throws GraphUnavailable / SenderNotAllowed — callers must stop, never fall back. */
export function mailerFromEnv(): GraphMailer {
  return new GraphMailer(validateCredentials(graphCredentialsFromEnv()), fetch);
}

export interface Controls {
  erasure_live: boolean;
  outreach_live: boolean;
  outreach_daily_cap: number;
  outreach_sender: string;
  outreach_postal_address: string | null;
}
export async function loadControls(admin: SupabaseClient): Promise<Controls> {
  const { data, error } = await admin.from('automation_controls').select('*').eq('id', true).single();
  if (error || !data) throw new Error(`automation_controls unavailable: ${error?.message ?? 'no row'} (is 0219 applied?)`);
  return data as Controls;
}

export function ukNow(): { date: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
    .formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday: wd };
}
