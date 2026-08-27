-- ===========================================================================
-- 0159_companion_explore_rank.sql  (Membership restructure — Phase 1)
--
-- Admin-controlled 1–5 Explore position rank for companions.
--   * 5 = pushed to the top of Explore, 1 = default. New/existing companions
--     default to 1.
--   * The rank is ADMIN-ONLY: invisible to members and companions. It is exposed
--     on the discoverable_companions view purely so the client can sort by it;
--     the value is not shown in any member/companion UI.
--   * Rank is the PRIMARY Explore sort; within a rank the existing ordering
--     (completeness / recency) is unchanged.
--   * Future: this column is the stable interface for an automated ranking later.
-- ===========================================================================

set search_path = '';

alter table public.companion_profiles
  add column if not exists explore_rank smallint not null default 1
    check (explore_rank between 1 and 5);

-- Recreate the discovery view with explore_rank exposed (definition mirrors 0145
-- exactly, plus cp.explore_rank).
drop view if exists public.discoverable_companions;
create view public.discoverable_companions
with (security_invoker = true) as
select
  p.id,
  p.first_name,
  left(p.last_name, 1) as last_initial,
  p.headline,
  p.bio,
  p.region,
  p.age_band,
  p.languages,
  p.mediums,
  p.style,
  p.avatar_path,
  p.photo_url,
  p.joined_at,
  cp.conversation_style,
  cp.is_accepting_new_members,
  cp.verification_status,
  cp.profile_completion_percentage,
  cp.explore_rank,
  cp.timezone,
  cp.minimum_notice_hours,
  cp.booking_horizon_days,
  coalesce(
    (select array_agg(i.name order by i.sort_order)
       from public.profile_interests pi
       join public.interests i on i.id = pi.interest_id and i.active
      where pi.profile_id = p.id),
    '{}'
  ) as interest_names,
  (select o.price_minor from public.conversation_offers o
    where o.companion_profile_id = p.id and o.offer_type = 'trial' and o.active
    limit 1) as trial_price_minor,
  (select o.duration_minutes from public.conversation_offers o
    where o.companion_profile_id = p.id and o.offer_type = 'trial' and o.active
    limit 1) as trial_duration_minutes,
  (select min(o.price_minor) from public.conversation_offers o
    where o.companion_profile_id = p.id and o.offer_type = 'single' and o.active
  ) as min_single_price_minor,
  coalesce(
    (select array_agg(distinct o.duration_minutes)
       from public.conversation_offers o
      where o.companion_profile_id = p.id and o.offer_type = 'single' and o.active),
    '{}'
  ) as single_durations,
  coalesce(
    (select array_agg(distinct ar.day_of_week)
       from public.availability_rules ar
      where ar.companion_profile_id = p.id and ar.active),
    '{}'
  ) as available_days,
  coalesce(
    (select array_agg(distinct dp.part)
       from public.availability_rules ar
       cross join lateral (
         select unnest(array_remove(array[
           case when ar.start_local_time < time '12:00' then 'morning' end,
           case when ar.start_local_time < time '17:00' and ar.end_local_time > time '12:00' then 'afternoon' end,
           case when ar.end_local_time > time '17:00' then 'evening' end
         ], null)) as part
       ) dp
      where ar.companion_profile_id = p.id and ar.active),
    '{}'
  ) as available_dayparts
from public.profiles p
left join public.companion_profiles cp on cp.profile_id = p.id
where p.role = 'companion'
  and p.profile_status = 'active'
  and p.visibility = 'public'
  and coalesce(p.avatar_path, p.photo_url) is not null
  and char_length(trim(coalesce(p.bio, ''))) >= 120
  and cp.moderation_status = 'approved'
  and not exists (
    select 1
    from public.user_blocks ub
    join public.profile_access pa on pa.profile_id = ub.member_profile_id
    where ub.companion_profile_id = p.id
      and ub.removed_at is null
      and pa.account_id = auth.uid()
      and pa.consent_status <> 'withdrawn'
  );
grant select on public.discoverable_companions to authenticated;

-- Admin-only setter (support-gated, audited). Takes the companion PROFILE id.
create or replace function public.admin_set_companion_rank(
  p_profile uuid, p_rank integer, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_from smallint;
begin
  if not app_private.is_support_admin() then
    raise exception 'unauthorised: support only';
  end if;
  if p_rank is null or p_rank < 1 or p_rank > 5 then
    raise exception 'invalid_rank: rank must be 1..5';
  end if;
  select explore_rank into v_from from public.companion_profiles where profile_id = p_profile for update;
  if v_from is null then raise exception 'not_found: companion'; end if;

  update public.companion_profiles
     set explore_rank = p_rank, updated_at = now()
   where profile_id = p_profile;

  -- Light audit trail via the access log (keyed to the owner account when known).
  insert into public.access_audit_log (target_account_id, actor_account_id, action, before_state, after_state, reason)
  select pa.account_id, auth.uid(), 'companion_rank_set',
         jsonb_build_object('explore_rank', v_from),
         jsonb_build_object('explore_rank', p_rank),
         p_reason
  from public.profile_access pa
  where pa.profile_id = p_profile and pa.access_role = 'owner'
  limit 1;

  return jsonb_build_object('ok', true, 'from', v_from, 'rank', p_rank);
end;
$$;
revoke all on function public.admin_set_companion_rank(uuid, integer, text) from public, anon;
grant execute on function public.admin_set_companion_rank(uuid, integer, text) to authenticated;

-- Surface the current explore_rank in the account detail so the console can show
-- it (mirrors the 0152 definition; adds explore_rank to the profile object).
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
        'explore_rank', (select cp.explore_rank from public.companion_profiles cp where cp.profile_id = pr.id),
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
