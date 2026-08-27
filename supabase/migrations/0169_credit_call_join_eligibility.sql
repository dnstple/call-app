-- ===========================================================================
-- 0169_credit_call_join_eligibility.sql  (Membership restructure — Phase 4 wiring)
--
-- Two fixes so credit-model calls can actually be joined:
--   1. call_join_eligibility now treats 'booked' and 'companion_confirmed' as
--      joinable (not just legacy 'confirmed').
--   2. Signing a role agreement also acknowledges the matching pilot consent, so
--      the call-join consent gate is satisfied (the old agreement did this; the
--      new button-press signer must too).
-- ===========================================================================

set search_path = '';

-- 1. Widen the joinable statuses in the meeting gate (mirrors 0102 impl).
create or replace function public.call_join_eligibility__impl(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_b public.bookings;
  v_cfg public.call_config;
  v_role text;
  v_opens timestamptz; v_closes timestamptz;
  v_session uuid; v_reason text; v_eligible boolean := false;
  v_now timestamptz := now();
begin
  if auth.uid() is null then
    return jsonb_build_object('eligible', false, 'reason', 'unauthenticated');
  end if;
  select * into v_b from public.bookings where id = p_booking;
  if v_b.id is null then
    return jsonb_build_object('eligible', false, 'reason', 'not_found');
  end if;

  if auth.uid() = app_private.profile_owner_account(v_b.companion_profile_id) then
    v_role := 'companion';
  elsif auth.uid() = app_private.profile_owner_account(v_b.member_profile_id) then
    v_role := 'member';
  elsif v_b.booked_by_account_id = auth.uid()
        and app_private.has_profile_access(v_b.member_profile_id) then
    v_role := 'member';
  elsif app_private.has_profile_access(v_b.member_profile_id)
        or app_private.has_profile_access(v_b.companion_profile_id) then
    return jsonb_build_object('eligible', false, 'reason', 'coordinator_not_permitted',
      'scheduled_start', v_b.starts_at, 'scheduled_end', v_b.ends_at);
  else
    return jsonb_build_object('eligible', false, 'reason', 'not_found');
  end if;

  if app_private.active_block_between(v_b.member_profile_id, v_b.companion_profile_id) then
    return jsonb_build_object('eligible', false, 'reason', 'blocked', 'your_role', v_role,
      'scheduled_start', v_b.starts_at, 'scheduled_end', v_b.ends_at);
  end if;
  if app_private.companion_is_suspended(v_b.companion_profile_id) then
    return jsonb_build_object('eligible', false, 'reason', 'companion_unavailable', 'your_role', v_role,
      'scheduled_start', v_b.starts_at, 'scheduled_end', v_b.ends_at);
  end if;
  if not app_private.has_current_consent(v_b.member_profile_id, 'member_pilot')
     or not app_private.has_current_consent(v_b.companion_profile_id, 'companion_pilot') then
    return jsonb_build_object('eligible', false, 'reason', 'consent_required', 'your_role', v_role,
      'scheduled_start', v_b.starts_at, 'scheduled_end', v_b.ends_at);
  end if;

  select * into v_cfg from public.call_config where id;
  if v_cfg.id is null then
    return jsonb_build_object('eligible', false, 'reason', 'configuration_missing',
      'your_role', v_role, 'scheduled_start', v_b.starts_at, 'scheduled_end', v_b.ends_at);
  end if;
  v_opens := v_b.starts_at - make_interval(mins => v_cfg.join_opens_before_start_minutes);
  v_closes := v_b.ends_at + make_interval(mins => v_cfg.join_closes_after_end_minutes);
  select id into v_session from public.call_sessions where booking_id = v_b.id;

  if v_b.status not in ('confirmed', 'booked', 'companion_confirmed') then
    v_reason := 'not_confirmed';
  elsif v_session is not null and (select state from public.call_sessions where id = v_session) = 'failed' then
    v_reason := 'call_closed';
  elsif v_now < v_opens then
    v_reason := 'too_early';
  elsif v_now > v_closes then
    v_reason := 'join_window_closed';
  else
    v_eligible := true; v_reason := 'ok';
  end if;

  return jsonb_build_object(
    'eligible', v_eligible, 'reason', v_reason, 'your_role', v_role,
    'opens_at', v_opens, 'closes_at', v_closes,
    'scheduled_start', v_b.starts_at, 'scheduled_end', v_b.ends_at,
    'call_session_id', v_session);
end;
$$;

-- 2. Role-agreement signing also acknowledges the matching pilot consent.
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

  -- Satisfy the meeting-consent gate (member_pilot / coordinator_pilot / companion_pilot).
  if v_profile is not null then
    begin
      perform public.acknowledge_consent(v_profile, p_role || '_pilot');
    exception when others then null;   -- never block signing on the consent step
    end;
  end if;

  return jsonb_build_object('ok', true, 'role', p_role, 'version', p_version);
end;
$$;
revoke all on function public.record_role_agreement(text, text, integer) from public, anon;
grant execute on function public.record_role_agreement(text, text, integer) to authenticated;

select pg_notify('pgrst', 'reload schema');
