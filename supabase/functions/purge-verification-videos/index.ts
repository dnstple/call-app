/**
 * purge-verification-videos — ONE-OFF bulk delete of every companion verification
 * video. SQL cannot delete storage.objects (protect_delete trigger), so this
 * removes the media through the Storage API (service role) and then clears the
 * metadata rows via purge_all_verification_video_rows().
 *
 * Paths are gathered from BOTH the metadata table (authoritative) and a walk of
 * the bucket (to catch any orphaned files), so nothing is left behind.
 *
 * Auth: shared cron secret (x-billing-secret) OR a support-admin bearer token.
 * SELF-CONTAINED (no ../_shared imports) so it deploys from the dashboard editor.
 *
 *   supabase functions deploy purge-verification-videos
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

const BUCKET = 'verification-videos';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info, x-billing-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // Auth: internal cron secret OR a support-admin bearer token.
  const cronSecret = Deno.env.get('BILLING_CRON_SECRET') ?? '';
  const isInternal = cronSecret.length > 0 && (req.headers.get('x-billing-secret') ?? '') === cronSecret;
  if (!isInternal) {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorised' }, 401);
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
    );
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: 'unauthorised' }, 401);
    const { data: adminRow } = await admin.from('support_admins')
      .select('account_id').eq('account_id', userData.user.id).maybeSingle();
    if (!adminRow) return json({ error: 'forbidden' }, 403);
  }

  const paths = new Set<string>();

  // 1. Authoritative: every storage_path recorded in the metadata table.
  const { data: rows, error: rowsErr } = await admin
    .from('companion_verification_videos').select('storage_path');
  if (rowsErr) return json({ error: 'list_rows_failed', detail: rowsErr.message }, 500);
  for (const r of (rows ?? []) as Array<{ storage_path: string | null }>) {
    if (r.storage_path) paths.add(r.storage_path);
  }

  // 2. Walk the bucket for orphans: root entries with a null id are folders
  //    ({profileId}/), each containing the {uuid}.webm files.
  const { data: top } = await admin.storage.from(BUCKET).list('', { limit: 1000 });
  for (const entry of top ?? []) {
    if ((entry as { id: string | null }).id === null) {
      let offset = 0;
      // paginate the folder
      while (true) {
        const { data: files } = await admin.storage.from(BUCKET).list(entry.name, { limit: 1000, offset });
        if (!files || files.length === 0) break;
        for (const f of files) {
          if ((f as { id: string | null }).id !== null) paths.add(`${entry.name}/${f.name}`);
        }
        if (files.length < 1000) break;
        offset += 1000;
      }
    } else {
      paths.add(entry.name);
    }
  }

  // 3. Remove the files via the Storage API, in chunks.
  const all = [...paths];
  let filesRemoved = 0;
  const errors: string[] = [];
  for (let i = 0; i < all.length; i += 100) {
    const chunk = all.slice(i, i + 100);
    const { data, error } = await admin.storage.from(BUCKET).remove(chunk);
    if (error) errors.push(error.message);
    else filesRemoved += data?.length ?? chunk.length;
  }

  // 4. Clear the metadata rows.
  const { data: rowsDeleted, error: purgeErr } = await admin.rpc('purge_all_verification_video_rows');
  if (purgeErr) errors.push(`rows: ${purgeErr.message}`);

  return json({
    ok: errors.length === 0,
    files_found: all.length,
    files_removed: filesRemoved,
    rows_deleted: rowsDeleted ?? 0,
    errors,
  });
});
