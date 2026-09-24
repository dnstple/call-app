-- ===========================================================================
-- 0214_signup_lead_capture.sql
--
-- "Still have more questions?" capture during member sign-up. Stores an email +
-- mobile into the existing landing_leads table (adds a phone column), via a
-- SECURITY DEFINER RPC — the table stays unreadable/unwritable directly.
-- ===========================================================================

set search_path = '';

alter table public.landing_leads add column if not exists phone text;

create or replace function public.capture_signup_lead(
  p_email text, p_phone text default null, p_role text default 'member', p_source text default 'signup_help')
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_role  text := lower(btrim(coalesce(p_role, '')));
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
begin
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(v_email) > 254 then
    raise exception 'invalid_email' using errcode = 'P0001';
  end if;
  if v_role not in ('member', 'companion', 'coordinator') then v_role := 'member'; end if;

  insert into public.landing_leads (email, intended_role, source, phone)
  values (v_email, v_role, coalesce(nullif(p_source, ''), 'signup_help'), v_phone)
  on conflict (lower(email)) do update
    set intended_role = excluded.intended_role,
        phone         = coalesce(excluded.phone, public.landing_leads.phone),
        source        = excluded.source,
        last_seen_at  = now();
end;
$$;
revoke all on function public.capture_signup_lead(text, text, text, text) from public;
grant execute on function public.capture_signup_lead(text, text, text, text) to anon, authenticated;

select pg_notify('pgrst', 'reload schema');
