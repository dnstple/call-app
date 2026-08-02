-- 0117 — Communications: match/introduction digest assembler.
--
-- A service-role batch job (cron/dispatcher seam, same pattern as the email
-- dispatcher and booking reminders) that turns "there is something worth coming
-- back for" into AT MOST ONE quiet digest email per account per week. It reuses
-- the authoritative eligibility of 0112/0114 (interest overlap, discoverability,
-- blocks, product access, favouriter-only member pool) via internal count
-- helpers, and the durable outbox of 0093/0116.
--
-- Guarantees:
--   * frequency cap — never more than one digest per account per interval
--     (default 7 days), enforced by match_digest_log AND an ISO-week dedupe key;
--   * quiet hours honoured — an account inside its window is deferred, not
--     dropped (a later run outside the window will pick it up);
--   * opt-out honoured and auditable — a suppressed outbox row is recorded, no
--     send happens (mirrors the 0093 suppressed lifecycle);
--   * nothing to say => nothing enqueued (no empty nudges);
--   * safe copy only — no counts, no names, no pressure.
-- No provider is contacted here. Additive. Apply after 0116.

set search_path = '';

-- ---------- internal freshness counts (no auth.uid; parameterised) ----------
-- Eligible discoverable companions who share >= 1 active interest with the
-- member. Mirrors recommended_companions_for_member (0112) exactly.
create or replace function app_private.member_match_count(p_member_profile_id uuid)
returns integer language sql stable security definer set search_path = '' as $$
  with mi as (select interest_id from public.profile_interests where profile_id = p_member_profile_id)
  select count(*)::int
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
      where pa.profile_id = c.id and pa.access_role = 'owner'
        and aa.access_level in ('pilot', 'full'))
    and exists (select 1 from public.conversation_offers o
                 where o.companion_profile_id = c.id and o.active)
    and (coalesce(c.photo_url, '') <> '' or length(btrim(coalesce(c.bio, ''))) > 0)
    and (select count(*) from public.profile_interests ci
         join mi on mi.interest_id = ci.interest_id where ci.profile_id = c.id) >= 1;
$$;
revoke all on function app_private.member_match_count(uuid) from public, anon, authenticated;

-- Favouriters (members whose account favourited this companion) who share >= 1
-- interest and are not blocked. Mirrors recommended_members_for_companion (0114).
create or replace function app_private.companion_suggestion_count(p_companion_profile_id uuid)
returns integer language sql stable security definer set search_path = '' as $$
  with ci as (select interest_id from public.profile_interests where profile_id = p_companion_profile_id)
  select count(*)::int from (
    select mem.id
    from public.favourites f
    join public.profile_access rel
      on rel.account_id = f.account_id and rel.can_book and rel.consent_status <> 'withdrawn'
    join public.profiles mem on mem.id = rel.profile_id and mem.role = 'member' and mem.profile_status = 'active'
    where f.profile_id = p_companion_profile_id
      and not app_private.active_block_between(mem.id, p_companion_profile_id)
      and (select count(*) from public.profile_interests mi
           join ci on ci.interest_id = mi.interest_id where mi.profile_id = mem.id) >= 1
    group by mem.id
  ) s;
$$;
revoke all on function app_private.companion_suggestion_count(uuid) from public, anon, authenticated;

-- ---------- durable digest audit / frequency-cap log ----------
create table if not exists public.match_digest_log (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references public.accounts(id) on delete cascade,
  member_matches        integer not null default 0,
  companion_suggestions integer not null default 0,
  status                text not null check (status in ('enqueued', 'suppressed')),
  created_at            timestamptz not null default now()
);
alter table public.match_digest_log enable row level security;  -- internal only; no client policy
create index if not exists match_digest_log_account_idx
  on public.match_digest_log (account_id, created_at desc);

-- ---------- the assembler (service role) ----------
create or replace function public.run_match_digests(
  p_limit integer default 500,
  p_min_interval_days integer default 7,
  p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_considered      int := 0;
  v_enqueued        int := 0;
  v_suppressed      int := 0;
  v_deferred        int := 0;
  v_skipped_recent  int := 0;
  v_member          int;
  v_companion       int;
  v_email           text;
  v_optin           boolean;
  v_subject         text;
  v_body            text;
  v_dedupe          text;
  v_status          text;
begin
  for r in (
    select distinct pa.account_id as account_id
    from public.profile_access pa
    join public.profiles p on p.id = pa.profile_id and p.profile_status = 'active'
    where pa.consent_status <> 'withdrawn'
      and pa.access_role in ('owner', 'coordinator')
    limit greatest(1, least(coalesce(p_limit, 500), 5000))
  ) loop
    v_considered := v_considered + 1;

    -- Frequency cap: at most one digest per account per interval.
    if exists (
      select 1 from public.match_digest_log l
      where l.account_id = r.account_id
        and l.created_at > p_now - make_interval(days => greatest(1, coalesce(p_min_interval_days, 7)))
    ) then
      v_skipped_recent := v_skipped_recent + 1;
      continue;
    end if;

    -- Count eligible items across the profiles this account acts for (feature-gated).
    v_member := 0; v_companion := 0;
    if app_private.account_has_feature(r.account_id, 'explore') then
      select coalesce(sum(app_private.member_match_count(pa.profile_id)), 0) into v_member
      from public.profile_access pa
      join public.profiles p on p.id = pa.profile_id and p.role = 'member' and p.profile_status = 'active'
      where pa.account_id = r.account_id and pa.access_role in ('owner', 'coordinator')
        and pa.consent_status <> 'withdrawn';
    end if;
    if app_private.account_has_feature(r.account_id, 'message_requests') then
      select coalesce(sum(app_private.companion_suggestion_count(pa.profile_id)), 0) into v_companion
      from public.profile_access pa
      join public.profiles p on p.id = pa.profile_id and p.role = 'companion' and p.profile_status = 'active'
      where pa.account_id = r.account_id and pa.access_role = 'owner'
        and pa.consent_status <> 'withdrawn';
    end if;

    if (coalesce(v_member, 0) + coalesce(v_companion, 0)) = 0 then
      continue;  -- nothing worth surfacing; no log, re-checked cheaply next run
    end if;

    -- Quiet hours: defer to a later run outside the window (do not drop or log).
    if app_private.within_quiet_hours(r.account_id, p_now) then
      v_deferred := v_deferred + 1;
      continue;
    end if;

    v_email := app_private.account_email(r.account_id);
    if v_email is null then
      continue;  -- no deliverable address
    end if;

    v_optin  := app_private.email_opted_in(r.account_id, 'matches');
    v_status := case when v_optin then 'pending' else 'suppressed' end;
    v_dedupe := 'email:match-digest:' || r.account_id::text || ':' || to_char(p_now, 'IYYY-IW');

    v_subject := 'New suggestions on your companionship app';
    v_body := case
      when v_member > 0 and v_companion > 0 then
        'There are companions who share your interests, and members who follow you and share yours. '
        || 'Open the app when you have a moment to see your suggestions — there is never any obligation.'
      when v_member > 0 then
        'There are companions who share your interests. Open the app when you have a moment to see who '
        || 'might be a good fit — there is never any obligation.'
      else
        'Some members who follow you share your interests. When you are ready, you can send an '
        || 'introduction from your home page.'
    end;

    insert into public.email_outbox
      (account_id, to_email, category, template_key, subject, body_text, notification_id, dedupe_key, status)
    values (r.account_id, v_email, 'matches', 'digest:matches', v_subject, v_body, null, v_dedupe, v_status)
    on conflict (dedupe_key) where dedupe_key is not null do nothing;

    if not found then
      continue;  -- this week's digest already exists (dedupe); do not double-log
    end if;

    insert into public.match_digest_log (account_id, member_matches, companion_suggestions, status)
    values (r.account_id, coalesce(v_member, 0), coalesce(v_companion, 0),
            case when v_optin then 'enqueued' else 'suppressed' end);

    if v_optin then v_enqueued := v_enqueued + 1; else v_suppressed := v_suppressed + 1; end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'considered', v_considered,
    'enqueued', v_enqueued,
    'suppressed', v_suppressed,
    'deferred_quiet_hours', v_deferred,
    'skipped_recent', v_skipped_recent);
end;
$$;
revoke all on function public.run_match_digests(integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.run_match_digests(integer, integer, timestamptz) to service_role;

select pg_notify('pgrst', 'reload schema');
