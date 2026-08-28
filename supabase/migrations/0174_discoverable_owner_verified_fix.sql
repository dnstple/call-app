-- ===========================================================================
-- 0174_discoverable_owner_verified_fix.sql
--
-- Fix: the owner_verified column added in 0172 always returned false for other
-- users. discoverable_companions is a security_invoker view, so its inline
-- subquery over public.accounts ran under the VIEWER's RLS — and accounts has a
-- strict "read own" policy (id = auth.uid()). A viewer therefore can't see any
-- other account's phone_verified, so the blue "Verified" badge never appeared.
--
-- Use the existing SECURITY DEFINER helper public.profile_owner_verified(uuid)
-- (0171) instead. Called from the invoker view it runs with definer rights,
-- reads the owner's verification safely, and returns only a boolean — no phone
-- number or personal data is exposed. Definition otherwise mirrors 0172.
-- ===========================================================================

set search_path = '';

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
  -- Owner phone-verified flag via the SECURITY DEFINER helper so it isn't blocked
  -- by the viewer's row-level security on public.accounts.
  coalesce(public.profile_owner_verified(p.id), false) as owner_verified,
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

select pg_notify('pgrst', 'reload schema');
