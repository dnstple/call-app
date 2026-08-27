-- ===========================================================================
-- 0165_confirm_my_phone.sql  (Membership restructure — Phase 6b)
--
-- Sync a completed Supabase Auth phone verification into public.accounts. The
-- OTP send/verify runs through Supabase Auth (auth.users.phone_confirmed_at),
-- using whichever SMS provider is configured in the Supabase dashboard — so the
-- provider is a setting, not code. After the app verifies the OTP it calls this
-- to record the verified UK number on the account.
-- ===========================================================================

set search_path = '';

create or replace function public.confirm_my_phone()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_phone text; v_confirmed timestamptz; v_e164 text;
begin
  if auth.uid() is null then raise exception 'unauthorised'; end if;
  select phone, phone_confirmed_at into v_phone, v_confirmed from auth.users where id = auth.uid();
  if v_confirmed is null or v_phone is null or v_phone = '' then
    return jsonb_build_object('ok', false, 'verified', false);
  end if;
  -- Supabase stores E.164 sometimes without the leading '+'.
  v_e164 := case when v_phone like '+%' then v_phone else '+' || v_phone end;
  update public.accounts
     set phone_e164 = v_e164, phone_verified = true, phone_verified_at = now(), updated_at = now()
   where id = auth.uid();
  return jsonb_build_object('ok', true, 'verified', true);
end;
$$;
revoke all on function public.confirm_my_phone() from public, anon;
grant execute on function public.confirm_my_phone() to authenticated;

select pg_notify('pgrst', 'reload schema');
