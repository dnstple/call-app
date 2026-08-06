-- 0129 — Roll out video verification to all companions; delete after review.
--
--   1. video_verification_enabled now returns true for ANY companion (resolves a
--      companion owner profile) rather than checking the allowlist, so the step
--      applies to every companion. The allowlist table is left in place but is
--      no longer consulted.
--   2. Privacy: the recorded video is deleted once verification is complete.
--      admin_review_verification_video now clears the stored path and stamps
--      deleted_at on approve OR reject; it returns the former path so the client
--      can remove the underlying file via the storage API. Additive; apply after 0128.

set search_path = '';

-- 1. Enable for all companions.
create or replace function app_private.video_verification_enabled(p_account uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.companion_profile_for(p_account) is not null;
$$;
revoke all on function app_private.video_verification_enabled(uuid) from public, anon;
grant execute on function app_private.video_verification_enabled(uuid) to authenticated;

-- 2. Deletion-after-verification.
alter table public.companion_verification_videos add column if not exists deleted_at timestamptz;

create or replace function public.admin_review_verification_video(
  p_id uuid, p_decision text, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_account uuid; v_path text;
begin
  perform app_private.require_support();
  if p_decision not in ('approved', 'rejected') then
    raise exception 'invalid_decision' using errcode = 'P0001';
  end if;
  select account_id, storage_path into v_account, v_path
  from public.companion_verification_videos where id = p_id;
  if v_account is null then raise exception 'not_found' using errcode = 'P0001'; end if;

  update public.companion_verification_videos set
    status = p_decision,
    review_notes = nullif(btrim(p_notes), ''),
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    -- The video is deleted once verification is complete: drop the reference
    -- and stamp the deletion. The client removes the underlying file.
    storage_path = null,
    deleted_at = now()
  where id = p_id;

  perform app_private.audit_access(v_account, 'verification_video_' || p_decision,
    jsonb_build_object('video_id', p_id), null, p_notes);

  return jsonb_build_object('ok', true, 'id', p_id, 'status', p_decision, 'deleted_path', v_path);
end;
$$;
revoke all on function public.admin_review_verification_video(uuid, text, text) from public, anon;
grant execute on function public.admin_review_verification_video(uuid, text, text) to authenticated;

select pg_notify('pgrst', 'reload schema');
