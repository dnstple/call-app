-- ===========================================================================
-- 0198_review_returns_deleted_path.sql   (supersedes 0196)
--
-- Correct the verification-video deletion path. 0196 tried to delete the file
-- with a SQL `delete from storage.objects`, but Supabase now blocks that with a
-- protect_delete trigger ("Direct deletion from storage tables is not allowed —
-- use the Storage API"). So 0196 makes the Approve/Reject button ERROR.
--
-- The frontend was already designed the right way: adminReviewVerificationVideo
-- reads `deleted_path` from the RPC result and removes the file via the Storage
-- API (allowed; there is a support delete policy on the bucket). The ONLY thing
-- missing was the RPC returning that path. This redefinition does exactly that —
-- set the decision, then return `deleted_path` so the client deletes the media.
-- No SQL storage deletion happens here.
-- ===========================================================================

set search_path = '';

create or replace function public.admin_review_verification_video(
  p_id uuid, p_decision text, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_account uuid; v_path text; v_updated int := 0;
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
    reviewed_at = now()
  where id = p_id;
  get diagnostics v_updated = row_count;

  perform app_private.audit_access(v_account, 'verification_video_' || p_decision,
    jsonb_build_object('video_id', p_id), null, p_notes);

  -- Hand the storage path back so the support client removes the actual media via
  -- the Storage API (SQL cannot delete storage.objects). This is what frees the
  -- storage / stops further egress, on approve OR reject.
  return jsonb_build_object('ok', true, 'id', p_id, 'status', p_decision,
    'updated', v_updated, 'deleted_path', v_path);
end;
$$;
revoke all on function public.admin_review_verification_video(uuid, text, text) from public, anon;
grant execute on function public.admin_review_verification_video(uuid, text, text) to authenticated;

select pg_notify('pgrst', 'reload schema');
