-- ===========================================================================
-- 0166_role_agreements.sql  (Membership restructure — Phase 6d)
--
-- Role-specific agreements (Member / Coordinator / Companion), signed by
-- scrolling to the end and pressing a single "I agree and sign" button — no
-- typed name, no drawn signature. We store the exact agreement key + version,
-- the signer, role, timestamp, and the phone-verification state at signing.
-- ===========================================================================

set search_path = '';

alter table public.membership_agreements
  add column if not exists role                       text,
  add column if not exists phone_verified_at_signing  timestamptz;
-- Button-press signing has no typed name.
alter table public.membership_agreements alter column signed_name drop not null;

-- Record a role agreement signature (button press). Stores key/version/role/
-- timestamp + whether the account's phone was verified at signing.
create or replace function public.record_role_agreement(
  p_role text, p_agreement_key text, p_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_profile uuid; v_phone timestamptz;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  if p_role not in ('member','coordinator','companion') then raise exception 'invalid_role'; end if;
  if coalesce(btrim(p_agreement_key),'') = '' or p_version is null then raise exception 'agreement_required'; end if;

  select phone_verified_at into v_phone from public.accounts where id = auth.uid();
  select pa.profile_id into v_profile from public.profile_access pa
   where pa.account_id = auth.uid() and pa.access_role = 'owner' limit 1;

  insert into public.membership_agreements
    (account_id, profile_id, role, agreement_key, agreement_version, signed_name, phone_verified_at_signing)
  values (auth.uid(), v_profile, p_role, p_agreement_key, p_version, null, v_phone);

  return jsonb_build_object('ok', true, 'role', p_role, 'version', p_version);
end;
$$;
revoke all on function public.record_role_agreement(text, text, integer) from public, anon;
grant execute on function public.record_role_agreement(text, text, integer) to authenticated;

-- Has the caller signed the current version of a given role agreement?
create or replace function public.my_role_agreement_status(p_agreement_key text, p_version integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_signed boolean;
begin
  if auth.uid() is null then raise exception 'unauthorised'; end if;
  select exists (
    select 1 from public.membership_agreements
    where account_id = auth.uid() and agreement_key = p_agreement_key and agreement_version >= p_version
  ) into v_signed;
  return jsonb_build_object('signed', coalesce(v_signed, false));
end;
$$;
revoke all on function public.my_role_agreement_status(text, integer) from public, anon;
grant execute on function public.my_role_agreement_status(text, integer) to authenticated;

select pg_notify('pgrst', 'reload schema');
