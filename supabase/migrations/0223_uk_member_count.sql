-- ===========================================================================
-- 0223_uk_member_count.sql
--
-- outreach_member_count() quoted to charities must count UK members only.
-- On 25 Nov 2026, 102 of 157 member profiles were overseas sign-ups (none with
-- a booking or membership), which made the old figure ("more than 150")
-- misleading. A member counts as UK when their country of residence is a UK
-- nation or their verified phone is +44. Below 100 the email doesn't quote a
-- number at all (render.ts), so this is safe for the copy.
-- ===========================================================================
set search_path = '';

create or replace function public.outreach_member_count()
returns integer language sql stable security definer set search_path = '' as $$
  select count(distinct p.id)::int
  from public.profiles p
  join public.profile_access pa on pa.profile_id = p.id and pa.access_role in ('owner', 'coordinator')
  join public.accounts a on a.id = pa.account_id
  left join auth.users u on u.id = pa.account_id
  where p.role::text = 'member'
    and p.profile_status <> 'hidden'
    and a.status <> 'deactivated'
    and coalesce(u.email, '') not like 'erased+%'
    and coalesce(u.email, '') not ilike '%@apricoti.co.uk'
    and (lower(coalesce(p.country_of_residence, '')) ~ '^(united kingdom|uk|u\.k\.|england|scotland|wales|northern ireland|great britain|gb|britain)$'
         or coalesce(a.phone_e164, '') like '+44%');
$$;
revoke all on function public.outreach_member_count() from public, anon, authenticated;
grant execute on function public.outreach_member_count() to service_role;

-- FINGERPRINT: select position('+44' in pg_get_functiondef('public.outreach_member_count()'::regprocedure)) > 0 as m0223;
