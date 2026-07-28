-- 0099 — Let a Companion see how many people have saved (favourited) them.
--
-- Block 11 (favourites visibility, privacy-safe slice). The favourites table is
-- readable only by the account that created each favourite, so a Companion
-- cannot see who — or how many — have saved their profile. This adds a single
-- aggregate RPC that returns ONLY a count for the caller's OWN profile(s). No
-- favouriter identities are exposed, so there is no privacy leak and no need to
-- resolve Coordinator-on-behalf identities here (that belongs to a later,
-- message-request slice).
--
-- Additive: one new SECURITY DEFINER function, executable by authenticated
-- users. Apply hosted with `supabase db push` after 0098.

set search_path = '';

create or replace function public.my_favourite_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  -- Distinct accounts that have favourited any profile the caller OWNS.
  select count(distinct f.account_id)::integer
  from public.favourites f
  where f.profile_id in (
    select pa.profile_id
    from public.profile_access pa
    where pa.account_id = auth.uid()
      and pa.access_role = 'owner'
  );
$$;

revoke all on function public.my_favourite_count() from public, anon;
grant execute on function public.my_favourite_count() to authenticated;

select pg_notify('pgrst', 'reload schema');
