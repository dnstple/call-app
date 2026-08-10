-- 0145 — Consent is no longer a blocker to discovery or to requesting a call;
-- it is enforced at the MEETING (call join) instead.
--
-- Change of policy: a Companion should be visible in Explore, and a Member
-- should be able to request/converse, WITHOUT either party having signed the
-- current Community Agreement yet. Both parties must still sign before they can
-- JOIN the call (the "first meeting"). The frontend still prompts them to sign
-- (at sign-up / on login), but no longer hard-blocks the app.
--
-- What changes here:
--   1. discoverable_companions view — drop the companion-consent condition.
--   2. Booking-creation gate — drop the consent checks (keep block + approval).
--   3. Conversation-creation gate — drop the consent checks (keep block + approval).
-- What stays (the meeting gate): call_join_eligibility (0092) still requires BOTH
--   parties' current consent, so nobody takes a call without having signed.

set search_path = '';

-- ------------------------------------------------------------
-- 1. Discovery view — identical to 0092 but WITHOUT the consent condition.
-- ------------------------------------------------------------
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
  -- Consent is NO LONGER a discovery blocker (0145) — enforced at call join.
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

-- ------------------------------------------------------------
-- 2. Booking-creation gate — block + approval only (consent moved to call join).
-- ------------------------------------------------------------
create or replace function app_private.enforce_booking_trust()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if app_private.active_block_between(new.member_profile_id, new.companion_profile_id) then
    raise exception 'blocked: this booking cannot be created while a block is in place'
      using errcode = 'check_violation';
  end if;
  if not app_private.companion_is_approved(new.companion_profile_id) then
    raise exception 'companion_not_bookable: this companion is not currently accepting bookings'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function app_private.enforce_booking_trust() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Conversation-creation gate — block + availability only (consent at call join).
-- ------------------------------------------------------------
create or replace function app_private.enforce_conversation_trust()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if app_private.active_block_between(new.member_profile_id, new.companion_profile_id) then
    raise exception 'blocked: this conversation cannot be started while a block is in place'
      using errcode = 'check_violation';
  end if;
  if app_private.companion_is_suspended(new.companion_profile_id)
     or not app_private.companion_is_approved(new.companion_profile_id) then
    raise exception 'companion_unavailable: this companion is not currently available'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function app_private.enforce_conversation_trust() from public, anon, authenticated;

select pg_notify('pgrst', 'reload schema');
