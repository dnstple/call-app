-- ===========================================================================
-- 0170_remove_offer_dependency.sql  (Membership restructure — Phase 7)
--
-- The old model (companion-set offers / £5 trial) is retired. Companions no
-- longer create conversation_offers, so anything that REQUIRED an offer would now
-- hide every companion. This redefines recommendations to:
--   * NOT require an active offer,
--   * drop the offer-derived price/trial fields,
--   * order by the admin Explore rank (5 = top) first.
--
-- The conversation_offers table itself is intentionally LEFT IN PLACE (empty /
-- historical) so existing bookings.offer_id and earnings don't break; it can be
-- dropped later once fully migrated.
-- ===========================================================================

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
  if not app_private.can_act_for_member(p_member_profile_id) then
    raise exception 'not_found' using errcode = '42501';
  end if;
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
      cp.explore_rank as rank,
      (select count(*)::int from public.profile_interests ci
         join member_interests mi on mi.interest_id = ci.interest_id
        where ci.profile_id = c.id) as overlap,
      (select coalesce(jsonb_agg(i.name order by i.sort_order), '[]'::jsonb)
         from public.profile_interests ci
         join member_interests mi on mi.interest_id = ci.interest_id
         join public.interests i on i.id = ci.interest_id
        where ci.profile_id = c.id and i.active) as shared_interests
    from public.profiles c
    join public.companion_profiles cp on cp.profile_id = c.id
    where c.role = 'companion'
      and app_private.is_discoverable_companion(c.id)
      and cp.is_accepting_new_members
      and not app_private.companion_is_suspended(c.id)
      and not app_private.active_block_between(p_member_profile_id, c.id)
      and coalesce(c.avatar_path, c.photo_url) is not null
      and char_length(trim(coalesce(c.bio, ''))) >= 120
      and cp.moderation_status = 'approved'
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
      (completion >= 60) as profile_ready
    from candidates
    order by rank desc, overlap desc, completion desc, companion_profile_id
    limit v_limit
  ) x;

  return v_result;
end;
$$;

select pg_notify('pgrst', 'reload schema');
