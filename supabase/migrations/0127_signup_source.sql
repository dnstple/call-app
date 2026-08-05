-- 0127 — Signup source: "How did you hear about us?"
--
-- Captured optionally on the signup success screen for every role. Additive: the
-- tested completion RPCs are UNCHANGED. A small owner-only RPC writes the answer
-- to the caller's own profile after signup.
--   * heard_about        — the chosen option (e.g. 'Instagram', 'Referral').
--   * heard_about_detail — free text when 'Other — please specify' is chosen.
-- Apply after 0126.

set search_path = '';

alter table public.profiles add column if not exists heard_about text;
alter table public.profiles add column if not exists heard_about_detail text;

create or replace function public.set_signup_source(
  p_source text default null,
  p_detail text default null)
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
    heard_about        = nullif(btrim(p_source), ''),
    heard_about_detail = nullif(btrim(p_detail), '')
  where id = v_profile;

  return jsonb_build_object('ok', true, 'profile_id', v_profile);
end;
$$;
revoke all on function public.set_signup_source(text, text) from public, anon;
grant execute on function public.set_signup_source(text, text) to authenticated;

select pg_notify('pgrst', 'reload schema');
