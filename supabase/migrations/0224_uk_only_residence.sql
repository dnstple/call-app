-- ===========================================================================
-- 0224_uk_only_residence.sql
--
-- Apricoti is UK-only for now (Daniel, 25 Nov 2026). The sign-up form only
-- offers England / Scotland / Wales / Northern Ireland; this is the server-side
-- backstop: a profile's country of residence can only be set (or changed) to a
-- UK value. Existing rows are untouched; only new writes are checked.
-- To reopen to other countries later, drop this trigger.
-- ===========================================================================
set search_path = '';

create or replace function app_private.enforce_uk_residence()
returns trigger language plpgsql set search_path = '' as $$
begin
  if nullif(btrim(coalesce(new.country_of_residence, '')), '') is not null
     and (tg_op = 'INSERT' or new.country_of_residence is distinct from old.country_of_residence)
     and lower(btrim(new.country_of_residence)) !~ '^(england|scotland|wales|northern ireland|united kingdom|uk|u\.k\.|great britain|gb|britain)$' then
    raise exception 'uk_only: Apricoti is currently only available to people who live in the UK'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_enforce_uk_residence on public.profiles;
create trigger profiles_enforce_uk_residence
  before insert or update of country_of_residence on public.profiles
  for each row execute function app_private.enforce_uk_residence();

-- FINGERPRINT: select exists (select 1 from pg_trigger where tgname = 'profiles_enforce_uk_residence') as m0224;
