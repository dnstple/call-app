-- 0112 — Interest-based Companion recommendations for a Member (Home matching).
--
-- Authoritative, deterministic recommendation authority. NOT an auto-booking
-- system: it only ranks eligible Companions by shared-interest overlap and
-- returns SAFE display fields; the user still views, chooses, and books.
--
-- Security:
--   * caller must be authorised for the Member profile (app_private.
--     can_act_for_member — self-managed Member or their Coordinator);
--   * caller's account must hold product access (feature 'explore') — waitlisted
--     / blocked accounts are refused with pilot_access_inactive (fail closed);
--   * p_limit is clamped server-side (1..20) — no unbounded enumeration;
--   * a Companion is only returned if discoverable (active + public), accepting
--     new Members, not suspended, not blocked in either direction, whose owner
--     account has pilot/full access, and who has at least one active offer;
--   * only safe public fields are returned (first name + last initial, photo,
--     bio excerpt, shared interest labels, offer summary) — never private data.
--
-- score = number of overlapping active interest IDs (no sensitive criteria, no
-- ratings/price as the primary score). Rank: overlap desc, then profile
-- completeness, then a stable id tie-breaker. Zero-overlap eligible Companions
-- are still returned (ranked last) so the client can show a clearly-labelled
-- "available to meet" fallback — the client distinguishes them by overlap = 0.
--
-- Additive; read-only. Apply hosted after 0111.

set search_path = '';

create or replace function public.recommended_companions_for_member(
  p_member_profile_id uuid, p_limit integer default 4)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 4), 1), 20);
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'unauthorised: sign in required' using errcode = '42501';
  end if;
  -- Relationship check: only a self-managed Member or their Coordinator.
  if not app_private.can_act_for_member(p_member_profile_id) then
    raise exception 'not_found' using errcode = '42501';
  end if;
  -- Product-access gate: matching is not available to waitlisted/blocked accounts.
  if not app_private.account_has_feature(auth.uid(), 'explore') then
    raise exception 'pilot_access_inactive: matching not available' using errcode = 'P0001', hint = 'pilot_access_inactive';
  end if;

  with member_interests as (
    select interest_id from public.profile_interests where profile_id = p_member_profile_id
  ),
  candidates as (
    select
      c.id as companion_profile_id,
      c.first_name,
      c.last_name,
      c.photo_url,
      c.bio,
      cp.profile_completion_percentage as completion,
      (select count(*)::int from public.profile_interests ci
         join member_interests mi on mi.interest_id = ci.interest_id
        where ci.profile_id = c.id) as overlap,
      (select coalesce(jsonb_agg(i.name order by i.sort_order), '[]'::jsonb)
         from public.profile_interests ci
         join member_interests mi on mi.interest_id = ci.interest_id
         join public.interests i on i.id = ci.interest_id
        where ci.profile_id = c.id and i.active) as shared_interests,
      exists (select 1 from public.conversation_offers o
               where o.companion_profile_id = c.id and o.active and o.offer_type = 'trial') as offers_trial,
      (select min(o.price_minor) from public.conversation_offers o
         where o.companion_profile_id = c.id and o.active and o.offer_type <> 'trial') as from_price_minor,
      (select min(o.price_minor) from public.conversation_offers o
         where o.companion_profile_id = c.id and o.active and o.offer_type = 'trial') as trial_price_minor
    from public.profiles c
    join public.companion_profiles cp on cp.profile_id = c.id
    where c.role = 'companion'
      and app_private.is_discoverable_companion(c.id)               -- companion + active + public
      and cp.is_accepting_new_members
      and not app_private.companion_is_suspended(c.id)               -- moderation
      and not app_private.active_block_between(p_member_profile_id, c.id)  -- blocks either way
      and exists (                                                  -- owner has product access
        select 1 from public.profile_access pa
        join public.account_access aa on aa.account_id = pa.account_id
        where pa.profile_id = c.id and pa.access_role = 'owner'
          and aa.access_level in ('pilot', 'full')
      )
      and exists (select 1 from public.conversation_offers o        -- has a bookable offer
                   where o.companion_profile_id = c.id and o.active)
      and (coalesce(c.photo_url, '') <> '' or length(btrim(coalesce(c.bio, ''))) > 0)  -- display-ready
  )
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_result
  from (
    select
      companion_profile_id,
      trim(first_name || case when coalesce(last_name,'') <> '' then ' ' || left(last_name, 1) || '.' else '' end) as display_name,
      case when length(btrim(coalesce(bio,''))) > 0 then left(btrim(bio), 160) else null end as bio_excerpt,
      photo_url,
      overlap,
      shared_interests,
      offers_trial,
      from_price_minor,
      trial_price_minor,
      (completion >= 60) as profile_ready
    from candidates
    order by overlap desc, completion desc, companion_profile_id
    limit v_limit
  ) x;

  return v_result;
end;
$$;
revoke all on function public.recommended_companions_for_member(uuid, integer) from public, anon;
grant execute on function public.recommended_companions_for_member(uuid, integer) to authenticated;

select pg_notify('pgrst', 'reload schema');
