-- ===========================================================================
-- 0199_purge_verification_videos.sql
--
-- Support for a ONE-OFF bulk purge of every companion verification video. The
-- files can only be removed through the Storage API (SQL deletion of
-- storage.objects is blocked by the protect_delete trigger), so the actual media
-- removal happens in the purge-verification-videos edge function. This migration
-- adds:
--   * purge_all_verification_video_rows() — clears the metadata table (a normal
--     table; SQL delete is fine here) AFTER the edge function has removed files.
--   * invoke_purge_verification_videos() — one-line SQL trigger for the edge fn.
-- ===========================================================================

set search_path = '';

-- Delete every verification-video metadata row. Called by the edge function once
-- it has removed the underlying files via the Storage API. Returns the count.
create or replace function public.purge_all_verification_video_rows()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  delete from public.companion_verification_videos;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.purge_all_verification_video_rows() from public, anon, authenticated;
grant execute on function public.purge_all_verification_video_rows() to service_role;

-- One-line trigger: `select app_private.invoke_purge_verification_videos();`
create extension if not exists pg_net;

create or replace function app_private.invoke_purge_verification_videos()
returns void language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text; v_request_id bigint;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'billing_project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'billing_cron_secret';
  if v_url is null or v_secret is null then
    raise notice 'purge-verification-videos: Vault entries billing_project_url/billing_cron_secret absent — skipping.';
    return;
  end if;
  select net.http_post(
    url := v_url || '/functions/v1/purge-verification-videos',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-billing-secret', v_secret),
    timeout_milliseconds := 30000
  ) into v_request_id;
end;
$$;
revoke all on function app_private.invoke_purge_verification_videos() from public, anon, authenticated;

select pg_notify('pgrst', 'reload schema');
