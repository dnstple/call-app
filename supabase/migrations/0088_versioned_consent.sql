-- ============================================================================
-- 0088 — Block 2 (Trust & Safety): versioned, server-owned consent.
-- ============================================================================
-- The redesign profile_access model carries a coarse consent_status
-- (pending/confirmed/withdrawn/not_required) that governs Coordinator↔Member
-- authority, but there is NO versioned record of WHICH pilot terms a person
-- acknowledged, at WHICH policy version, WHEN, and BY WHICH account. This
-- migration adds that authoritative model without disturbing profile_access.
--
-- Design (smallest authoritative model):
--   * consent_policies: one row per consent document, carrying the CURRENT
--     required version. Bumping current_version forces re-consent.
--   * consent_acknowledgements: one active row per (subject profile, consent
--     type, version). The acknowledgement is always recorded against a PROFILE
--     (so a Coordinator acknowledging on behalf of a managed Member is captured
--     naturally via on_behalf + acknowledged_by_account_id). Timestamps and
--     versions are SERVER-owned; the browser only names the profile + type.
--   * app_private.has_current_consent(profile, type): the single authority used
--     by every restricted action (0092 enforcement).
--
-- Purely additive: no payment/booking/earning/transfer object is touched, and
-- no historical record is invalidated. Restricting a NEW action on missing
-- consent (0092) never rewrites completed history.
-- ----------------------------------------------------------------------------

create table if not exists public.consent_policies (
  consent_type text primary key check (consent_type in
    ('member_pilot', 'coordinator_pilot', 'companion_pilot')),
  audience public.user_role not null,
  current_version integer not null check (current_version >= 1),
  summary text not null default '',
  updated_at timestamptz not null default now()
);

-- Seed the three pilot documents at version 1. The bullet content lives in the
-- UI; the policy row is the authoritative version pointer.
insert into public.consent_policies (consent_type, audience, current_version, summary) values
  ('member_pilot', 'member', 1,
   'Social-companionship service; not healthcare/counselling/emergency; calls not recorded; respectful conduct; how to report.'),
  ('coordinator_pilot', 'coordinator', 1,
   'Authority to manage the Member; the Member understands/agreed; never share passwords or financial credentials.'),
  ('companion_pilot', 'companion', 1,
   'Conduct requirements; safeguarding boundaries; no medical/legal/financial advice; no recording; reporting obligations; privacy.')
on conflict (consent_type) do nothing;

create table if not exists public.consent_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  subject_profile_id uuid not null references public.profiles(id) on delete cascade,
  consent_type text not null references public.consent_policies(consent_type),
  policy_version integer not null check (policy_version >= 1),
  acknowledged_by_account_id uuid not null references public.accounts(id),
  on_behalf boolean not null default false,
  status text not null default 'active' check (status in ('active', 'withdrawn', 'superseded')),
  acknowledged_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz not null default now()
);
-- At most ONE active acknowledgement per (subject, type, version): idempotent.
create unique index if not exists consent_ack_one_active
  on public.consent_acknowledgements (subject_profile_id, consent_type, policy_version)
  where status = 'active';
create index if not exists consent_ack_subject_idx
  on public.consent_acknowledgements (subject_profile_id, consent_type);

alter table public.consent_policies enable row level security;
alter table public.consent_acknowledgements enable row level security;

-- Policies are public read (so the UI can show the current version); no client writes.
drop policy if exists "consent policies readable" on public.consent_policies;
create policy "consent policies readable" on public.consent_policies
  for select to authenticated using (true);

-- A person reads acknowledgements they made, or that concern a profile they own.
-- Support reads via SECURITY DEFINER RPC (never a broad client policy).
drop policy if exists "consent ack own or owned-subject" on public.consent_acknowledgements;
create policy "consent ack own or owned-subject" on public.consent_acknowledgements
  for select to authenticated using (
    acknowledged_by_account_id = auth.uid()
    or app_private.profile_owner_account(subject_profile_id) = auth.uid()
  );
-- No insert/update/delete policy: all writes go through the definer RPC below.

-- ---------- authority helper ----------
-- Who may acknowledge for a subject profile: the profile OWNER (self), or a
-- Coordinator who holds confirmed access to a managed Member profile.
create or replace function app_private.may_acknowledge_consent(p_subject uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid;
begin
  v_owner := app_private.profile_owner_account(p_subject);
  if v_owner is not null and v_owner = auth.uid() then
    return 'owner';
  end if;
  if exists (
    select 1 from public.profile_access pa
    where pa.profile_id = p_subject and pa.account_id = auth.uid()
      and pa.access_role = 'coordinator'
      and pa.consent_status <> 'withdrawn'
  ) then
    return 'coordinator';
  end if;
  return null;
end;
$$;
revoke all on function app_private.may_acknowledge_consent(uuid) from public, anon, authenticated;

-- ---------- the single consent authority ----------
create or replace function app_private.has_current_consent(p_profile uuid, p_type text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.consent_acknowledgements a
    join public.consent_policies p on p.consent_type = a.consent_type
    where a.subject_profile_id = p_profile
      and a.consent_type = p_type
      and a.status = 'active'
      and a.policy_version = p.current_version
  );
$$;
revoke all on function app_private.has_current_consent(uuid, text) from public, anon, authenticated;

-- ---------- acknowledge (browser: profile + type only) ----------
create or replace function public.acknowledge_consent(p_profile uuid, p_type text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_authority text;
  v_version integer;
  v_audience public.user_role;
  v_role public.user_role;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;

  select current_version, audience into v_version, v_audience
    from public.consent_policies where consent_type = p_type;
  if v_version is null then raise exception 'invalid_consent_type'; end if;

  select role into v_role from public.profiles where id = p_profile;
  if v_role is null then raise exception 'not_found: profile'; end if;
  if v_role <> v_audience then raise exception 'consent_type_mismatch: wrong audience for this profile'; end if;

  v_authority := app_private.may_acknowledge_consent(p_profile);
  if v_authority is null then raise exception 'unauthorised: no authority for this profile'; end if;

  -- Already current? Idempotent no-op (never duplicate an existing valid consent).
  if app_private.has_current_consent(p_profile, p_type) then
    return jsonb_build_object('ok', true, 'already', true, 'version', v_version);
  end if;

  -- Supersede any older-version active acknowledgements for this subject+type.
  update public.consent_acknowledgements
     set status = 'superseded', superseded_at = now()
   where subject_profile_id = p_profile and consent_type = p_type and status = 'active';

  insert into public.consent_acknowledgements
    (subject_profile_id, consent_type, policy_version, acknowledged_by_account_id, on_behalf)
  values (p_profile, p_type, v_version, auth.uid(), v_authority = 'coordinator')
  on conflict (subject_profile_id, consent_type, policy_version) where status = 'active'
    do nothing;

  return jsonb_build_object('ok', true, 'already', false, 'version', v_version);
end;
$$;
revoke all on function public.acknowledge_consent(uuid, text) from public, anon;
grant execute on function public.acknowledge_consent(uuid, text) to authenticated;

-- ---------- my consent status (caller's own + managed profiles) ----------
create or replace function public.get_my_consent_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_rows jsonb;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'profile_id', x.profile_id,
           'role', x.role,
           'consent_type', pol.consent_type,
           'current_version', pol.current_version,
           'satisfied', app_private.has_current_consent(x.profile_id, pol.consent_type),
           'authority', app_private.may_acknowledge_consent(x.profile_id)
         ) order by x.profile_id, pol.consent_type), '[]'::jsonb)
    into v_rows
  from (
    -- profiles the caller owns, plus managed Members the caller coordinates
    select pa.profile_id, p.role
    from public.profile_access pa
    join public.profiles p on p.id = pa.profile_id
    where pa.account_id = auth.uid() and pa.consent_status <> 'withdrawn'
  ) x
  join public.consent_policies pol on pol.audience = x.role
  where app_private.may_acknowledge_consent(x.profile_id) is not null;
  return jsonb_build_object('ok', true, 'items', v_rows);
end;
$$;
revoke all on function public.get_my_consent_status() from public, anon;
grant execute on function public.get_my_consent_status() to authenticated;

-- ---------- support inspection (authorised only) ----------
create or replace function public.support_consent_status(p_profile uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_rows jsonb;
begin
  if not app_private.is_support_admin() then raise exception 'unauthorised: support only'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'consent_type', a.consent_type,
           'policy_version', a.policy_version,
           'current_version', p.current_version,
           'status', a.status,
           'on_behalf', a.on_behalf,
           'acknowledged_at', a.acknowledged_at,
           'is_current', (a.status = 'active' and a.policy_version = p.current_version)
         ) order by a.consent_type, a.policy_version desc), '[]'::jsonb)
    into v_rows
  from public.consent_acknowledgements a
  join public.consent_policies p on p.consent_type = a.consent_type
  where a.subject_profile_id = p_profile;
  return jsonb_build_object('ok', true, 'profile_id', p_profile, 'acknowledgements', v_rows);
end;
$$;
revoke all on function public.support_consent_status(uuid) from public, anon;
grant execute on function public.support_consent_status(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
