-- ===========================================================================
-- 0152_admin_console_intended_role.sql
--
-- Surface accounts.intended_role (0151) in the support access console, so a
-- drop-off user's chosen path (companion vs coordinator/member) is visible
-- without running SQL — even when they never created a profile (so
-- app_private.account_role() is null).
--
--   * admin_list_accounts: returns intended_role, and the role FILTER now falls
--     back to intended_role so filtering by "companion" also surfaces companion
--     drop-offs who have no profile yet.
--   * admin_account_detail: returns intended_role alongside the resolved role.
--
-- Pure read additions; no behaviour change to grants, actions or auditing.
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
           p.first_name, p.last_name, p.email
    from public.account_access aa
    join public.accounts ac on ac.id = aa.account_id
    left join public.pilot_cohorts c on c.id = aa.cohort_id
    left join lateral (
      select pr.first_name, pr.last_name, pr.email
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
           first_name, last_name, email, registered, last_active
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

create or replace function public.admin_account_detail(p_account uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_aa public.account_access;
  v_profile uuid;
  v_role text;
  v_intended_role text;
  v jsonb;
  v_email_confirmed boolean;
begin
  perform app_private.require_support();
  select * into v_aa from public.account_access where account_id = p_account;
  v_role := app_private.account_role(p_account);
  select intended_role into v_intended_role from public.accounts where id = p_account;

  -- Owner profile for ANY role (not just companion).
  select p.id into v_profile
  from public.profile_access pa
  join public.profiles p on p.id = pa.profile_id
  where pa.account_id = p_account and pa.access_role = 'owner'
  order by pa.created_at
  limit 1;

  v_email_confirmed := exists (select 1 from auth.users u where u.id = p_account and u.email_confirmed_at is not null);

  select jsonb_build_object(
    'account_id', p_account,
    'role', v_role,
    'intended_role', v_intended_role,
    'email_confirmed', v_email_confirmed,
    'application_status', v_aa.application_status,
    'access_level', v_aa.access_level,
    'cohort_id', v_aa.cohort_id,
    'submitted_at', v_aa.submitted_at,
    'reviewed_at', v_aa.reviewed_at,
    'granted_at', v_aa.granted_at,
    'profile', (select jsonb_build_object(
        'id', pr.id,
        'first_name', pr.first_name, 'last_name', pr.last_name,
        'preferred_name', pr.preferred_name,
        'headline', pr.headline, 'bio', pr.bio,
        'age_band', pr.age_band, 'region', pr.region,
        'country_of_residence', pr.country_of_residence,
        'connected_places', pr.connected_places,
        'languages', pr.languages,
        'language_fluency', pr.language_fluency,
        'photo_url', pr.photo_url,
        'profile_status', pr.profile_status, 'visibility', pr.visibility,
        'interests', coalesce((
          select jsonb_agg(i.name order by i.sort_order)
          from public.profile_interests pi
          join public.interests i on i.id = pi.interest_id
          where pi.profile_id = pr.id), '[]'::jsonb))
        from public.profiles pr where pr.id = v_profile),
    'checklist', case when v_role = 'companion' and v_profile is not null
                      then public.application_checklist(p_account) else null end,
    'overrides', (select coalesce(jsonb_agg(jsonb_build_object('feature', feature_key, 'enabled', enabled, 'reason', reason)), '[]'::jsonb)
        from public.account_feature_overrides where account_id = p_account),
    'notes', public.admin_list_notes(p_account),
    'notifications', public.admin_notification_history(p_account),
    'audit', (select coalesce(jsonb_agg(jsonb_build_object(
        'action', action, 'actor', actor_account_id, 'reason', reason,
        'before', before_state, 'after', after_state, 'created_at', created_at) order by created_at desc), '[]'::jsonb)
        from public.access_audit_log where target_account_id = p_account)
  ) into v;
  return v;
end;
$$;
revoke all on function public.admin_account_detail(uuid) from public, anon;
grant execute on function public.admin_account_detail(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
