-- ============================================================
-- Stage 2B — authentication, account ownership, profile access
-- and initial Row Level Security.
--
-- Model:  auth.users → accounts → profile_access → profiles
-- Auth users and application profiles are deliberately separate:
-- account id = auth.uid(), profile ids are independent UUIDs.
-- ============================================================

-- ---------- accounts: one row per Supabase Auth user ----------
create table public.accounts (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  status text not null default 'active'
    check (status in ('active', 'pending', 'suspended', 'deactivated')),
  onboarding_complete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- profiles: add lifecycle + discovery fields ----------
alter table public.profiles
  add column visibility text not null default 'private'
    check (visibility in ('public', 'private')),
  add column profile_status text not null default 'active'
    check (profile_status in ('active', 'pending_review', 'suspended', 'hidden')),
  add column updated_at timestamptz not null default now();

-- ---------- profile_access: authority of an account over a profile ----------
create table public.profile_access (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  access_role text not null check (access_role in ('owner', 'coordinator', 'viewer')),
  can_edit boolean not null default false,
  can_book boolean not null default false,
  can_view_private_details boolean not null default false,
  can_receive_notifications boolean not null default true,
  consent_status text not null default 'not_required'
    check (consent_status in ('pending', 'confirmed', 'withdrawn', 'not_required')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, profile_id)
);

create index profile_access_account_idx on public.profile_access (account_id);
create index profile_access_profile_idx on public.profile_access (profile_id);
create index profiles_role_idx on public.profiles (role);
create index profiles_status_idx on public.profiles (profile_status);
create index profiles_visibility_idx on public.profiles (visibility);

-- ---------- Private helper schema (not exposed via PostgREST) ----------
create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

-- Non-recursive access checks. SECURITY DEFINER so profiles policies can
-- consult profile_access without the profile_access policies re-firing.
-- All access derives from auth.uid(); no caller-supplied account ids.
create or replace function app_private.has_profile_access(p_profile uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profile_access pa
    where pa.profile_id = p_profile
      and pa.account_id = auth.uid()
      and pa.consent_status <> 'withdrawn'
  );
$$;

create or replace function app_private.can_edit_profile(p_profile uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profile_access pa
    where pa.profile_id = p_profile
      and pa.account_id = auth.uid()
      and pa.can_edit
      and pa.consent_status <> 'withdrawn'
  );
$$;

revoke all on function app_private.has_profile_access(uuid) from public, anon;
revoke all on function app_private.can_edit_profile(uuid) from public, anon;
grant execute on function app_private.has_profile_access(uuid) to authenticated;
grant execute on function app_private.can_edit_profile(uuid) to authenticated;

-- ---------- Protect system fields from browser updates ----------
-- Requests through PostgREST always carry auth.uid(); the service role does
-- not. Authenticated updates silently keep protected fields unchanged.
create or replace function app_private.protect_account_fields()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    new.status := old.status;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger accounts_protect before update on public.accounts
  for each row execute function app_private.protect_account_fields();

create or replace function app_private.protect_profile_fields()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    new.verification := old.verification;      -- never self-verify
    new.profile_status := old.profile_status;  -- no self-unsuspend
    new.role := old.role;                      -- profile type is fixed
    new.joined_at := old.joined_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_protect before update on public.profiles
  for each row execute function app_private.protect_profile_fields();

-- ============================================================
-- Row Level Security
-- ============================================================
alter table public.accounts enable row level security;
alter table public.profile_access enable row level security;

-- Remove the Stage 2A connectivity-only dev policy: profile reads are now
-- governed by access relationships and the marketplace-discovery rule.
drop policy if exists "profiles are readable (dev foundation)" on public.profiles;

-- accounts: strictly self
create policy "accounts: read own" on public.accounts
  for select to authenticated using (id = auth.uid());
create policy "accounts: bootstrap own" on public.accounts
  for insert to authenticated with check (id = auth.uid());
create policy "accounts: update own" on public.accounts
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- profile_access: read own rows only; writes happen through functions.
create policy "profile_access: read own" on public.profile_access
  for select to authenticated using (account_id = auth.uid());

-- profiles: read what you can access, plus discoverable Companions.
-- Members and Coordinators are never globally discoverable.
create policy "profiles: accessible or discoverable companions" on public.profiles
  for select to authenticated using (
    app_private.has_profile_access(id)
    or (role = 'companion' and profile_status = 'active' and visibility = 'public')
  );

-- profiles: update only with can_edit access (protected fields see trigger).
create policy "profiles: edit with access" on public.profiles
  for update to authenticated
  using (app_private.can_edit_profile(id))
  with check (app_private.can_edit_profile(id));

-- No insert/delete policies on profiles or profile_access:
-- creation happens only through the controlled functions below.

-- ============================================================
-- Controlled operations
-- All derive the acting account from auth.uid(); none accept a
-- caller-supplied owner. All are atomic (single function transaction).
-- ============================================================

-- Idempotent account bootstrap. Safe to call on every sign-in.
create or replace function public.ensure_current_account(p_display_name text default null)
returns public.accounts
language plpgsql security definer
set search_path = ''
as $$
declare
  v_account public.accounts;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.accounts (id, display_name)
  values (auth.uid(), nullif(trim(coalesce(p_display_name, '')), ''))
  on conflict (id) do nothing;

  -- Fill display name only when empty; never overwrite.
  update public.accounts
     set display_name = nullif(trim(p_display_name), ''), updated_at = now()
   where id = auth.uid()
     and display_name is null
     and nullif(trim(coalesce(p_display_name, '')), '') is not null;

  select * into v_account from public.accounts where id = auth.uid();
  return v_account;
end;
$$;

-- Create a profile owned by the current account (owner access), atomically.
create or replace function public.create_owned_profile(
  p_role text,
  p_first_name text,
  p_last_name text default '',
  p_headline text default '',
  p_bio text default '',
  p_region text default '',
  p_interests text[] default '{}',
  p_languages text[] default '{English}'
)
returns public.profiles
language plpgsql security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if p_role not in ('member', 'companion', 'coordinator') then
    raise exception 'Invalid profile type';
  end if;
  if nullif(trim(coalesce(p_first_name, '')), '') is null then
    raise exception 'A first name is required';
  end if;

  perform public.ensure_current_account();

  -- One owned profile per role per account (prevents accidental duplicates).
  if exists (
    select 1 from public.profile_access pa
    join public.profiles pr on pr.id = pa.profile_id
    where pa.account_id = auth.uid()
      and pa.access_role = 'owner'
      and pr.role = p_role::public.user_role
  ) then
    raise exception 'This account already has a % profile', p_role;
  end if;

  insert into public.profiles (
    role, first_name, last_name, headline, bio, region, interests, languages,
    visibility, profile_status, verification
  ) values (
    p_role::public.user_role,
    trim(p_first_name), coalesce(p_last_name, ''), coalesce(p_headline, ''),
    coalesce(p_bio, ''), coalesce(p_region, ''), coalesce(p_interests, '{}'),
    coalesce(p_languages, '{English}'),
    case when p_role = 'companion' then 'public' else 'private' end,
    'active',
    case when p_role = 'companion' then 'pending'::public.verification_state
         else 'not_verified'::public.verification_state end
  )
  returning * into v_profile;

  insert into public.profile_access (
    account_id, profile_id, access_role,
    can_edit, can_book, can_view_private_details, can_receive_notifications,
    consent_status
  ) values (
    auth.uid(), v_profile.id, 'owner', true, true, true, true, 'not_required'
  );

  return v_profile;
end;
$$;

-- Coordinator creates a managed Member profile (no auth user for the Member).
-- The consent flag is a recorded onboarding confirmation, NOT identity or
-- legal consent verification.
create or replace function public.create_managed_member_profile(
  p_first_name text,
  p_last_name text default '',
  p_region text default '',
  p_headline text default '',
  p_bio text default '',
  p_interests text[] default '{}',
  p_relationship text default 'Trusted person',
  p_consent_confirmed boolean default false
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_coordinator public.profiles;
  v_member public.profiles;
  v_access public.profile_access;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if nullif(trim(coalesce(p_first_name, '')), '') is null then
    raise exception 'The member''s first name is required';
  end if;

  perform public.ensure_current_account();

  select pr.* into v_coordinator
  from public.profile_access pa
  join public.profiles pr on pr.id = pa.profile_id
  where pa.account_id = auth.uid()
    and pa.access_role = 'owner'
    and pr.role = 'coordinator'
  limit 1;

  if v_coordinator.id is null then
    raise exception 'Create your Coordinator profile before adding a managed member';
  end if;

  insert into public.profiles (
    role, first_name, last_name, headline, bio, region, interests,
    visibility, profile_status, verification
  ) values (
    'member', trim(p_first_name), coalesce(p_last_name, ''),
    coalesce(p_headline, ''), coalesce(p_bio, ''), coalesce(p_region, ''),
    coalesce(p_interests, '{}'), 'private', 'active', 'not_verified'
  )
  returning * into v_member;

  insert into public.profile_access (
    account_id, profile_id, access_role,
    can_edit, can_book, can_view_private_details, can_receive_notifications,
    consent_status
  ) values (
    auth.uid(), v_member.id, 'coordinator', true, true, true, true,
    case when p_consent_confirmed then 'confirmed' else 'pending' end
  )
  returning * into v_access;

  -- Keep the Stage 1 relationship table coherent for later feature migration.
  insert into public.managed_relationships (
    coordinator_id, member_id, relationship, consent_status, can_book
  ) values (
    v_coordinator.id, v_member.id, coalesce(p_relationship, 'Trusted person'),
    case when p_consent_confirmed then 'recorded'::public.consent_status
         else 'pending'::public.consent_status end,
    true
  );

  return jsonb_build_object(
    'member_profile_id', v_member.id,
    'coordinator_profile_id', v_coordinator.id,
    'access_id', v_access.id,
    'consent_status', v_access.consent_status
  );
end;
$$;

-- Mark onboarding complete for the current account only.
create or replace function public.complete_onboarding()
returns void
language sql security definer
set search_path = ''
as $$
  update public.accounts
     set onboarding_complete = true, updated_at = now()
   where id = auth.uid();
$$;

-- Lock the functions down: authenticated users only.
revoke all on function public.ensure_current_account(text) from public, anon;
revoke all on function public.create_owned_profile(text, text, text, text, text, text, text[], text[]) from public, anon;
revoke all on function public.create_managed_member_profile(text, text, text, text, text, text[], text, boolean) from public, anon;
revoke all on function public.complete_onboarding() from public, anon;
grant execute on function public.ensure_current_account(text) to authenticated;
grant execute on function public.create_owned_profile(text, text, text, text, text, text, text[], text[]) to authenticated;
grant execute on function public.create_managed_member_profile(text, text, text, text, text, text[], text, boolean) to authenticated;
grant execute on function public.complete_onboarding() to authenticated;
