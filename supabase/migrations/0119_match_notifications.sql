-- 0119 — In-app match / introduction notifications.
--
-- The bell counterpart to the email digest (0117). A service-role batch drops an
-- in-app notification when a genuinely NEW match appears: for a Member, a newly
-- eligible Companion who shares interests; for a Companion, a new favouriter who
-- shares interests. Reuses the authoritative eligibility of 0112/0114.
--
-- Calm by construction:
--   * IN-APP ONLY — the notification types map to no email category (0093), so
--     no per-event email is ever sent; email stays batched in the weekly digest;
--   * deduped per subject — each Companion/Member is announced at most once ever
--     (unique (user_id, dedupe_key));
--   * per-account cap each run so a first run can never flood the bell.
-- Additive. Apply after 0118.

set search_path = '';

-- ---------- internal candidate id helpers (no auth.uid; parameterised) ----------
-- Eligible Companions sharing >= 1 interest with the Member (mirrors 0112),
-- best first, with a safe display name.
create or replace function app_private.member_match_ids(p_member_profile_id uuid, p_limit integer default 20)
returns table (companion_profile_id uuid, display_name text)
language sql stable security definer set search_path = '' as $$
  with mi as (select interest_id from public.profile_interests where profile_id = p_member_profile_id)
  select c.id,
         trim(c.first_name || case when coalesce(c.last_name,'') <> '' then ' ' || left(c.last_name, 1) || '.' else '' end)
  from public.profiles c
  join public.companion_profiles cp on cp.profile_id = c.id
  where c.role = 'companion'
    and app_private.is_discoverable_companion(c.id)
    and cp.is_accepting_new_members
    and not app_private.companion_is_suspended(c.id)
    and not app_private.active_block_between(p_member_profile_id, c.id)
    and exists (
      select 1 from public.profile_access pa
      join public.account_access aa on aa.account_id = pa.account_id
      where pa.profile_id = c.id and pa.access_role = 'owner' and aa.access_level in ('pilot', 'full'))
    and exists (select 1 from public.conversation_offers o where o.companion_profile_id = c.id and o.active)
    and (coalesce(c.photo_url, '') <> '' or length(btrim(coalesce(c.bio, ''))) > 0)
    and (select count(*) from public.profile_interests ci
         join mi on mi.interest_id = ci.interest_id where ci.profile_id = c.id) >= 1
  order by (select count(*) from public.profile_interests ci
            join mi on mi.interest_id = ci.interest_id where ci.profile_id = c.id) desc,
           cp.profile_completion_percentage desc, c.id
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;
revoke all on function app_private.member_match_ids(uuid, integer) from public, anon, authenticated;

-- Favouriter Members sharing >= 1 interest with the Companion (mirrors 0114).
create or replace function app_private.companion_favouriter_ids(p_companion_profile_id uuid, p_limit integer default 20)
returns table (member_profile_id uuid, first_name text)
language sql stable security definer set search_path = '' as $$
  with ci as (select interest_id from public.profile_interests where profile_id = p_companion_profile_id)
  select mem.id, mem.first_name
  from public.favourites f
  join public.profile_access rel
    on rel.account_id = f.account_id and rel.can_book and rel.consent_status <> 'withdrawn'
  join public.profiles mem on mem.id = rel.profile_id and mem.role = 'member' and mem.profile_status = 'active'
  where f.profile_id = p_companion_profile_id
    and not app_private.active_block_between(mem.id, p_companion_profile_id)
    and (select count(*) from public.profile_interests mi
         join ci on ci.interest_id = mi.interest_id where mi.profile_id = mem.id) >= 1
  group by mem.id, mem.first_name
  order by (select count(*) from public.profile_interests mi
            join ci on ci.interest_id = mi.interest_id where mi.profile_id = mem.id) desc, mem.id
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;
revoke all on function app_private.companion_favouriter_ids(uuid, integer) from public, anon, authenticated;

-- ---------- the notifier (service role) ----------
create or replace function public.run_match_notifications(
  p_limit integer default 500,
  p_per_account integer default 3)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r record; prof record; cand record;
  v_cap int := greatest(1, least(coalesce(p_per_account, 3), 20));
  v_made int := 0;
  v_inserted int;
begin
  for r in (
    select distinct pa.account_id
    from public.profile_access pa
    join public.profiles p on p.id = pa.profile_id and p.profile_status = 'active'
    where pa.consent_status <> 'withdrawn' and pa.access_role in ('owner', 'coordinator')
    limit greatest(1, least(coalesce(p_limit, 500), 5000))
  ) loop
    -- Member side: newly eligible Companions who share interests.
    if app_private.account_has_feature(r.account_id, 'explore') then
      for prof in (
        select pa.profile_id from public.profile_access pa
        join public.profiles p on p.id = pa.profile_id and p.role = 'member' and p.profile_status = 'active'
        where pa.account_id = r.account_id and pa.access_role in ('owner', 'coordinator')
          and pa.consent_status <> 'withdrawn'
      ) loop
        v_inserted := 0;
        for cand in (select * from app_private.member_match_ids(prof.profile_id, 25)) loop
          exit when v_inserted >= v_cap;
          insert into public.notifications (user_id, type, title, body, dedupe_key)
          values (r.account_id, 'match_available', 'A companion who shares your interests',
                  cand.display_name || ' shares interests with you — open your home page to see if they’re a good fit.',
                  'match_available:' || cand.companion_profile_id::text)
          on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
          if found then v_inserted := v_inserted + 1; v_made := v_made + 1; end if;
        end loop;
      end loop;
    end if;

    -- Companion side: new favouriters who share interests (introduction openings).
    if app_private.account_has_feature(r.account_id, 'message_requests') then
      for prof in (
        select pa.profile_id from public.profile_access pa
        join public.profiles p on p.id = pa.profile_id and p.role = 'companion' and p.profile_status = 'active'
        where pa.account_id = r.account_id and pa.access_role = 'owner' and pa.consent_status <> 'withdrawn'
      ) loop
        v_inserted := 0;
        for cand in (select * from app_private.companion_favouriter_ids(prof.profile_id, 25)) loop
          exit when v_inserted >= v_cap;
          insert into public.notifications (user_id, type, title, body, dedupe_key)
          values (r.account_id, 'companion_introduction_suggested', 'Someone who shares your interests',
                  cand.first_name || ' follows you and shares your interests — you can send an introduction from your home page.',
                  'companion_intro:' || cand.member_profile_id::text)
          on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
          if found then v_inserted := v_inserted + 1; v_made := v_made + 1; end if;
        end loop;
      end loop;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'notifications_created', v_made);
end;
$$;
revoke all on function public.run_match_notifications(integer, integer) from public, anon, authenticated;
grant execute on function public.run_match_notifications(integer, integer) to service_role;

select pg_notify('pgrst', 'reload schema');
