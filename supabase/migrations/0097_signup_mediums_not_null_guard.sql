-- ============================================================================
-- 0097 — Fix signup 23502: null value in column "mediums" of relation "profiles".
-- ============================================================================
-- Symptom: complete_coordinator_signup / member signup fail with
--   "null value in column \"mediums\" ... violates not-null constraint".
--
-- Cause: the product moved to in-app-only calling, so the client now sends
-- 'in_app' as the method. But `profiles.mediums` is `call_medium[] not null`
-- and the enum call_medium = ('phone','whatsapp','facetime','zoom','meet',
-- 'other') has NO 'in_app'. The signup RPCs set the member's mediums via
--   (select array_agg(m::call_medium)
--      from unnest(coalesce(p_methods,'{phone}')) m
--     where m in ('phone','whatsapp','facetime','zoom','meet','other'))
-- With p_methods = {in_app}, the WHERE filters everything out, array_agg
-- returns NULL, and the NOT NULL constraint rejects the UPDATE.
--
-- Fix (additive, minimal, covers every current and future write path):
-- a BEFORE INSERT OR UPDATE trigger that coalesces a NULL `mediums` to the
-- column's own default ('{phone}'). `mediums` is legacy now that calls are
-- in-app; defaulting is harmless and setting it NULL is never valid on a
-- NOT NULL column, so the coercion is strictly safe. No enum change, no
-- function-body surgery, no data migration.
-- ----------------------------------------------------------------------------

create or replace function app_private.default_profile_mediums()
returns trigger
language plpgsql
as $$
begin
  if new.mediums is null then
    new.mediums := '{phone}'::public.call_medium[];
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_default_mediums on public.profiles;
create trigger profiles_default_mediums
  before insert or update on public.profiles
  for each row
  execute function app_private.default_profile_mediums();

select pg_notify('pgrst', 'reload schema');
