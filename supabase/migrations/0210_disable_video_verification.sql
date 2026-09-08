-- ===========================================================================
-- 0210_disable_video_verification.sql
--
-- Switch companion identity-video verification OFF entirely. The feature was
-- gated by app_private.video_verification_enabled() against an email allowlist;
-- this makes that gate ALWAYS return false, so:
--   * my_video_verification() reports enabled=false → the profile prompt hides,
--   * submit_verification_video() raises 'not_enabled' → no new submissions.
-- The allowlist is also emptied so nobody is targeted even if the gate is ever
-- restored. Existing rows/files are removed separately (see the purge code).
-- ===========================================================================

set search_path = '';

-- Hard off-switch: the gate returns false for every account.
create or replace function app_private.video_verification_enabled(p_account uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select false;
$$;
revoke all on function app_private.video_verification_enabled(uuid) from public, anon;
grant execute on function app_private.video_verification_enabled(uuid) to authenticated;

-- Nobody remains targeted.
delete from public.video_verification_allowlist;

select pg_notify('pgrst', 'reload schema');
