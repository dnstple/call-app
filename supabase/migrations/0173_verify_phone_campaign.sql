-- ===========================================================================
-- 0173_verify_phone_campaign.sql  (Membership restructure — Phase 6)
--
-- Recipient list for the "verify your mobile number" reminder email, sent
-- manually by a support admin from the internal console (campaign-verify-phone
-- Edge Function). Targets ONLY accounts whose phone isn't verified yet, across
-- members, coordinators and companions.
--
--   * support_unverified_accounts() → service-role recipient list. Never exposed
--     to anon/authenticated, so account emails can't be harvested.
--   * Honours the generic email_suppressions opt-out for category 'verify_phone'
--     (one-click unsubscribe handled by the existing email-unsubscribe endpoint).
-- ===========================================================================

set search_path = '';

create or replace function public.support_unverified_accounts()
returns table (account_id uuid, email text, first_name text)
language sql stable security definer set search_path = '' as $$
  select a.id as account_id,
         coalesce(nullif(pr.email, ''), u.email) as email,
         pr.first_name
  from public.accounts a
  join auth.users u on u.id = a.id
  -- Owner profile (if any) supplies a first name for a warm greeting.
  left join lateral (
    select p.first_name, p.email
    from public.profile_access pa
    join public.profiles p on p.id = pa.profile_id
    where pa.account_id = a.id and pa.access_role = 'owner'
    order by pa.created_at
    limit 1
  ) pr on true
  where a.status = 'active'
    and coalesce(a.phone_verified, false) = false
    and coalesce(nullif(pr.email, ''), u.email) is not null
    and u.email_confirmed_at is not null   -- only people who can actually sign in
    and not exists (
      select 1 from public.email_suppressions s
      where s.account_id = a.id and s.category = 'verify_phone'
    );
$$;
revoke all on function public.support_unverified_accounts() from public, anon, authenticated;
grant execute on function public.support_unverified_accounts() to service_role;

select pg_notify('pgrst', 'reload schema');
