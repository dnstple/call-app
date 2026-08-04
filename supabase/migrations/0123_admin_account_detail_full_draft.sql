-- 0123 — admin_account_detail: full account draft for the access console.
--
-- Two changes so support can preview what a user's account will look like with
-- the information they entered, for ANY role:
--   1. Resolve the owner profile for any role. The prior version used
--      app_private.companion_profile_for, which only returns COMPANION profiles,
--      so members and coordinators showed a blank preview. This resolves the
--      caller's owner profile regardless of role.
--   2. Return a fuller profile object: the profile id (so the console can link
--      to the live marketplace view), region, languages, age band, the new
--      extras (preferred name, country of residence, connected places, per-
--      language fluency) and interests read from the profile_interests join
--      table (with catalogue names) rather than the empty legacy array column.
--
-- The checklist is still only meaningful for companions, so it is included only
-- when the resolved role is 'companion'. Additive; apply after 0122.

set search_path = '';

create or replace function public.admin_account_detail(p_account uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_aa public.account_access;
  v_profile uuid;
  v_role text;
  v jsonb;
  v_email_confirmed boolean;
begin
  perform app_private.require_support();
  select * into v_aa from public.account_access where account_id = p_account;
  v_role := app_private.account_role(p_account);

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
        -- Interests from the join table (where signup stores them), with names.
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
