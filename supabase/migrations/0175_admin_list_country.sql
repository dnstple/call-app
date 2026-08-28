-- ===========================================================================
-- 0175_admin_list_country.sql
--
-- Surface the owner profile's country_of_residence in the admin registrations
-- list so the internal console can show where each user is based. Pure read
-- addition; mirrors 0152 exactly plus the new column. Support-admin only.
-- ===========================================================================

set search_path = '';

create or replace function public.admin_list_accounts(
  p_search text default null, p_role text default null, p_status text default null,
  p_access text default null, p_cohort uuid default null,
  p_sort text default 'registered', p_dir text default 'desc',
  p_limit integer default 25, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_rows jsonb; v_total int; v_lim int := least(greatest(coalesce(p_limit,25),1),100); v_off int := greatest(coalesce(p_offset,0),0);
begin
  perform app_private.require_support();
  with base as (
    select aa.account_id, aa.access_level, aa.application_status, aa.cohort_id,
           aa.submitted_at, aa.updated_at as last_active, ac.created_at as registered,
           app_private.account_role(aa.account_id) as role,
           ac.intended_role,
           c.name as cohort_name,
           p.first_name, p.last_name, p.email, p.photo_url
    from public.account_access aa
    join public.accounts ac on ac.id = aa.account_id
    left join public.pilot_cohorts c on c.id = aa.cohort_id
    left join lateral (
      select pr.first_name, pr.last_name, pr.email, pr.photo_url
      from public.profile_access pax join public.profiles pr on pr.id = pax.profile_id
      where pax.account_id = aa.account_id and pax.access_role = 'owner'
      order by pax.created_at limit 1) p on true
  ), filtered as (
    select * from base
    where (p_search is null or btrim(p_search) = ''
           or (coalesce(first_name,'')||' '||coalesce(last_name,'')) ilike '%'||p_search||'%'
           or coalesce(email,'') ilike '%'||p_search||'%')
      and (p_role is null   or coalesce(role, intended_role) = p_role)
      and (p_status is null or application_status = p_status)
      and (p_access is null or access_level = p_access)
      and (p_cohort is null or cohort_id = p_cohort)
  )
  select count(*) into v_total from filtered;

  with base as (
    select aa.account_id, aa.access_level, aa.application_status, aa.cohort_id,
           aa.submitted_at, aa.updated_at as last_active, ac.created_at as registered,
           app_private.account_role(aa.account_id) as role,
           ac.intended_role,
           c.name as cohort_name,
           p.first_name, p.last_name, p.email, p.country_of_residence
    from public.account_access aa
    join public.accounts ac on ac.id = aa.account_id
    left join public.pilot_cohorts c on c.id = aa.cohort_id
    left join lateral (
      select pr.first_name, pr.last_name, pr.email, pr.country_of_residence
      from public.profile_access pax join public.profiles pr on pr.id = pax.profile_id
      where pax.account_id = aa.account_id and pax.access_role = 'owner'
      order by pax.created_at limit 1) p on true
  ), filtered as (
    select * from base
    where (p_search is null or btrim(p_search) = ''
           or (coalesce(first_name,'')||' '||coalesce(last_name,'')) ilike '%'||p_search||'%'
           or coalesce(email,'') ilike '%'||p_search||'%')
      and (p_role is null   or coalesce(role, intended_role) = p_role)
      and (p_status is null or application_status = p_status)
      and (p_access is null or access_level = p_access)
      and (p_cohort is null or cohort_id = p_cohort)
  )
  select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb) into v_rows from (
    select account_id, role, intended_role, application_status, access_level, cohort_name,
           first_name, last_name, email, country_of_residence, registered, last_active
    from filtered
    order by
      case when p_sort='registered'  and p_dir='asc'  then registered end asc,
      case when p_sort='registered'  and p_dir<>'asc' then registered end desc,
      case when p_sort='last_active' and p_dir='asc'  then last_active end asc,
      case when p_sort='last_active' and p_dir<>'asc' then last_active end desc,
      registered desc
    limit v_lim offset v_off
  ) x;

  return jsonb_build_object('total', v_total, 'limit', v_lim, 'offset', v_off, 'rows', v_rows);
end;
$$;
revoke all on function public.admin_list_accounts(text, text, text, text, uuid, text, text, integer, integer) from public, anon;
grant execute on function public.admin_list_accounts(text, text, text, text, uuid, text, text, integer, integer) to authenticated;

select pg_notify('pgrst', 'reload schema');
