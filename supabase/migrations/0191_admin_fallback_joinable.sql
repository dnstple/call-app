-- ===========================================================================
-- 0191_admin_fallback_joinable.sql
--
-- Keep a call joinable even after it has passed its start time / been marked
-- 'admin_fallback' (companion didn't confirm 20 min ahead). A call still going
-- ahead should NOT lose its Join button just because the clock passed — the
-- original companion (or member) can still connect. Adds 'admin_fallback' to the
-- joinable statuses in the server-side join gate (mirrors 0169 otherwise; the
-- time-window and consent/suspension/block checks are unchanged, so a genuinely
-- closed window still blocks).
-- ===========================================================================

set search_path = '';

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

  -- 0191: 'admin_fallback' is now joinable too — a late/unconfirmed call can still go ahead.
  if v_b.status not in ('confirmed', 'booked', 'companion_confirmed', 'admin_fallback') then
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

select pg_notify('pgrst', 'reload schema');
