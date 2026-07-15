-- ============================================================
-- Stage 2C1 — persistent profiles, interests, favourites,
-- avatars (Storage) and database-backed discovery.
--
-- Public vs private separation:
--   profiles                → safe, potentially discoverable fields
--   profile_private_details → legal name, DOB, contact (never discoverable)
--   member_profiles         → Member preferences (private)
--   companion_profiles      → Companion role fields (safe subset discoverable)
--   coordinator_profiles    → minimal Coordinator extras (private)
-- ============================================================

-- ---------- profiles: storage-backed avatar ----------
alter table public.profiles add column avatar_path text;

-- ---------- private details ----------
create table public.profile_private_details (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  legal_first_name text,
  legal_last_name text,
  date_of_birth date,
  email text,
  phone text,
  private_location text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- role tables ----------
create table public.member_profiles (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  preferred_duration_minutes integer check (preferred_duration_minutes in (15, 30, 45, 60)),
  preferred_methods text[] not null default '{}',
  preferred_languages text[] not null default '{}',
  preferred_companion_style text[] not null default '{}',
  regular_companion_preference boolean,
  preferred_days text[] not null default '{}',
  preferred_dayparts text[] not null default '{}',
  topics_to_avoid text[] not null default '{}',
  profile_completion_percentage integer not null default 0
    check (profile_completion_percentage between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.companion_profiles (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  conversation_style text[] not null default '{}',
  is_accepting_new_members boolean not null default true,
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'pending_review', 'verified')),
  profile_completion_percentage integer not null default 0
    check (profile_completion_percentage between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Note: languages and communication methods stay canonical on public.profiles
-- (existing columns) to avoid duplicate concepts. Pricing, availability and
-- offers deliberately do NOT belong here — later milestones.

create table public.coordinator_profiles (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  relationship_summary text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- interests catalogue ----------
create table public.interests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  category text,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);
create unique index interests_name_ci on public.interests (lower(name));

insert into public.interests (name, slug, sort_order) values
  ('Family', 'family', 10),
  ('History', 'history', 20),
  ('Gardening', 'gardening', 30),
  ('Sport', 'sport', 40),
  ('Books', 'books', 50),
  ('Films and television', 'films-and-television', 60),
  ('Cooking', 'cooking', 70),
  ('Music', 'music', 80),
  ('Travel', 'travel', 90),
  ('Local news', 'local-news', 100),
  ('Pets', 'pets', 110),
  ('Faith and community', 'faith-and-community', 120),
  ('Crafts', 'crafts', 130),
  ('Current affairs', 'current-affairs', 140),
  ('General conversation', 'general-conversation', 150);

create table public.profile_interests (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  interest_id uuid not null references public.interests(id),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (profile_id, interest_id)
);
create index profile_interests_interest_idx on public.profile_interests (interest_id);

-- ---------- favourites ----------
create table public.favourites (
  -- account is always the caller: defaulted server-side, verified by RLS.
  account_id uuid not null default auth.uid() references public.accounts(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (account_id, profile_id)
);
create index favourites_profile_idx on public.favourites (profile_id);

-- ---------- helpers ----------
create or replace function app_private.is_discoverable_companion(p_profile uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_profile
      and p.role = 'companion'
      and p.profile_status = 'active'
      and p.visibility = 'public'
  );
$$;

create or replace function app_private.can_view_private(p_profile uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profile_access pa
    where pa.profile_id = p_profile
      and pa.account_id = auth.uid()
      and pa.can_view_private_details
      and pa.consent_status <> 'withdrawn'
  );
$$;

revoke all on function app_private.is_discoverable_companion(uuid) from public, anon;
revoke all on function app_private.can_view_private(uuid) from public, anon;
grant execute on function app_private.is_discoverable_companion(uuid) to authenticated;
grant execute on function app_private.can_view_private(uuid) to authenticated;

-- ---------- protect companion moderation fields ----------
create or replace function app_private.protect_companion_fields()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    new.verification_status := old.verification_status; -- no self-verification
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger companion_profiles_protect before update on public.companion_profiles
  for each row execute function app_private.protect_companion_fields();

-- ============================================================
-- RLS
-- ============================================================
alter table public.profile_private_details enable row level security;
alter table public.member_profiles enable row level security;
alter table public.companion_profiles enable row level security;
alter table public.coordinator_profiles enable row level security;
alter table public.interests enable row level security;
alter table public.profile_interests enable row level security;
alter table public.favourites enable row level security;

-- private details: view/edit only with explicit private access
create policy "private details: view" on public.profile_private_details
  for select to authenticated using (app_private.can_view_private(profile_id));
create policy "private details: edit" on public.profile_private_details
  for update to authenticated
  using (app_private.can_edit_profile(profile_id))
  with check (app_private.can_edit_profile(profile_id));
create policy "private details: create" on public.profile_private_details
  for insert to authenticated with check (app_private.can_edit_profile(profile_id));

-- member preferences: never globally exposed
create policy "member profile: view" on public.member_profiles
  for select to authenticated using (app_private.has_profile_access(profile_id));
create policy "member profile: edit" on public.member_profiles
  for update to authenticated
  using (app_private.can_edit_profile(profile_id))
  with check (app_private.can_edit_profile(profile_id));
create policy "member profile: create" on public.member_profiles
  for insert to authenticated with check (app_private.can_edit_profile(profile_id));

-- companion role fields: accessible or discoverable (safe subset via view)
create policy "companion profile: view" on public.companion_profiles
  for select to authenticated using (
    app_private.has_profile_access(profile_id)
    or app_private.is_discoverable_companion(profile_id)
  );
create policy "companion profile: edit" on public.companion_profiles
  for update to authenticated
  using (app_private.can_edit_profile(profile_id))
  with check (app_private.can_edit_profile(profile_id));
create policy "companion profile: create" on public.companion_profiles
  for insert to authenticated with check (app_private.can_edit_profile(profile_id));

-- coordinator extras: private
create policy "coordinator profile: view" on public.coordinator_profiles
  for select to authenticated using (app_private.has_profile_access(profile_id));
create policy "coordinator profile: edit" on public.coordinator_profiles
  for update to authenticated
  using (app_private.can_edit_profile(profile_id))
  with check (app_private.can_edit_profile(profile_id));
create policy "coordinator profile: create" on public.coordinator_profiles
  for insert to authenticated with check (app_private.can_edit_profile(profile_id));

-- interests catalogue: read-only for users
create policy "interests: read active" on public.interests
  for select to authenticated using (active);
-- (no insert/update/delete policies: catalogue changes are a privileged process)

-- profile interests: readable with access or on discoverable companions;
-- writable only for editable profiles (used by replace_profile_interests)
create policy "profile interests: view" on public.profile_interests
  for select to authenticated using (
    app_private.has_profile_access(profile_id)
    or app_private.is_discoverable_companion(profile_id)
  );
create policy "profile interests: add" on public.profile_interests
  for insert to authenticated with check (app_private.can_edit_profile(profile_id));
create policy "profile interests: remove" on public.profile_interests
  for delete to authenticated using (app_private.can_edit_profile(profile_id));

-- favourites: strictly own account; only viewable, non-hidden targets
create policy "favourites: read own" on public.favourites
  for select to authenticated using (account_id = auth.uid());
create policy "favourites: add own" on public.favourites
  for insert to authenticated with check (
    account_id = auth.uid()
    and (
      app_private.has_profile_access(profile_id)
      or app_private.is_discoverable_companion(profile_id)
    )
  );
create policy "favourites: remove own" on public.favourites
  for delete to authenticated using (account_id = auth.uid());

-- ============================================================
-- Discovery view — the ONLY public Companion payload.
-- security_invoker so underlying RLS still applies; explicit safe columns
-- only (no surname, DOB, email, phone, consent, access rows).
-- ============================================================
create or replace view public.discoverable_companions
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
  coalesce(
    (select array_agg(i.name order by i.sort_order)
       from public.profile_interests pi
       join public.interests i on i.id = pi.interest_id and i.active
      where pi.profile_id = p.id),
    '{}'
  ) as interest_names
from public.profiles p
left join public.companion_profiles cp on cp.profile_id = p.id
where p.role = 'companion'
  and p.profile_status = 'active'
  and p.visibility = 'public';

grant select on public.discoverable_companions to authenticated;

-- ============================================================
-- Controlled interest replacement (SECURITY INVOKER — RLS applies)
-- ============================================================
create or replace function public.replace_profile_interests(
  p_profile uuid,
  p_interest_ids uuid[]
)
returns setof public.interests
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_valid_count integer;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
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

-- ============================================================
-- Signup completion (SECURITY DEFINER — required because they create the
-- profile + access rows the caller does not yet have; the actor is always
-- auth.uid(), search_path is pinned, and every relation is qualified.)
-- ============================================================

create or replace function app_private.set_interests_by_slug(p_profile uuid, p_slugs text[])
returns void
language sql security definer
set search_path = ''
as $$
  insert into public.profile_interests (profile_id, interest_id)
  select p_profile, i.id
  from public.interests i
  where i.slug = any (coalesce(p_slugs, '{}')) and i.active
  on conflict do nothing;
$$;
revoke all on function app_private.set_interests_by_slug(uuid, text[]) from public, anon, authenticated;

create or replace function public.complete_member_signup(
  p_first_name text,
  p_last_name text default '',
  p_region text default '',
  p_headline text default '',
  p_bio text default '',
  p_age_band text default '',
  p_date_of_birth date default null,
  p_email text default '',
  p_phone text default '',
  p_languages text[] default '{English}',
  p_methods text[] default '{phone}',
  p_duration integer default 30,
  p_days text[] default '{}',
  p_dayparts text[] default '{}',
  p_style_prefs text[] default '{}',
  p_regular_companion boolean default null,
  p_topics_to_avoid text[] default '{}',
  p_interest_slugs text[] default '{}'
)
returns public.profiles
language plpgsql security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  v_profile := public.create_owned_profile(
    'member', p_first_name, p_last_name, p_headline, p_bio, p_region,
    '{}', p_languages
  );
  update public.profiles
     set age_band = coalesce(p_age_band, ''),
         mediums = (select array_agg(m::public.call_medium)
                      from unnest(coalesce(p_methods, '{phone}')) m
                     where m in ('phone','whatsapp','facetime','zoom','meet','other'))
   where id = v_profile.id;

  insert into public.profile_private_details (profile_id, date_of_birth, email, phone)
  values (v_profile.id, p_date_of_birth, coalesce(p_email, ''), coalesce(p_phone, ''));

  insert into public.member_profiles (
    profile_id, preferred_duration_minutes, preferred_methods, preferred_languages,
    preferred_companion_style, regular_companion_preference, preferred_days,
    preferred_dayparts, topics_to_avoid, profile_completion_percentage
  ) values (
    v_profile.id,
    case when p_duration in (15,30,45,60) then p_duration else 30 end,
    coalesce(p_methods, '{}'), coalesce(p_languages, '{}'),
    coalesce(p_style_prefs, '{}'), p_regular_companion, coalesce(p_days, '{}'),
    coalesce(p_dayparts, '{}'), coalesce(p_topics_to_avoid, '{}'), 60
  );

  perform app_private.set_interests_by_slug(v_profile.id, p_interest_slugs);
  select * into v_profile from public.profiles where id = v_profile.id;
  return v_profile;
end;
$$;

create or replace function public.complete_companion_signup(
  p_first_name text,
  p_last_name text default '',
  p_region text default '',
  p_headline text default '',
  p_bio text default '',
  p_date_of_birth date default null,
  p_email text default '',
  p_phone text default '',
  p_languages text[] default '{English}',
  p_methods text[] default '{phone}',
  p_style text[] default '{}',
  p_accepting boolean default true,
  p_interest_slugs text[] default '{}'
)
returns public.profiles
language plpgsql security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  if p_date_of_birth is null
     or p_date_of_birth > (current_date - interval '18 years') then
    raise exception 'Companions must be at least 18 years old';
  end if;

  v_profile := public.create_owned_profile(
    'companion', p_first_name, p_last_name, p_headline, p_bio, p_region,
    '{}', p_languages
  );
  update public.profiles
     set mediums = (select array_agg(m::public.call_medium)
                      from unnest(coalesce(p_methods, '{phone}')) m
                     where m in ('phone','whatsapp','facetime','zoom','meet','other'))
   where id = v_profile.id;

  insert into public.profile_private_details (profile_id, date_of_birth, email, phone)
  values (v_profile.id, p_date_of_birth, coalesce(p_email, ''), coalesce(p_phone, ''));

  insert into public.companion_profiles (
    profile_id, conversation_style, is_accepting_new_members,
    verification_status, profile_completion_percentage
  ) values (
    v_profile.id, coalesce(p_style, '{}'), coalesce(p_accepting, true),
    'pending_review', 70
  );

  perform app_private.set_interests_by_slug(v_profile.id, p_interest_slugs);
  select * into v_profile from public.profiles where id = v_profile.id;
  return v_profile;
end;
$$;

create or replace function public.complete_coordinator_signup(
  p_first_name text,
  p_last_name text default '',
  p_region text default '',
  p_email text default '',
  p_phone text default '',
  p_relationship text default 'Trusted person',
  p_consent_confirmed boolean default false,
  p_member_first_name text default '',
  p_member_last_name text default '',
  p_member_region text default '',
  p_member_age_band text default '',
  p_member_dob date default null,
  p_member_languages text[] default '{English}',
  p_member_methods text[] default '{phone}',
  p_member_duration integer default 30,
  p_member_days text[] default '{}',
  p_member_dayparts text[] default '{}',
  p_member_style_prefs text[] default '{}',
  p_member_regular boolean default null,
  p_member_topics_to_avoid text[] default '{}',
  p_member_interest_slugs text[] default '{}'
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_coordinator public.profiles;
  v_result jsonb;
  v_member_id uuid;
begin
  v_coordinator := public.create_owned_profile(
    'coordinator', p_first_name, p_last_name,
    'Arranging calls for ' || coalesce(nullif(trim(p_member_first_name), ''), 'a family member'),
    '', p_region, '{}', '{English}'
  );
  insert into public.profile_private_details (profile_id, email, phone)
  values (v_coordinator.id, coalesce(p_email, ''), coalesce(p_phone, ''));
  insert into public.coordinator_profiles (profile_id, relationship_summary)
  values (v_coordinator.id, coalesce(p_relationship, ''));

  v_result := public.create_managed_member_profile(
    p_member_first_name, p_member_last_name, p_member_region, '', '',
    '{}', p_relationship, p_consent_confirmed
  );
  v_member_id := (v_result ->> 'member_profile_id')::uuid;

  update public.profiles
     set age_band = coalesce(p_member_age_band, ''),
         languages = coalesce(p_member_languages, '{English}'),
         mediums = (select array_agg(m::public.call_medium)
                      from unnest(coalesce(p_member_methods, '{phone}')) m
                     where m in ('phone','whatsapp','facetime','zoom','meet','other'))
   where id = v_member_id;

  insert into public.profile_private_details (profile_id, date_of_birth)
  values (v_member_id, p_member_dob);

  insert into public.member_profiles (
    profile_id, preferred_duration_minutes, preferred_methods, preferred_languages,
    preferred_companion_style, regular_companion_preference, preferred_days,
    preferred_dayparts, topics_to_avoid, profile_completion_percentage
  ) values (
    v_member_id,
    case when p_member_duration in (15,30,45,60) then p_member_duration else 30 end,
    coalesce(p_member_methods, '{}'), coalesce(p_member_languages, '{}'),
    coalesce(p_member_style_prefs, '{}'), p_member_regular,
    coalesce(p_member_days, '{}'), coalesce(p_member_dayparts, '{}'),
    coalesce(p_member_topics_to_avoid, '{}'), 60
  );

  perform app_private.set_interests_by_slug(v_member_id, p_member_interest_slugs);

  return v_result || jsonb_build_object('coordinator_profile_id', v_coordinator.id);
end;
$$;

revoke all on function public.complete_member_signup(text,text,text,text,text,text,date,text,text,text[],text[],integer,text[],text[],text[],boolean,text[],text[]) from public, anon;
revoke all on function public.complete_companion_signup(text,text,text,text,text,date,text,text,text[],text[],text[],boolean,text[]) from public, anon;
revoke all on function public.complete_coordinator_signup(text,text,text,text,text,text,boolean,text,text,text,text,date,text[],text[],integer,text[],text[],text[],boolean,text[],text[]) from public, anon;
grant execute on function public.complete_member_signup(text,text,text,text,text,text,date,text,text,text[],text[],integer,text[],text[],text[],boolean,text[],text[]) to authenticated;
grant execute on function public.complete_companion_signup(text,text,text,text,text,date,text,text,text[],text[],text[],boolean,text[]) to authenticated;
grant execute on function public.complete_coordinator_signup(text,text,text,text,text,text,boolean,text,text,text,text,date,text[],text[],integer,text[],text[],text[],boolean,text[],text[]) to authenticated;

-- ============================================================
-- Storage: private avatar bucket + object policies.
-- Object path: {profile_id}/{uuid}.{ext} — never user-defined names.
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-avatars', 'profile-avatars', false, 4194304,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "avatars: upload for editable profile" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'profile-avatars'
    and app_private.can_edit_profile(((storage.foldername(name))[1])::uuid)
  );

create policy "avatars: read accessible or discoverable" on storage.objects
  for select to authenticated using (
    bucket_id = 'profile-avatars'
    and (
      app_private.has_profile_access(((storage.foldername(name))[1])::uuid)
      or app_private.is_discoverable_companion(((storage.foldername(name))[1])::uuid)
    )
  );

create policy "avatars: replace for editable profile" on storage.objects
  for update to authenticated using (
    bucket_id = 'profile-avatars'
    and app_private.can_edit_profile(((storage.foldername(name))[1])::uuid)
  );

create policy "avatars: delete for editable profile" on storage.objects
  for delete to authenticated using (
    bucket_id = 'profile-avatars'
    and app_private.can_edit_profile(((storage.foldername(name))[1])::uuid)
  );
