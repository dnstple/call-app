-- 0101 — Designated Member-side call seat (closeout Section 5).
--
-- A two-person call is always Companion + ONE Member-side participant. For a
-- Coordinator-managed booking that Member-side seat may be occupied by either
-- the managed Member (default, via the guest link) OR the Coordinator who
-- arranged the conversation. This adds:
--   1. bookings.member_seat  ('member' | 'coordinator', default 'member')
--   2. set_booking_member_seat(booking, seat) — only the arranging Coordinator
--   3. call_join_eligibility: the designated Coordinator joins AS the member side
--
-- Additive and safe: new column defaults to existing behaviour ('member'), the
-- trust gates (block / suspend / consent) are unchanged and still run after the
-- seat check, and no client-supplied role/identity is ever trusted.
--
-- Apply hosted after 0100 with `supabase db push`, then redeploy livekit-token.

set search_path = '';

-- 1. The designated Member-side seat. NULL/'member' = existing behaviour.
alter table public.bookings
  add column if not exists member_seat text not null default 'member'
    check (member_seat in ('member', 'coordinator'));

-- 2. Only the account that ARRANGED the booking (the Coordinator) may choose who
--    takes the Member seat, and only when they actually have access to the
--    Member. A self-booking Member owner never needs this (they are the seat).
create or replace function public.set_booking_member_seat(p_booking uuid, p_seat text)
returns public.bookings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_b public.bookings;
begin
  if v_uid is null then raise exception 'unauthorised: sign in required'; end if;
  if p_seat not in ('member', 'coordinator') then
    raise exception 'invalid: unknown seat';
  end if;

  select * into v_b from public.bookings where id = p_booking for update;
  if v_b.id is null then raise exception 'not_found: booking'; end if;

  -- The caller must be the arranger AND still hold access to the Member. A
  -- Member owner arranging for themselves is always the 'member' seat.
  if v_b.booked_by_account_id is distinct from v_uid
     or not app_private.has_profile_access(v_b.member_profile_id) then
    raise exception 'not_found: booking';
  end if;
  if v_uid = app_private.profile_owner_account(v_b.member_profile_id) and p_seat = 'coordinator' then
    raise exception 'invalid: you are the Member on this booking';
  end if;

  update public.bookings set member_seat = p_seat, updated_at = now() where id = p_booking;
  select * into v_b from public.bookings where id = p_booking;
  return v_b;
end;
$$;
revoke all on function public.set_booking_member_seat(uuid, text) from public, anon;
grant execute on function public.set_booking_member_seat(uuid, text) to authenticated;

-- 3. Eligibility: the designated Coordinator now joins AS the Member side. This
--    reproduces 0092's function with ONE added branch; everything else — the
--    trust gates, timing window, config and session checks — is unchanged.
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
  -- NEW (0101): the Coordinator who arranged this booking may take the Member
  -- seat when it is designated to them. They join AS the member side.
  elsif coalesce(v_b.member_seat, 'member') = 'coordinator'
        and v_b.booked_by_account_id = auth.uid()
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
