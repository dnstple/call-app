-- ===========================================================================
-- 0151_capture_intended_role.sql
--
-- Capture the role a person chose ("become a companion / coordinator / member")
-- at ACCOUNT-CREATION time, so we can tell what a drop-off user intended even if
-- they never get far enough to create a profile (profiles.role only exists once
-- the final complete_*_signup step runs).
--
-- Two layers:
--   1. Frontend writes intended_role into auth.users.raw_user_meta_data at
--      auth.signUp(). This is the earliest reliable capture and covers users who
--      never even confirm their email.
--   2. This migration adds public.accounts.intended_role and copies the metadata
--      value into it the first time the account row is created (ensure_current_
--      account), giving a clean, queryable column. A set_intended_role() RPC is
--      provided as a belt-and-braces fallback the app can call post-auth.
--
-- NOTE: existing drop-off accounts cannot be backfilled with a real choice —
-- nothing was ever recorded for them. The backfill below only recovers rows
-- whose auth metadata already happens to carry an intended_role.
-- ===========================================================================

alter table public.accounts
  add column if not exists intended_role text
  check (intended_role is null or intended_role in ('member', 'coordinator', 'companion'));

-- Recreate ensure_current_account so it seeds intended_role from the caller's
-- auth metadata on first creation, and fills it later only when still null
-- (never overwrites a value that is already set).
create or replace function public.ensure_current_account(p_display_name text default null)
returns public.accounts
language plpgsql security definer
set search_path = ''
as $$
declare
  v_account public.accounts;
  v_meta_role text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select nullif(u.raw_user_meta_data->>'intended_role', '')
    into v_meta_role
    from auth.users u
   where u.id = auth.uid();
  if v_meta_role is not null and v_meta_role not in ('member', 'coordinator', 'companion') then
    v_meta_role := null;  -- ignore anything unexpected
  end if;

  insert into public.accounts (id, display_name, intended_role)
  values (auth.uid(), nullif(trim(coalesce(p_display_name, '')), ''), v_meta_role)
  on conflict (id) do nothing;

  -- Fill display name only when empty; never overwrite.
  update public.accounts
     set display_name = nullif(trim(p_display_name), ''), updated_at = now()
   where id = auth.uid()
     and display_name is null
     and nullif(trim(coalesce(p_display_name, '')), '') is not null;

  -- Fill intended_role only when still empty; never overwrite a recorded choice.
  update public.accounts
     set intended_role = v_meta_role, updated_at = now()
   where id = auth.uid()
     and intended_role is null
     and v_meta_role is not null;

  select * into v_account from public.accounts where id = auth.uid();
  return v_account;
end;
$$;
revoke all on function public.ensure_current_account(text) from public, anon;
grant execute on function public.ensure_current_account(text) to authenticated;

-- Fallback: let the authenticated app record the chosen role directly (e.g. the
-- moment the role is picked after auth). Only sets it when still null so it can
-- never clobber a real, later profile-derived truth. Self-service (own row only).
create or replace function public.set_intended_role(p_role text)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if p_role is null or p_role not in ('member', 'coordinator', 'companion') then
    raise exception 'invalid_role: role must be member, coordinator or companion' using errcode = 'P0001';
  end if;
  perform public.ensure_current_account();
  update public.accounts
     set intended_role = p_role, updated_at = now()
   where id = auth.uid()
     and intended_role is null;
end;
$$;
revoke all on function public.set_intended_role(text) from public, anon;
grant execute on function public.set_intended_role(text) to authenticated;

-- Backfill: recover intended_role for existing accounts from auth metadata where
-- present, and — where a profile already exists — from the owned profile's role
-- (authoritative). Never overwrites an already-set value.
update public.accounts a
   set intended_role = nullif(u.raw_user_meta_data->>'intended_role', ''),
       updated_at = now()
  from auth.users u
 where u.id = a.id
   and a.intended_role is null
   and nullif(u.raw_user_meta_data->>'intended_role', '') in ('member', 'coordinator', 'companion');

update public.accounts a
   set intended_role = pr.role::text,
       updated_at = now()
  from public.profile_access pa
  join public.profiles pr on pr.id = pa.profile_id
 where pa.account_id = a.id
   and pa.access_role = 'owner'
   and a.intended_role is null
   and pr.role::text in ('member', 'coordinator', 'companion');
