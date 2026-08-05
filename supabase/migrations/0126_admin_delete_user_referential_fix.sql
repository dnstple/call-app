-- 0126 — Make admin_delete_user actually work (referential teardown).
--
-- Two problems caused the 409 (foreign-key violation) on delete:
--
--   1. Dozens of audit / actor / "granted_by" columns reference accounts(id)
--      (and a few reference profiles(id)) with NO on-delete rule, so any such
--      row blocks deletion of the account. These are soft references — the
--      correct behaviour is to null the link, not block. This converts every
--      single-column, NULLABLE, no-action/restrict FK referencing accounts or
--      profiles to ON DELETE SET NULL. (Non-destructive: no rows are removed;
--      only the delete-time behaviour changes.)
--
--   2. admin_delete_user deleted the account but never the person's PROFILE, so
--      profile-scoped rows survived — notably the signup consent acknowledgement
--      (consent_acknowledgements.acknowledged_by_account_id is NOT NULL and
--      references accounts), which then blocked the account delete. The rewrite
--      deletes the account's owner profile(s) first (cascading profile-scoped
--      data such as consent, interests, availability and offers), then deletes
--      the auth user. NOT-NULL owned records that represent real activity
--      (bookings, payments, calls, disputes) still block deletion by design;
--      the function now returns a clear message naming the blocker instead of a
--      raw 409. Additive; apply after 0125.

set search_path = '';

-- 1a. Nullable FKs referencing accounts(id) → ON DELETE SET NULL.
do $$
declare r record;
begin
  for r in
    select c.conname,
           c.conrelid::regclass::text as tbl,
           a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and c.confrelid = 'public.accounts'::regclass
      and array_length(c.conkey, 1) = 1
      and c.confdeltype in ('a', 'r')   -- no action / restrict
      and a.attnotnull = false          -- only nullable columns
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    execute format(
      'alter table %s add constraint %I foreign key (%I) references public.accounts(id) on delete set null',
      r.tbl, r.conname, r.col);
  end loop;
end $$;

-- 1b. Nullable FKs referencing profiles(id) → ON DELETE SET NULL.
do $$
declare r record;
begin
  for r in
    select c.conname,
           c.conrelid::regclass::text as tbl,
           a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and c.confrelid = 'public.profiles'::regclass
      and array_length(c.conkey, 1) = 1
      and c.confdeltype in ('a', 'r')
      and a.attnotnull = false
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    execute format(
      'alter table %s add constraint %I foreign key (%I) references public.profiles(id) on delete set null',
      r.tbl, r.conname, r.col);
  end loop;
end $$;

-- 2. Rewrite admin_delete_user: delete owner profile(s) first, then the auth
--    user; surface a friendly error if real activity still blocks the delete.
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

  -- Audit before deletion (target FK is on delete set null, so this row
  -- survives the cascade; the email is kept in before_state for the record).
  perform app_private.audit_access(p_account, 'user_deleted',
    jsonb_build_object('email', v_email), null, p_reason);

  begin
    -- Delete the account's OWNER profile(s) first → profile-scoped data
    -- (consent acknowledgements, interests, availability, offers, …) cascades.
    delete from public.profiles
    where id in (
      select pa.profile_id from public.profile_access pa
      where pa.account_id = p_account and pa.access_role = 'owner');

    -- Delete the auth user → public.accounts and its dependents cascade;
    -- nullable actor/audit references are set null (see 1a/1b above).
    delete from auth.users where id = p_account;
  exception when foreign_key_violation then
    -- Real activity (bookings, payments, calls, disputes, …) protects the row.
    raise exception 'cannot_delete_has_activity: this account has activity that cannot be removed (%). Suspend or block it instead.', sqlerrm
      using errcode = 'P0001';
  end;

  return jsonb_build_object('deleted', true, 'account_id', p_account);
end;
$$;
revoke all on function public.admin_delete_user(uuid, text) from public, anon;
grant execute on function public.admin_delete_user(uuid, text) to authenticated;

select pg_notify('pgrst', 'reload schema');
