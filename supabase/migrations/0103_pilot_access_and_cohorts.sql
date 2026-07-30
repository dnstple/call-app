-- 0103 — Pilot registration, cohorts and access management (foundation).
--
-- Separates THREE concepts that must never be conflated:
--   * account_access.access_level      — product access (waitlist|pilot|full|blocked)
--   * account_access.application_status — approval workflow
--   * profile_access.role               — Companion|Member|Coordinator (unchanged)
-- Support-admin authority stays in public.support_admins (unchanged). Moderation,
-- consent, blocking, payments and token authority are UNTOUCHED — feature access
-- is an ADDITIONAL gate layered on top, never a replacement.
--
-- Safety / backfill:
--   * every account that exists WHEN THIS MIGRATION RUNS keeps FULL access;
--   * a trigger defaults every NEW account to WAITLIST / incomplete;
--   * being a Companion, or being approved, never auto-grants access;
--   * no client value (role/approval/access) is trusted — all evaluated here.
--
-- Additive only. Apply hosted after 0102 with `supabase db push`.

set search_path = '';

-- ===========================================================================
-- 1. Enum-like reference: the gated product feature registry (no free text).
-- ===========================================================================
create table if not exists public.pilot_features (
  feature_key text primary key,
  label       text not null,
  sort_order  integer not null default 0
);
insert into public.pilot_features (feature_key, label, sort_order) values
  ('explore',          'Explore Companions',      10),
  ('favourites',       'Favourites',              20),
  ('message_requests', 'Message requests',        30),
  ('messaging',        'Messaging',               40),
  ('conversations',    'Conversations',           50),
  ('booking',          'Booking',                 60),
  ('calls',            'Calls',                   70),
  ('payments',         'Payments',                80),
  ('payouts',          'Payouts',                 90),
  ('reviews',          'Reviews',                100)
on conflict (feature_key) do nothing;

-- ===========================================================================
-- 2. Global launch mode — one authoritative singleton row.
-- ===========================================================================
create table if not exists public.launch_config (
  id            boolean primary key default true check (id),   -- single row
  launch_mode   text not null default 'companion_waitlist'
    check (launch_mode in ('closed', 'companion_waitlist', 'controlled_pilot', 'public')),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.accounts(id)
);
insert into public.launch_config (id, launch_mode) values (true, 'companion_waitlist')
on conflict (id) do nothing;
alter table public.launch_config enable row level security;
-- Everyone signed-in may READ the mode (the landing/app adapt to it); only the
-- support-admin RPC may write it.
drop policy if exists "launch: read" on public.launch_config;
create policy "launch: read" on public.launch_config for select to authenticated using (true);

-- ===========================================================================
-- 3. Pilot cohorts.
-- ===========================================================================
create table if not exists public.pilot_cohorts (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  status      text not null default 'draft'
    check (status in ('draft', 'recruiting', 'active', 'completed', 'archived')),
  starts_on   date,
  ends_on     date,
  max_size    integer check (max_size is null or max_size >= 0),
  created_by  uuid references public.accounts(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.pilot_cohorts enable row level security;  -- support-admin RPC only; no client policy

create table if not exists public.cohort_feature_access (
  cohort_id   uuid not null references public.pilot_cohorts(id) on delete cascade,
  feature_key text not null references public.pilot_features(feature_key),
  enabled     boolean not null default true,
  primary key (cohort_id, feature_key)
);
alter table public.cohort_feature_access enable row level security;

-- ===========================================================================
-- 4. Per-account access record — access level + approval workflow + cohort.
-- ===========================================================================
create table if not exists public.account_access (
  account_id         uuid primary key references public.accounts(id) on delete cascade,
  access_level       text not null default 'waitlist'
    check (access_level in ('waitlist', 'pilot', 'full', 'blocked')),
  application_status text not null default 'incomplete'
    check (application_status in ('incomplete', 'ready_for_review', 'under_review', 'approved', 'rejected', 'suspended')),
  cohort_id          uuid references public.pilot_cohorts(id) on delete set null,
  granted_at         timestamptz,
  granted_by         uuid references public.accounts(id),
  reviewed_at        timestamptz,
  reviewed_by        uuid references public.accounts(id),
  suspended_at       timestamptz,
  submitted_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
alter table public.account_access enable row level security;
-- An account may READ ONLY ITS OWN access record (so the app can render the hub);
-- all WRITES go through support-admin RPCs.
drop policy if exists "access: read own" on public.account_access;
create policy "access: read own" on public.account_access
  for select to authenticated using (account_id = auth.uid());

create table if not exists public.account_feature_overrides (
  account_id  uuid not null references public.accounts(id) on delete cascade,
  feature_key text not null references public.pilot_features(feature_key),
  enabled     boolean not null,
  reason      text,
  granted_by  uuid references public.accounts(id),
  created_at  timestamptz not null default now(),
  primary key (account_id, feature_key)
);
alter table public.account_feature_overrides enable row level security;  -- admin RPC only

-- ===========================================================================
-- 5. Private admin notes — NEVER visible to the reviewed account.
-- ===========================================================================
create table if not exists public.account_admin_notes (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references public.accounts(id) on delete cascade,
  note              text not null,
  author_account_id uuid not null references public.accounts(id),
  created_at        timestamptz not null default now()
);
alter table public.account_admin_notes enable row level security;  -- no self policy: admin RPC only

-- ===========================================================================
-- 6. Append-only access audit log.
-- ===========================================================================
create table if not exists public.access_audit_log (
  id                uuid primary key default gen_random_uuid(),
  target_account_id uuid references public.accounts(id) on delete set null,
  actor_account_id  uuid references public.accounts(id) on delete set null,
  action            text not null,
  before_state      jsonb,
  after_state       jsonb,
  reason            text,
  created_at        timestamptz not null default now()
);
alter table public.access_audit_log enable row level security;  -- admin-read RPC only; append-only

-- ===========================================================================
-- 7. Backfill + default trigger.
--    Existing accounts keep FULL access; new accounts default to WAITLIST.
-- ===========================================================================
insert into public.account_access (account_id, access_level, application_status, granted_at, reviewed_at)
select a.id, 'full', 'approved', now(), now()
from public.accounts a
on conflict (account_id) do nothing;

create or replace function app_private.account_access_default()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.account_access (account_id, access_level, application_status)
  values (new.id, 'waitlist', 'incomplete')
  on conflict (account_id) do nothing;
  return new;
end;
$$;
drop trigger if exists accounts_zz_access_default on public.accounts;
create trigger accounts_zz_access_default
  after insert on public.accounts
  for each row execute function app_private.account_access_default();

-- ===========================================================================
-- 8. Authoritative access evaluator.
-- ===========================================================================
-- The caller's full access snapshot. A missing row is treated as waitlist
-- (fail-closed for anything created outside the trigger).
create or replace function public.current_account_access()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'account_id',         auth.uid(),
    'access_level',       coalesce(aa.access_level, 'waitlist'),
    'application_status', coalesce(aa.application_status, 'incomplete'),
    'cohort_id',          aa.cohort_id,
    'cohort_name',        c.name,
    'is_support_admin',   app_private.is_support_admin(),
    'submitted_at',       aa.submitted_at,
    'launch_mode',        (select launch_mode from public.launch_config where id)
  )
  from (select auth.uid() as uid) me
  left join public.account_access aa on aa.account_id = me.uid
  left join public.pilot_cohorts c on c.id = aa.cohort_id;
$$;
revoke all on function public.current_account_access() from public, anon;
grant execute on function public.current_account_access() to authenticated;

-- Authoritative per-feature gate. Priority (explicit):
--   1. no session            → denied
--   2. blocked / suspended   → denied
--   3. per-account override  → its value
--   4. access_level = full   → allowed (all released features)
--   5. access_level = pilot  → cohort_feature_access for the feature
--   6. otherwise (waitlist)  → denied (setup features are NOT in this registry)
-- Feature access NEVER bypasses moderation/consent/blocking/payment authority;
-- those remain enforced by their own functions and RLS.
create or replace function app_private.account_has_feature(p_account uuid, p_feature text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v public.account_access;
  v_override boolean;
  v_enabled  boolean;
begin
  if p_account is null then return false; end if;
  if not exists (select 1 from public.pilot_features where feature_key = p_feature) then
    return false;  -- unknown feature key: fail closed
  end if;

  select * into v from public.account_access where account_id = p_account;

  if v.access_level = 'blocked'
     or v.application_status in ('suspended')
     or exists (select 1 from public.accounts a where a.id = p_account and a.status in ('suspended','deactivated')) then
    return false;
  end if;

  select enabled into v_override
    from public.account_feature_overrides
   where account_id = p_account and feature_key = p_feature;
  if v_override is not null then return v_override; end if;

  if coalesce(v.access_level, 'waitlist') = 'full' then
    return true;
  elsif v.access_level = 'pilot' then
    select enabled into v_enabled
      from public.cohort_feature_access
     where cohort_id = v.cohort_id and feature_key = p_feature;
    return coalesce(v_enabled, false);
  end if;

  return false;  -- waitlist / unknown → denied for gated product features
end;
$$;
revoke all on function app_private.account_has_feature(uuid, text) from public, anon;
grant execute on function app_private.account_has_feature(uuid, text) to authenticated;

-- Convenience wrapper for the current caller (used by RPCs and the client).
create or replace function public.has_feature_access(p_feature text)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.account_has_feature(auth.uid(), p_feature);
$$;
revoke all on function public.has_feature_access(text) from public, anon;
grant execute on function public.has_feature_access(text) to authenticated;

-- ===========================================================================
-- 9. Support-admin launch-mode read/write (audited).
-- ===========================================================================
create or replace function public.set_launch_mode(p_mode text, p_reason text default null)
returns public.launch_config language plpgsql security definer set search_path = '' as $$
declare v_before text; v_row public.launch_config;
begin
  if not app_private.is_support_admin() then raise exception 'unauthorised: support only'; end if;
  if p_mode not in ('closed','companion_waitlist','controlled_pilot','public') then
    raise exception 'invalid: unknown launch mode';
  end if;
  select launch_mode into v_before from public.launch_config where id;
  update public.launch_config set launch_mode = p_mode, updated_at = now(), updated_by = auth.uid()
   where id returning * into v_row;
  insert into public.access_audit_log (target_account_id, actor_account_id, action, before_state, after_state, reason)
  values (null, auth.uid(), 'launch_mode_changed',
          jsonb_build_object('launch_mode', v_before),
          jsonb_build_object('launch_mode', p_mode), p_reason);
  return v_row;
end;
$$;
revoke all on function public.set_launch_mode(text, text) from public, anon;
grant execute on function public.set_launch_mode(text, text) to authenticated;

select pg_notify('pgrst', 'reload schema');
