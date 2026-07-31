-- 0114 — Interest-based Member suggestions for a Companion (Companion Home).
--
-- Reuses the EXISTING introduction/privacy model: a Companion may only be
-- suggested Members who have favourited them (that is how a Member/Coordinator
-- signals openness to an introduction — the same gate companion_introduce uses).
-- The Member directory is never a public catalogue.
--
-- Security: caller must OWN the Companion profile; must hold product access
-- ('message_requests'); p_limit clamped 1..20. Returns SAFE fields only (first
-- name, shared-interest labels, relationship status) — never email/phone/
-- surname/address/health/billing/coordinator notes. Requires >= 1 shared
-- interest. Excludes blocked pairs. Reports relationship status so the client
-- shows Request an introduction / Introduction requested / Open messages —
-- no second introduction system is created. Additive; read-only. Apply after 0113.

set search_path = '';

create or replace function public.recommended_members_for_companion(
  p_companion_profile_id uuid, p_limit integer default 4)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 4), 1), 20);
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'unauthorised: sign in required' using errcode = '42501';
  end if;
  -- Caller must own this Companion profile.
  if not exists (
    select 1 from public.profile_access pa
    where pa.profile_id = p_companion_profile_id and pa.account_id = auth.uid()
      and pa.access_role = 'owner' and pa.consent_status <> 'withdrawn'
      and exists (select 1 from public.profiles p where p.id = p_companion_profile_id and p.role = 'companion')
  ) then
    raise exception 'not_found' using errcode = '42501';
  end if;
  -- Product-access gate (introductions are a messaging-family feature).
  if not app_private.account_has_feature(auth.uid(), 'message_requests') then
    raise exception 'pilot_access_inactive: suggestions not available' using errcode = 'P0001', hint = 'pilot_access_inactive';
  end if;

  with comp_interests as (
    select interest_id from public.profile_interests where profile_id = p_companion_profile_id
  ),
  favouriters as (
    -- Members whose owning/coordinating account favourited this Companion.
    select distinct mem.id as member_profile_id, mem.first_name
    from public.favourites f
    join public.profile_access rel
      on rel.account_id = f.account_id and rel.can_book and rel.consent_status <> 'withdrawn'
    join public.profiles mem on mem.id = rel.profile_id and mem.role = 'member' and mem.profile_status = 'active'
    where f.profile_id = p_companion_profile_id
  ),
  scored as (
    select
      fv.member_profile_id,
      fv.first_name,
      (select count(*)::int from public.profile_interests mi
         join comp_interests ci on ci.interest_id = mi.interest_id
        where mi.profile_id = fv.member_profile_id) as overlap,
      (select coalesce(jsonb_agg(i.name order by i.sort_order), '[]'::jsonb)
         from public.profile_interests mi
         join comp_interests ci on ci.interest_id = mi.interest_id
         join public.interests i on i.id = mi.interest_id
        where mi.profile_id = fv.member_profile_id and i.active) as shared_interests,
      coalesce((select c.status from public.conversations c
                 where c.member_profile_id = fv.member_profile_id
                   and c.companion_profile_id = p_companion_profile_id
                 limit 1), 'none') as relationship_status
    from favouriters fv
    where not app_private.active_block_between(fv.member_profile_id, p_companion_profile_id)
  )
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_result
  from (
    select member_profile_id,
           first_name as display_name,
           overlap,
           shared_interests,
           relationship_status
    from scored
    where overlap >= 1                 -- Companion suggestions require a shared interest
    order by overlap desc, member_profile_id
    limit v_limit
  ) x;

  return v_result;
end;
$$;
revoke all on function public.recommended_members_for_companion(uuid, integer) from public, anon;
grant execute on function public.recommended_members_for_companion(uuid, integer) to authenticated;

select pg_notify('pgrst', 'reload schema');
