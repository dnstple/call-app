-- 0102 — First-come, re-claimable Member-side call seat (supersedes 0101's
-- advance designation).
--
-- The two-person call is Companion + ONE Member-side participant. That seat may
-- be taken by EITHER the managed Member (guest link) OR the Coordinator who
-- arranged the booking — whoever joins first holds it, and it frees the moment
-- they leave. There is no advance choice: eligibility is opened to both, and
-- single-occupancy is enforced live at join time by the token service (which
-- checks the room's current participants and caps the room at two).
--
-- This redefines call_join_eligibility so the arranging Coordinator is eligible
-- as the member side WITHOUT any member_seat flag. Everything else — the trust
-- gates (block / suspend / consent), timing window, config and session checks —
-- is unchanged from 0101. The bookings.member_seat column from 0101 is left in
-- place (harmless, now unused) to keep this migration purely additive.
--
-- Apply hosted after 0101 with `supabase db push`, then redeploy livekit-token.

set search_path = '';

create or replace function public.call_join_eligibility(p_booking uuid)
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
  -- First-come (0102): the Coordinator who ARRANGED this booking is eligible for
  -- the member-side seat. Live single-occupancy is enforced by the token
  -- service; here we only decide eligibility, not who currently holds the seat.
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

  if v_b.status <> 'confirmed' then
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
revoke all on function public.call_join_eligibility(uuid) from public, anon;
grant execute on function public.call_join_eligibility(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
