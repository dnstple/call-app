-- ===========================================================================
-- 0164_phone_verification.sql  (Membership restructure — Phase 6a)
--
-- Data foundation for mandatory UK mobile verification. The OTP send/verify flow
-- itself runs through an SMS provider (chosen at build time) + an edge function;
-- this migration holds the verified state and the read/write primitives.
--
--   * accounts.phone_e164 / phone_verified / phone_verified_at.
--   * set_phone_verified() — called by the OTP-verify edge function (service role)
--     once ownership is proven. Enforces UK (+44) numbers.
--   * my_phone_status() — dashboard prompt reads this.
--
-- New users will be GATED on verification during onboarding (Phase 6 UI); existing
-- users are never blocked but see a dashboard prompt until verified.
-- ===========================================================================

set search_path = '';

alter table public.accounts
  add column if not exists phone_e164        text,
  add column if not exists phone_verified    boolean not null default false,
  add column if not exists phone_verified_at timestamptz;

-- Record a verified UK mobile (service role — called after OTP ownership check).
create or replace function public.set_phone_verified(p_account uuid, p_phone text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_phone is null or p_phone !~ '^\+44[0-9]{9,10}$' then
    raise exception 'invalid_uk_number: must be a +44 UK mobile';
  end if;
  update public.accounts
     set phone_e164 = p_phone, phone_verified = true, phone_verified_at = now(), updated_at = now()
   where id = p_account;
end;
$$;
revoke all on function public.set_phone_verified(uuid, text) from public, anon, authenticated;
grant execute on function public.set_phone_verified(uuid, text) to service_role;

-- Verification status for the signed-in account (drives the dashboard prompt).
create or replace function public.my_phone_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_verified boolean; v_phone text;
begin
  if auth.uid() is null then raise exception 'unauthorised'; end if;
  select phone_verified, phone_e164 into v_verified, v_phone from public.accounts where id = auth.uid();
  return jsonb_build_object(
    'verified', coalesce(v_verified, false),
    'has_number', (v_phone is not null and v_phone <> ''));
end;
$$;
revoke all on function public.my_phone_status() from public, anon;
grant execute on function public.my_phone_status() to authenticated;

select pg_notify('pgrst', 'reload schema');
