-- 0121 — Profile extras: preferred name, country of residence, connected
-- places/cultures, and per-language fluency.
--
-- Additive. The tested signup completion RPCs are UNCHANGED — a small owner-only
-- RPC (set_profile_extras) writes these fields after completion and from profile
-- editing, resolving the caller's own profile server-side.
--   * preferred_name       — optional display name.
--   * country_of_residence — for time zone, payment and eligibility.
--   * connected_places      — countries/regions/cultures the person feels
--     connected to (lived experience, NOT legal citizenship); free multi-entry.
--   * language_fluency      — { "<language>": "<level>" } per selected language.
-- Apply after 0120.

set search_path = '';

alter table public.profiles add column if not exists preferred_name text;
alter table public.profiles add column if not exists country_of_residence text;
alter table public.profiles add column if not exists connected_places text[] not null default '{}';
alter table public.profiles add column if not exists language_fluency jsonb not null default '{}'::jsonb;

-- Owner-only writer: updates the caller's own profile. Null args leave a field
-- unchanged; empty array/object explicitly clears the multi-value fields.
create or replace function public.set_profile_extras(
  p_preferred_name text default null,
  p_country text default null,
  p_connected_places text[] default null,
  p_language_fluency jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_profile uuid;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required' using errcode = '42501'; end if;
  select pa.profile_id into v_profile
  from public.profile_access pa
  where pa.account_id = auth.uid() and pa.access_role = 'owner' and pa.consent_status <> 'withdrawn'
  order by pa.created_at
  limit 1;
  if v_profile is null then raise exception 'not_found: no profile' using errcode = '42501'; end if;

  update public.profiles set
    preferred_name       = coalesce(nullif(btrim(p_preferred_name), ''), preferred_name),
    country_of_residence = coalesce(nullif(btrim(p_country), ''), country_of_residence),
    connected_places     = coalesce(p_connected_places, connected_places),
    language_fluency     = coalesce(p_language_fluency, language_fluency)
  where id = v_profile;

  return jsonb_build_object('ok', true, 'profile_id', v_profile);
end;
$$;
revoke all on function public.set_profile_extras(text, text, text[], jsonb) from public, anon;
grant execute on function public.set_profile_extras(text, text, text[], jsonb) to authenticated;

select pg_notify('pgrst', 'reload schema');
