-- 0125 — Fix admin_profile_preview: availability column names.
--
-- 0124's availability block referenced availability_rules.start_hour, end_hour
-- and time_zone — the ORIGINAL 0001 columns, which migration 0004 dropped and
-- replaced with start_local_time (time), end_local_time (time) and timezone.
-- plpgsql bodies are not column-validated at CREATE time, so 0124 installed
-- cleanly but raised `column ar.start_hour does not exist` at call time, which
-- surfaced in the console as "We couldn't load this preview". This redefines
-- the function using the correct columns and returns the windows as "HH24:MI"
-- strings. Body is otherwise identical to 0124. Additive; apply after 0124.

set search_path = '';

create or replace function public.admin_profile_preview(p_account uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_profile uuid;
  v_role text;
  v_aa public.account_access;
  v jsonb;
begin
  perform app_private.require_support();
  v_role := app_private.account_role(p_account);
  select * into v_aa from public.account_access where account_id = p_account;

  select p.id into v_profile
  from public.profile_access pa
  join public.profiles p on p.id = pa.profile_id
  where pa.account_id = p_account and pa.access_role = 'owner'
  order by pa.created_at
  limit 1;

  if v_profile is null then
    return jsonb_build_object('found', false, 'role', v_role,
      'application_status', v_aa.application_status, 'access_level', v_aa.access_level);
  end if;

  select jsonb_build_object(
    'found', true,
    'role', v_role,
    'application_status', v_aa.application_status,
    'access_level', v_aa.access_level,
    'profile', (select jsonb_build_object(
        'id', pr.id,
        'first_name', pr.first_name, 'last_name', pr.last_name,
        'preferred_name', pr.preferred_name,
        'age_band', pr.age_band, 'region', pr.region,
        'country_of_residence', pr.country_of_residence,
        'connected_places', pr.connected_places,
        'headline', pr.headline, 'bio', pr.bio,
        'languages', pr.languages, 'language_fluency', pr.language_fluency,
        'mediums', pr.mediums, 'style', pr.style,
        'verification', pr.verification,
        'avatar_path', pr.avatar_path, 'photo_url', pr.photo_url,
        'joined_at', pr.joined_at,
        'interests', coalesce((
          select jsonb_agg(i.name order by i.sort_order)
          from public.profile_interests pi
          join public.interests i on i.id = pi.interest_id
          where pi.profile_id = pr.id), '[]'::jsonb))
        from public.profiles pr where pr.id = v_profile),
    -- FIX: 0004 columns are start_local_time / end_local_time / timezone.
    'availability', coalesce((
        select jsonb_agg(jsonb_build_object(
          'day_of_week', ar.day_of_week,
          'start', to_char(ar.start_local_time, 'HH24:MI'),
          'end', to_char(ar.end_local_time, 'HH24:MI'),
          'timezone', ar.timezone)
          order by ar.day_of_week, ar.start_local_time)
        from public.availability_rules ar
        where ar.companion_profile_id = v_profile), '[]'::jsonb),
    'offers', coalesce((
        select jsonb_agg(jsonb_build_object(
          'offer_type', o.offer_type, 'title', o.title,
          'duration_minutes', o.duration_minutes, 'price_minor', o.price_minor,
          'currency', o.currency, 'active', o.active)
          order by o.sort_order, o.duration_minutes)
        from public.conversation_offers o
        where o.companion_profile_id = v_profile), '[]'::jsonb),
    'checklist', case when v_role = 'companion' then public.application_checklist(p_account) else null end
  ) into v;
  return v;
end;
$$;
revoke all on function public.admin_profile_preview(uuid) from public, anon;
grant execute on function public.admin_profile_preview(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
