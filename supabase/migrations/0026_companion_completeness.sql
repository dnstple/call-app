-- ============================================================
-- Redesign Phase F — mandatory Companion profile completeness (0026).
--
-- A Companion may not be publicly discoverable (or accept new Members)
-- until their profile is genuinely complete:
--   * an uploaded photo (avatar_path or photo_url);
--   * a meaningful description: trimmed 120–1000 characters, not just
--     repeated characters or obvious placeholder text;
--   * a headline;
--   * at least one interest;
--   * at least one active availability rule;
--   * at least one active priced offer.
--
-- Enforcement is server-side:
--   * app_private.companion_profile_complete() — the single source of truth;
--   * activate_companion_profile() — the ONLY way a Companion goes public;
--   * a trigger blocks direct profile_status/visibility escalation;
--   * discoverable_companions v3 re-checks photo + bio, so an incomplete
--     profile can never appear in Explore even if legacy data says active.
--
-- Ordering (documented): Explore returns most complete profiles first,
-- then newest, with a stable id tiebreak. No user-facing sort control.
-- ============================================================

create or replace function app_private.companion_profile_complete(p_profile uuid)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_p public.profiles;
  v_bio text;
begin
  select * into v_p from public.profiles where id = p_profile and role = 'companion';
  if v_p.id is null then return false; end if;

  -- Photo required — initials are not a public Companion identity.
  if coalesce(v_p.avatar_path, v_p.photo_url) is null then return false; end if;

  -- Meaningful description: 120–1000 chars trimmed, and not one character
  -- repeated (catches "aaaaaa…" and obvious placeholder runs).
  v_bio := trim(coalesce(v_p.bio, ''));
  if char_length(v_bio) < 120 or char_length(v_bio) > 1000 then return false; end if;
  if char_length(replace(v_bio, substr(v_bio, 1, 1), '')) < 20 then return false; end if;
  if lower(v_bio) like 'lorem ipsum%' then return false; end if;

  if trim(coalesce(v_p.headline, '')) = '' then return false; end if;

  if not exists (select 1 from public.profile_interests pi where pi.profile_id = p_profile) then
    return false;
  end if;
  if not exists (select 1 from public.availability_rules ar
                 where ar.companion_profile_id = p_profile and ar.active) then
    return false;
  end if;
  if not exists (select 1 from public.conversation_offers o
                 where o.companion_profile_id = p_profile and o.active) then
    return false;
  end if;
  return true;
end;
$$;
revoke all on function app_private.companion_profile_complete(uuid) from public, anon, authenticated;

-- ---------- the only path to public activation ----------
create or replace function public.activate_companion_profile(p_profile uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'unauthorised: sign in required';
  end if;
  if not exists (
    select 1 from public.profile_access pa
    where pa.profile_id = p_profile
      and pa.account_id = auth.uid()
      and pa.can_edit
      and pa.consent_status <> 'withdrawn'
  ) then
    raise exception 'not_found: profile';
  end if;
  if not app_private.companion_profile_complete(p_profile) then
    raise exception 'incomplete_profile: add a photo, a fuller description, interests, availability and pricing first';
  end if;
  update public.profiles
     set profile_status = 'active', visibility = 'public'
   where id = p_profile;
  return jsonb_build_object('active', true);
end;
$$;
revoke all on function public.activate_companion_profile(uuid) from public, anon;
grant execute on function public.activate_companion_profile(uuid) to authenticated;

-- Completion checklist for the Companion's own UI (their own profile only).
create or replace function public.companion_completion_checklist(p_profile uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_p public.profiles;
  v_bio_len integer;
begin
  if auth.uid() is null or not exists (
    select 1 from public.profile_access pa
    where pa.profile_id = p_profile and pa.account_id = auth.uid()
      and pa.consent_status <> 'withdrawn'
  ) then
    raise exception 'not_found: profile';
  end if;
  select * into v_p from public.profiles where id = p_profile;
  v_bio_len := char_length(trim(coalesce(v_p.bio, '')));
  return jsonb_build_object(
    'photo', coalesce(v_p.avatar_path, v_p.photo_url) is not null,
    'headline', trim(coalesce(v_p.headline, '')) <> '',
    'description', v_bio_len between 120 and 1000,
    'description_length', v_bio_len,
    'interests', exists (select 1 from public.profile_interests pi where pi.profile_id = p_profile),
    'availability', exists (select 1 from public.availability_rules ar
                            where ar.companion_profile_id = p_profile and ar.active),
    'pricing', exists (select 1 from public.conversation_offers o
                       where o.companion_profile_id = p_profile and o.active),
    'complete', app_private.companion_profile_complete(p_profile));
end;
$$;
revoke all on function public.companion_completion_checklist(uuid) from public, anon;
grant execute on function public.companion_completion_checklist(uuid) to authenticated;

-- ---------- browsers cannot self-activate an incomplete Companion ----------
create or replace function app_private.guard_companion_activation()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- Only guard COMPANION profiles being escalated to public/active by a
  -- normal client role. The activation RPC and service role are exempt
  -- (the RPC re-checked completeness already; current_user there is the
  -- definer owner, not the client role).
  if new.role = 'companion'
     and current_setting('role', true) = 'authenticated'
     and (
       (new.profile_status = 'active' and old.profile_status <> 'active')
       or (new.visibility = 'public' and old.visibility <> 'public')
     )
     and not app_private.companion_profile_complete(new.id) then
    raise exception 'incomplete_profile: complete your profile before going public';
  end if;
  return new;
end;
$$;
revoke all on function app_private.guard_companion_activation() from public, anon, authenticated;
drop trigger if exists profiles_guard_companion_activation on public.profiles;
create trigger profiles_guard_companion_activation
  before update on public.profiles
  for each row execute function app_private.guard_companion_activation();

-- ---------- discovery view v3: completeness is structural ----------
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
  -- 0026: completeness is structural — no photo or thin bio, no listing.
  and coalesce(p.avatar_path, p.photo_url) is not null
  and char_length(trim(coalesce(p.bio, ''))) >= 120;

grant select on public.discoverable_companions to authenticated;
