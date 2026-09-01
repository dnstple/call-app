-- ===========================================================================
-- 0200_admin_bulk_purge_videos.sql
--
-- Support-gated helpers for a one-click "Delete all videos" button that runs
-- entirely through the app's authenticated support session (which CAN delete
-- from the verification-videos bucket via the Storage API — there is a support
-- delete policy). This avoids the edge-function/cron-secret path entirely.
--
--   * admin_list_verification_video_paths() → every stored path, so the client
--     can remove the files via the Storage API.
--   * admin_purge_verification_video_rows()  → clear the metadata rows after the
--     files are removed. Returns the count.
-- Both require support and are callable by the authenticated support admin.
-- ===========================================================================

set search_path = '';

create or replace function public.admin_all_verification_video_paths()
returns setof text language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.require_support();
  return query select storage_path
                 from public.companion_verification_videos
                where storage_path is not null;
end;
$$;
revoke all on function public.admin_all_verification_video_paths() from public, anon;
grant execute on function public.admin_all_verification_video_paths() to authenticated;

create or replace function public.admin_purge_verification_video_rows()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  perform app_private.require_support();
  delete from public.companion_verification_videos;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.admin_purge_verification_video_rows() from public, anon;
grant execute on function public.admin_purge_verification_video_rows() to authenticated;

select pg_notify('pgrst', 'reload schema');
