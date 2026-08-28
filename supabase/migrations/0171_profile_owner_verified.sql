-- ===========================================================================
-- 0171_profile_owner_verified.sql
--
-- Public trust signal: is a profile's owner account phone-verified? Used to show
-- a blue "Verified" badge on any profile (member or companion), including Explore
-- cards. Returns only a boolean — no phone number or personal data is exposed.
-- ===========================================================================

set search_path = '';

create or replace function public.profile_owner_verified(p_profile uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.profile_access pa
    join public.accounts a on a.id = pa.account_id
    where pa.profile_id = p_profile
      and pa.access_role = 'owner'
      and a.phone_verified = true
  );
$$;
revoke all on function public.profile_owner_verified(uuid) from public, anon;
grant execute on function public.profile_owner_verified(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
