-- ===========================================================================
-- 0217_members_full_access.sql
--
-- The app is fully launched: MEMBERS and COORDINATORS get immediate access to
-- Explore and booking — they should never see the waitlist experience. This is
-- enforced server-side (the client renders whatever the server reports):
--   * current_account_access() reports access_level='full'/approved for member &
--     coordinator owners (so the client never routes them to the waitlist),
--   * account_has_feature() grants product features to those roles,
--   * existing member/coordinator rows are backfilled to full/approved.
-- Companions keep the existing review flow. Blocked/suspended accounts stay so.
-- ===========================================================================

set search_path = '';

-- 1. Client-facing access snapshot: members/coordinators read as full + approved.
create or replace function public.current_account_access()
returns jsonb language sql stable security definer set search_path = '' as $$
  with me as (select auth.uid() as uid),
  r as (
    select pr.role::text as role
    from public.profile_access pa
    join public.profiles pr on pr.id = pa.profile_id
    where pa.account_id = (select uid from me) and pa.access_role = 'owner'
    order by pa.created_at limit 1
  )
  select jsonb_build_object(
    'account_id',         (select uid from me),
    'access_level',       case
        when coalesce(aa.access_level, 'waitlist') = 'blocked' then 'blocked'
        when coalesce(aa.application_status, 'incomplete') = 'suspended' then coalesce(aa.access_level, 'waitlist')
        when (select role from r) in ('member', 'coordinator') then 'full'
        else coalesce(aa.access_level, 'waitlist') end,
    'application_status', case
        when (select role from r) in ('member', 'coordinator')
             and coalesce(aa.access_level, 'waitlist') <> 'blocked'
             and coalesce(aa.application_status, 'incomplete') <> 'suspended'
          then 'approved'
        else coalesce(aa.application_status, 'incomplete') end,
    'cohort_id',          aa.cohort_id,
    'cohort_name',        c.name,
    'is_support_admin',   app_private.is_support_admin(),
    'submitted_at',       aa.submitted_at,
    'launch_mode',        (select launch_mode from public.launch_config where id)
  )
  from me
  left join public.account_access aa on aa.account_id = (select uid from me)
  left join public.pilot_cohorts c on c.id = aa.cohort_id;
$$;

-- 2. Feature gate: members/coordinators have full product access.
create or replace function app_private.account_has_feature(p_account uuid, p_feature text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v public.account_access;
  v_waitlist_ok boolean;
  v_override boolean;
  v_enabled  boolean;
begin
  if p_account is null then return false; end if;
  select waitlist_allowed into v_waitlist_ok
    from public.pilot_features where feature_key = p_feature;
  if v_waitlist_ok is null then
    return false;  -- unknown feature key: fail closed
  end if;

  select * into v from public.account_access where account_id = p_account;

  if coalesce(v.access_level, 'waitlist') = 'blocked'
     or coalesce(v.application_status, 'incomplete') = 'suspended'
     or exists (select 1 from public.accounts a where a.id = p_account and a.status in ('suspended','deactivated')) then
    return false;
  end if;

  select enabled into v_override
    from public.account_feature_overrides
   where account_id = p_account and feature_key = p_feature;
  if v_override is not null then return v_override; end if;

  -- App is fully launched: members and coordinators always have product access.
  if exists (
    select 1 from public.profile_access pa
    join public.profiles pr on pr.id = pa.profile_id
    where pa.account_id = p_account and pa.access_role = 'owner'
      and pr.role in ('member','coordinator')
  ) then
    return true;
  end if;

  -- Waitlist-safe setup capabilities are available to any non-blocked account.
  if v_waitlist_ok then return true; end if;

  if coalesce(v.access_level, 'waitlist') = 'full' then
    return true;
  elsif v.access_level = 'pilot' then
    select enabled into v_enabled
      from public.cohort_feature_access
     where cohort_id = v.cohort_id and feature_key = p_feature;
    return coalesce(v_enabled, false);
  end if;

  return false;
end;
$$;

-- 3. Backfill existing member/coordinator accounts to full + approved.
update public.account_access aa
   set access_level = 'full', application_status = 'approved'
 where coalesce(aa.access_level, 'waitlist') <> 'blocked'
   and coalesce(aa.application_status, 'incomplete') <> 'suspended'
   and exists (
     select 1 from public.profile_access pa
     join public.profiles pr on pr.id = pa.profile_id
     where pa.account_id = aa.account_id and pa.access_role = 'owner'
       and pr.role in ('member','coordinator'))
   and (aa.access_level is distinct from 'full' or aa.application_status is distinct from 'approved');

select pg_notify('pgrst', 'reload schema');
