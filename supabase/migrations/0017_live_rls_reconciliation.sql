-- ============================================================
-- 0017 — live-suite reconciliation. Three small, additive repairs
-- found by the first real RLS integration run. No table changes,
-- no data changes, no RLS policy changes, no behaviour changes.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Remove ambiguous plan-RPC overloads.
--
-- 0013 recreated create_conversation_plan and accept_plan with an added
-- p_message parameter, but CREATE OR REPLACE with a different signature
-- creates an OVERLOAD — the 0011 originals survived. A PostgREST call
-- without p_message then matches both and fails as ambiguous.
--
-- Only the obsolete exact signatures are dropped; the canonical
-- p_message-bearing functions (0013) remain, and p_message defaults to
-- null, so every existing frontend call stays compatible.
-- ------------------------------------------------------------
drop function if exists public.create_conversation_plan(uuid, uuid, integer, integer, text, jsonb);
drop function if exists public.accept_plan(uuid);

-- ------------------------------------------------------------
-- 2. replace_profile_interests: authorised SECURITY DEFINER boundary.
--
-- The 0003 version was SECURITY INVOKER but calls
-- app_private.can_edit_profile — and authenticated clients rightly have
-- NO usage on app_private, so every live call failed with "permission
-- denied for schema app_private".
--
-- The fix is a narrow definer boundary, not a schema grant: the function
-- itself performs the explicit ownership check (can_edit_profile), pins
-- an empty search_path, fully qualifies every relation, writes only rows
-- for the checked profile, and is executable by authenticated only.
-- app_private stays closed to clients; profile_interests keeps its RLS
-- for any direct access.
-- ------------------------------------------------------------
create or replace function public.replace_profile_interests(
  p_profile uuid,
  p_interest_ids uuid[]
)
returns setof public.interests
language plpgsql security definer
set search_path = ''
as $$
declare
  v_valid_count integer;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  -- Explicit ownership check — the ONLY authority for this write.
  if not app_private.can_edit_profile(p_profile) then
    raise exception 'You cannot edit this profile';
  end if;

  select count(*) into v_valid_count
  from public.interests i
  where i.id = any (p_interest_ids) and i.active;
  if v_valid_count <> coalesce(array_length(p_interest_ids, 1), 0) then
    raise exception 'One or more interests are invalid';
  end if;

  delete from public.profile_interests
   where profile_id = p_profile
     and interest_id <> all (coalesce(p_interest_ids, '{}'));

  insert into public.profile_interests (profile_id, interest_id)
  select p_profile, unnest(p_interest_ids)
  on conflict (profile_id, interest_id) do nothing;

  return query
    select i.* from public.interests i
    join public.profile_interests pi on pi.interest_id = i.id
    where pi.profile_id = p_profile
    order by i.sort_order;
end;
$$;
revoke all on function public.replace_profile_interests(uuid, uuid[]) from public, anon;
grant execute on function public.replace_profile_interests(uuid, uuid[]) to authenticated;
