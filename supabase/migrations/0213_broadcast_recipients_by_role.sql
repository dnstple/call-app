-- ===========================================================================
-- 0213_broadcast_recipients_by_role.sql
--
-- Audience lookups for the internal Broadcast tool: pick one or more role
-- segments (member / companion / coordinator) and get the reachable contacts.
-- Service-role (the send-sms / send-email edge functions call these). Opt-outs
-- are always excluded.
-- ===========================================================================

set search_path = '';

create or replace function public.broadcast_recipients_sms(p_roles text[])
returns table (account_id uuid, phone text)
language sql stable security definer set search_path = '' as $$
  select distinct on (pa.account_id) pa.account_id, a.phone_e164 as phone
  from public.profile_access pa
  join public.profiles pr on pr.id = pa.profile_id
  join public.accounts  a  on a.id = pa.account_id
  where pa.access_role = 'owner'
    and pr.role::text = any(p_roles)
    and a.status = 'active'
    and coalesce(a.phone_verified, false) = true
    and a.phone_e164 is not null
    and coalesce(a.outreach_opt_out, false) = false
    and coalesce(a.sms_opt_out, false) = false
  order by pa.account_id;
$$;
revoke all on function public.broadcast_recipients_sms(text[]) from public, anon, authenticated;
grant execute on function public.broadcast_recipients_sms(text[]) to service_role;

create or replace function public.broadcast_recipients_email(p_roles text[])
returns table (account_id uuid, email text)
language sql stable security definer set search_path = '' as $$
  select distinct on (pa.account_id) pa.account_id,
         coalesce(nullif(pr.email, ''), u.email) as email
  from public.profile_access pa
  join public.profiles pr on pr.id = pa.profile_id
  join public.accounts  a  on a.id = pa.account_id
  join auth.users       u  on u.id = pa.account_id
  where pa.access_role = 'owner'
    and pr.role::text = any(p_roles)
    and a.status = 'active'
    and coalesce(a.outreach_opt_out, false) = false
    and not exists (
      select 1 from public.email_suppressions s
      where s.account_id = pa.account_id and s.category = 'outreach')
    and coalesce(nullif(pr.email, ''), u.email) is not null
  order by pa.account_id;
$$;
revoke all on function public.broadcast_recipients_email(text[]) from public, anon, authenticated;
grant execute on function public.broadcast_recipients_email(text[]) to service_role;

select pg_notify('pgrst', 'reload schema');
