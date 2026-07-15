-- ============================================================
-- Stage 2C2 — real Companion availability, scheduling settings
-- and conversation offers (trial + single). No bookings yet.
--
-- Adapts the unused Stage-1 availability tables (no data, no
-- write policies existed) to the product model:
--   * ISO day-of-week (1 = Monday … 7 = Sunday)
--   * minute-precision local time windows + IANA timezone
--   * scheduling settings live on companion_profiles
--   * money in integer minor units (GBP pence)
-- ============================================================

-- ---------- availability_rules: reshape ----------
alter table public.availability_rules rename column companion_id to companion_profile_id;
alter table public.availability_rules rename column weekday to day_of_week;
alter table public.availability_rules rename column time_zone to timezone;

alter table public.availability_rules
  add column start_local_time time,
  add column end_local_time time,
  add column active boolean not null default true,
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now();

-- Migrate any existing hour-based rows, then convert 0=Sunday → ISO 7.
update public.availability_rules
   set start_local_time = make_time(start_hour, 0, 0),
       end_local_time = make_time(end_hour, 0, 0),
       day_of_week = case when day_of_week = 0 then 7 else day_of_week end;

alter table public.availability_rules
  drop column start_hour,
  drop column end_hour,
  drop column min_notice_hours,
  drop column booking_horizon_days,
  alter column start_local_time set not null,
  alter column end_local_time set not null,
  add constraint availability_day_iso check (day_of_week between 1 and 7),
  add constraint availability_window_valid check (start_local_time < end_local_time),
  add constraint availability_timezone_present check (length(trim(timezone)) > 0);

create index availability_rules_profile_day_idx
  on public.availability_rules (companion_profile_id, day_of_week);

-- ---------- availability_exceptions: reshape ----------
alter table public.availability_exceptions rename column companion_id to companion_profile_id;
alter table public.availability_exceptions rename column reason to note;

alter table public.availability_exceptions
  add column starts_at timestamptz,
  add column ends_at timestamptz,
  add column exception_type text,
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now();

update public.availability_exceptions
   set starts_at = date::timestamptz,
       ends_at = (date + 1)::timestamptz,
       exception_type = case when available then 'additionally_available' else 'unavailable' end;

alter table public.availability_exceptions
  drop column date,
  drop column available,
  alter column starts_at set not null,
  alter column ends_at set not null,
  alter column exception_type set not null,
  add constraint exception_range_valid check (starts_at < ends_at),
  add constraint exception_type_valid
    check (exception_type in ('unavailable', 'additionally_available'));

create index availability_exceptions_profile_idx
  on public.availability_exceptions (companion_profile_id, starts_at);

-- ---------- companion scheduling settings ----------
alter table public.companion_profiles
  add column timezone text not null default 'Europe/London',
  add column minimum_notice_hours integer not null default 24
    check (minimum_notice_hours between 0 and 336),
  add column booking_horizon_days integer not null default 60
    check (booking_horizon_days between 1 and 365);

-- ---------- conversation offers ----------
-- Money is stored as integer minor units (£5.00 = 500). GBP only for now,
-- currency kept explicit for later expansion. No packages in this milestone.
create table public.conversation_offers (
  id uuid primary key default gen_random_uuid(),
  companion_profile_id uuid not null references public.profiles(id) on delete cascade,
  offer_type text not null check (offer_type in ('trial', 'single')),
  title text not null default '',
  duration_minutes integer not null check (duration_minutes in (15, 30, 45, 60)),
  price_minor integer not null check (price_minor between 100 and 100000), -- £1–£1000
  currency text not null default 'GBP' check (currency = 'GBP'),
  supported_methods text[] not null default '{}',
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active trial offer per Companion.
create unique index one_active_trial_per_companion
  on public.conversation_offers (companion_profile_id)
  where (offer_type = 'trial' and active);

-- No confusing duplicates: one active single offer per duration+currency.
create unique index one_active_single_per_duration
  on public.conversation_offers (companion_profile_id, duration_minutes, currency)
  where (offer_type = 'single' and active);

create index conversation_offers_profile_active_idx
  on public.conversation_offers (companion_profile_id) where (active);

-- ---------- helper: companion profile check ----------
create or replace function app_private.is_companion_profile(p_profile uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p where p.id = p_profile and p.role = 'companion'
  );
$$;
revoke all on function app_private.is_companion_profile(uuid) from public, anon;
grant execute on function app_private.is_companion_profile(uuid) to authenticated;

-- ============================================================
-- RLS
-- availability_rules / availability_exceptions RLS was enabled in 0001;
-- conversation_offers is enabled here. platform_config (0% trial / 2%
-- standard) already exists with a read-only policy — Companions cannot
-- edit fees because no update policy exists.
-- ============================================================
alter table public.conversation_offers enable row level security;

-- Recurring availability: readable with access, or when active on a
-- discoverable Companion. Writes ONLY via replace_companion_availability
-- (no direct write policies), so overlap/timezone validation is unbypassable.
create policy "availability: view" on public.availability_rules
  for select to authenticated using (
    app_private.has_profile_access(companion_profile_id)
    or (active and app_private.is_discoverable_companion(companion_profile_id))
  );

-- Exceptions are PRIVATE (notes never public); marketplace display uses
-- recurring rules only until booking-slot generation exists.
create policy "exceptions: view own" on public.availability_exceptions
  for select to authenticated using (app_private.has_profile_access(companion_profile_id));
create policy "exceptions: add" on public.availability_exceptions
  for insert to authenticated with check (
    app_private.can_edit_profile(companion_profile_id)
    and app_private.is_companion_profile(companion_profile_id)
  );
create policy "exceptions: edit" on public.availability_exceptions
  for update to authenticated
  using (app_private.can_edit_profile(companion_profile_id))
  with check (app_private.can_edit_profile(companion_profile_id));
create policy "exceptions: remove" on public.availability_exceptions
  for delete to authenticated using (app_private.can_edit_profile(companion_profile_id));

-- Offers: active offers of discoverable Companions are public to
-- authenticated users; owners/editors manage their own. Validation
-- (price/duration/currency/uniqueness) is enforced by table constraints.
create policy "offers: view" on public.conversation_offers
  for select to authenticated using (
    app_private.has_profile_access(companion_profile_id)
    or (active and app_private.is_discoverable_companion(companion_profile_id))
  );
create policy "offers: create" on public.conversation_offers
  for insert to authenticated with check (
    app_private.can_edit_profile(companion_profile_id)
    and app_private.is_companion_profile(companion_profile_id)
  );
create policy "offers: edit" on public.conversation_offers
  for update to authenticated
  using (app_private.can_edit_profile(companion_profile_id))
  with check (app_private.can_edit_profile(companion_profile_id));
-- No delete policy: offers are archived (active = false), never destroyed.

-- ============================================================
-- Atomic availability replacement.
-- SECURITY DEFINER is required deliberately: availability_rules has no
-- direct write policies, making this function the single validated write
-- path (overlap + timezone validation cannot be bypassed). search_path is
-- pinned, every relation is qualified, authority derives from auth.uid().
--
-- Rules payload: [{"day": 1-7, "start": "HH:MM", "end": "HH:MM"}, …]
-- Adjacent windows (e.g. 09:00–12:00 + 12:00–15:00) are accepted as
-- separate windows; overlapping windows are rejected.
-- ============================================================
create or replace function public.replace_companion_availability(
  p_profile uuid,
  p_timezone text,
  p_rules jsonb default '[]'
)
returns setof public.availability_rules
language plpgsql security definer
set search_path = ''
as $$
declare
  r jsonb;
  v_day integer;
  v_start time;
  v_end time;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not app_private.can_edit_profile(p_profile) then
    raise exception 'You cannot edit this profile';
  end if;
  if not app_private.is_companion_profile(p_profile) then
    raise exception 'Availability applies to Companion profiles only';
  end if;
  if p_timezone is null or length(trim(p_timezone)) = 0 then
    raise exception 'A timezone is required';
  end if;
  -- Raises "time zone not recognized" for invalid IANA names.
  perform now() at time zone p_timezone;

  for r in select * from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) loop
    v_day := (r ->> 'day')::integer;
    v_start := (r ->> 'start')::time;
    v_end := (r ->> 'end')::time;
    if v_day is null or v_day < 1 or v_day > 7 then
      raise exception 'Invalid day of week';
    end if;
    if v_start is null or v_end is null or v_start >= v_end then
      raise exception 'Each availability window must start before it ends';
    end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) with ordinality a(rule, i)
    join jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) with ordinality b(rule, j) on b.j > a.i
    where (a.rule ->> 'day')::integer = (b.rule ->> 'day')::integer
      and ((a.rule ->> 'start')::time, (a.rule ->> 'end')::time)
          overlaps ((b.rule ->> 'start')::time, (b.rule ->> 'end')::time)
  ) then
    raise exception 'Availability windows on the same day must not overlap';
  end if;

  delete from public.availability_rules where companion_profile_id = p_profile;

  insert into public.availability_rules
    (companion_profile_id, day_of_week, start_local_time, end_local_time, timezone, active)
  select p_profile,
         (rule ->> 'day')::integer,
         (rule ->> 'start')::time,
         (rule ->> 'end')::time,
         p_timezone,
         true
  from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) t(rule);

  update public.companion_profiles
     set timezone = p_timezone, updated_at = now()
   where profile_id = p_profile;

  return query
    select * from public.availability_rules
    where companion_profile_id = p_profile
    order by day_of_week, start_local_time;
end;
$$;
revoke all on function public.replace_companion_availability(uuid, text, jsonb) from public, anon;
grant execute on function public.replace_companion_availability(uuid, text, jsonb) to authenticated;

-- ============================================================
-- Discovery view v2 — adds genuine availability + pricing fields for
-- Explore filters. Still security_invoker with explicit safe columns only;
-- exception notes and private data are never included.
-- Dayparts: morning < 12:00 ≤ afternoon ≤ 17:00 < evening.
-- ============================================================
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
  and p.visibility = 'public';

grant select on public.discoverable_companions to authenticated;
