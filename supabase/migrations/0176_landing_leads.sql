-- ===========================================================================
-- 0176_landing_leads.sql
--
-- Lead capture for the public landing page. A signed-out visitor can leave an
-- email and the account type they're interested in (member / companion /
-- coordinator) so the team can personally reach out.
--
-- Security model:
--   * The table has RLS enabled and NO policies, so it is unreadable and
--     unwritable via the anon/authenticated API directly — emails can't be
--     harvested and the table can't be scraped or spammed by direct writes.
--   * A single SECURITY DEFINER RPC, capture_landing_lead(), is the ONLY way in.
--     It validates the email, clamps the role to the allowed set, and upserts
--     (deduped on lower(email)). It's granted to anon + authenticated only.
--   * Reads are for the service role / SQL editor only (support/admin).
-- ===========================================================================

set search_path = '';

create table if not exists public.landing_leads (
  id             uuid primary key default gen_random_uuid(),
  email          text not null,
  intended_role  text not null check (intended_role in ('member', 'companion', 'coordinator')),
  source         text not null default 'landing_popup',
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);

-- One row per email (case-insensitive); repeat submissions update the role/time.
create unique index if not exists landing_leads_email_key
  on public.landing_leads (lower(email));

alter table public.landing_leads enable row level security;
-- Intentionally NO policies: all access goes through the definer RPC below, or
-- the service role (SQL editor / admin tooling).

create or replace function public.capture_landing_lead(p_email text, p_role text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_role  text := lower(btrim(coalesce(p_role, '')));
begin
  -- Minimal email sanity check (real validation is the reply that bounces).
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_email' using errcode = 'P0001';
  end if;
  if length(v_email) > 254 then
    raise exception 'invalid_email' using errcode = 'P0001';
  end if;
  -- Never reject on role — default to member if it's not one of the known types.
  if v_role not in ('member', 'companion', 'coordinator') then
    v_role := 'member';
  end if;

  insert into public.landing_leads (email, intended_role)
  values (v_email, v_role)
  on conflict (lower(email)) do update
    set intended_role = excluded.intended_role,
        last_seen_at  = now();
end;
$$;

revoke all on function public.capture_landing_lead(text, text) from public;
grant execute on function public.capture_landing_lead(text, text) to anon, authenticated;

select pg_notify('pgrst', 'reload schema');
