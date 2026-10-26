-- ===========================================================================
-- 0218_close_companion_signup.sql
--
-- Companion sign-up is closed: only members and coordinators may register now.
-- The signup UI no longer offers the companion path; this is the server-side
-- backstop so a direct/cached call to complete_companion_signup can't create a
-- new companion either. Existing companions are unaffected (this function only
-- runs at sign-up). To reopen later, restore the 0003 definition.
-- ===========================================================================

set search_path = '';

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
begin
  raise exception 'companion_signup_closed: new companion sign-ups are not currently open'
    using errcode = 'P0001';
end;
$$;

select pg_notify('pgrst', 'reload schema');
