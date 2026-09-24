-- ===========================================================================
-- 0209_outreach_recent_contacts.sql
--
-- Helpers for one-off recovery outreach to recent sign-ups. Both read auth.users
-- (which the edge functions can't join directly), so they live here as service-
-- role RPCs. They exclude opted-out accounts.
--
--   outreach_recent_sms(since, include_verified, include_unverified)
--       → phone numbers for the cohort. Verified numbers come from
--         accounts.phone_e164; unconfirmed ones (typed at the verify step but
--         never confirmed) come from auth.users.phone.
--   outreach_recent_emails(since)
--       → email address for every account in the cohort (owner profile email,
--         falling back to the auth email).
-- ===========================================================================

set search_path = '';

create or replace function public.outreach_recent_sms(
  p_since timestamptz,
  p_include_verified boolean default true,
  p_include_unverified boolean default true)
returns table (account_id uuid, phone text)
language sql stable security definer set search_path = '' as $$
  select a.id, p.phone
  from public.accounts a
  join auth.users u on u.id = a.id
  cross join lateral (
    select case
      when p_include_verified and coalesce(a.phone_verified, false)
           and nullif(a.phone_e164, '') is not null
        then a.phone_e164
      when p_include_unverified and coalesce(a.phone_verified, false) = false
           and nullif(u.phone, '') is not null
        then case when u.phone like '+%' then u.phone else '+' || u.phone end
      else null
    end as phone
  ) p
  where a.created_at >= p_since
    and coalesce(a.outreach_opt_out, false) = false
    and coalesce(a.sms_opt_out, false) = false
    and p.phone is not null;
$$;
revoke all on function public.outreach_recent_sms(timestamptz, boolean, boolean) from public, anon, authenticated;
grant execute on function public.outreach_recent_sms(timestamptz, boolean, boolean) to service_role;

create or replace function public.outreach_recent_emails(p_since timestamptz)
returns table (account_id uuid, email text)
language sql stable security definer set search_path = '' as $$
  select a.id, coalesce(nullif(pr.email, ''), u.email) as email
  from public.accounts a
  join auth.users u on u.id = a.id
  left join lateral (
    select p2.email
    from public.profile_access pax
    join public.profiles p2 on p2.id = pax.profile_id
    where pax.account_id = a.id and pax.access_role = 'owner'
    order by pax.created_at limit 1
  ) pr on true
  where a.created_at >= p_since
    and coalesce(a.outreach_opt_out, false) = false
    and not exists (
      select 1 from public.email_suppressions s
      where s.account_id = a.id and s.category = 'outreach')
    and coalesce(nullif(pr.email, ''), u.email) is not null;
$$;
revoke all on function public.outreach_recent_emails(timestamptz) from public, anon, authenticated;
grant execute on function public.outreach_recent_emails(timestamptz) to service_role;

select pg_notify('pgrst', 'reload schema');
