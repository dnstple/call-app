-- ===========================================================================
-- 0192_ensure_call_session_joinable_statuses.sql
--
-- THE call-join blocker after the LiveKit 502 was fixed. `call_join_eligibility`
-- was widened (0169 → 'booked'/'companion_confirmed', 0191 → 'admin_fallback')
-- so the gate returns eligible:true for credit-model calls. But
-- `app_private.ensure_call_session` — called next by the livekit-token Edge
-- Function to create the room/session — was NEVER widened: it still hard-required
-- status = 'confirmed' and raised `not_eligible` for every credit booking. The
-- token function caught that and returned {error:'not_eligible'} with no reason,
-- so a genuinely joinable call showed "This call isn't available right now."
--
-- Fix: allow the SAME joinable statuses the gate allows. Eligibility (clock,
-- consent, block, suspension, role) is already fully enforced upstream in
-- call_join_eligibility before this function is ever reached, so this only stops
-- ensure_call_session from second-guessing the status. Body otherwise identical
-- to 0064.
-- ===========================================================================

set search_path = '';

create or replace function app_private.ensure_call_session(p_booking uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_b public.bookings;
  v_session public.call_sessions;
  v_member_acct uuid; v_companion_acct uuid;
begin
  select * into v_b from public.bookings where id = p_booking for update;
  if v_b.id is null then raise exception 'not_found'; end if;
  -- 0192: accept every joinable status (credit model), not just legacy 'confirmed'.
  -- Real eligibility is already enforced by call_join_eligibility upstream.
  if v_b.status not in ('confirmed', 'booked', 'companion_confirmed', 'admin_fallback') then
    raise exception 'not_eligible';
  end if;

  select * into v_session from public.call_sessions where booking_id = p_booking;
  if v_session.id is null then
    insert into public.call_sessions (booking_id, room_name, scheduled_start, scheduled_end)
    values (p_booking, 'call_' || replace(gen_random_uuid()::text, '-', ''), v_b.starts_at, v_b.ends_at)
    on conflict (booking_id) do nothing
    returning * into v_session;
    if v_session.id is null then
      select * into v_session from public.call_sessions where booking_id = p_booking;
    end if;
  else
    -- Keep the scheduled snapshot aligned if the booking was rescheduled while
    -- the call has not yet started (no reversal of a live/ended call).
    if v_session.state = 'pending'
       and (v_session.scheduled_start <> v_b.starts_at or v_session.scheduled_end <> v_b.ends_at) then
      update public.call_sessions
        set scheduled_start = v_b.starts_at, scheduled_end = v_b.ends_at, updated_at = now()
        where id = v_session.id
        returning * into v_session;
    end if;
  end if;

  -- Expected participants: the two OWNER accounts only (Coordinator excluded).
  v_member_acct := app_private.profile_owner_account(v_b.member_profile_id);
  v_companion_acct := app_private.profile_owner_account(v_b.companion_profile_id);
  if v_member_acct is not null then
    insert into public.call_participants (call_session_id, account_id, booking_role, provider_identity)
    values (v_session.id, v_member_acct, 'member', 'account:' || v_member_acct::text)
    on conflict (call_session_id, booking_role) do nothing;
  end if;
  if v_companion_acct is not null then
    insert into public.call_participants (call_session_id, account_id, booking_role, provider_identity)
    values (v_session.id, v_companion_acct, 'companion', 'account:' || v_companion_acct::text)
    on conflict (call_session_id, booking_role) do nothing;
  end if;

  return jsonb_build_object(
    'call_session_id', v_session.id, 'room_name', v_session.room_name,
    'scheduled_start', v_session.scheduled_start, 'scheduled_end', v_session.scheduled_end,
    'member_account', v_member_acct, 'companion_account', v_companion_acct);
end;
$$;
revoke all on function app_private.ensure_call_session(uuid) from public, anon, authenticated;
grant execute on function app_private.ensure_call_session(uuid) to service_role;

select pg_notify('pgrst', 'reload schema');
