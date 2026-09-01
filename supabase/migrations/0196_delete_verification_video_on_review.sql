-- ===========================================================================
-- 0196_delete_verification_video_on_review.sql
--
-- The internal verification screen tells the reviewer "the video is permanently
-- deleted as soon as you approve or reject it" — but admin_review_verification_video
-- only ever set the status and NEVER deleted the file. So every reviewed identity
-- video kept sitting in the private 'verification-videos' bucket, holding storage
-- and driving egress each time it was fetched. (Trying to clear it by hand failed
-- because storage_path is NOT NULL — you can't blank it; the file must be deleted.)
--
-- This redefinition deletes the actual media file on review (approve OR reject),
-- honouring the UI's promise. The decision, notes and reviewer are retained on the
-- row as the audit record; only the stored video is removed. Runs as the function
-- owner, which bypasses storage RLS, so the delete is authoritative.
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

  -- Delete the media file itself (approve OR reject) — this is what the reviewer
  -- is told happens, and what actually frees storage / stops further egress. The
  -- row (status + notes) stays as the verification record.
  if v_path is not null then
    delete from storage.objects
     where bucket_id = 'verification-videos' and name = v_path;
  end if;

  perform app_private.audit_access(v_account, 'verification_video_' || p_decision,
    jsonb_build_object('video_id', p_id, 'video_file_deleted', true), null, p_notes);

  return jsonb_build_object('ok', true, 'id', p_id, 'status', p_decision,
    'updated', v_updated, 'video_file_deleted', true);
end;
$$;
revoke all on function public.admin_review_verification_video(uuid, text, text) from public, anon;
grant execute on function public.admin_review_verification_video(uuid, text, text) to authenticated;

select pg_notify('pgrst', 'reload schema');
