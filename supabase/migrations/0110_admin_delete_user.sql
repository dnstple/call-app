-- 0110 — Support-admin: permanently delete a user.
--
-- Deletes the auth user; public.accounts (FK id → auth.users on delete cascade)
-- and its dependent access / profile-access / override rows cascade away with
-- it, freeing the email for re-registration. Safeguards: support-admin only,
-- reason required, cannot delete yourself, cannot delete another support admin
-- (remove their admin status first), and the deletion is recorded in the audit
-- log (with the email) before the rows vanish. Additive; apply after 0109.

set search_path = '';

create or replace function public.admin_delete_user(p_account uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_email text;
begin
  perform app_private.require_support();
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required: a reason is required to delete a user' using errcode = 'P0001';
  end if;
  if p_account is null then
    raise exception 'account_required' using errcode = 'P0001';
  end if;
  if p_account = auth.uid() then
    raise exception 'cannot_delete_self: you can''t delete your own account' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.support_admins where account_id = p_account) then
    raise exception 'cannot_delete_admin: remove support-admin status before deleting this account' using errcode = 'P0001';
  end if;

  select u.email into v_email from auth.users u where u.id = p_account;
  if v_email is null and not exists (select 1 from public.accounts where id = p_account) then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;

  -- Audit before deletion (target FK is on delete set null, so this row survives
  -- the cascade; the email is kept in before_state for the record).
  perform app_private.audit_access(p_account, 'user_deleted',
    jsonb_build_object('email', v_email), null, p_reason);

  -- Delete the auth user → public.accounts and its dependents cascade.
  delete from auth.users where id = p_account;
  return jsonb_build_object('deleted', true, 'account_id', p_account);
end;
$$;
revoke all on function public.admin_delete_user(uuid, text) from public, anon;
grant execute on function public.admin_delete_user(uuid, text) to authenticated;

select pg_notify('pgrst', 'reload schema');
