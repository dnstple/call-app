-- ============================================================
-- Stage 3A alignment — expose the service-role call RPCs through PostgREST and
-- guarantee the final audited implementations are live (migration 0065).
--
-- Additive to the immutable 0001–0064 baseline. 0064 placed the service-role
-- call entrypoints (ensure_call_session, ingest_call_event, record_call_token_
-- audit) in the app_private schema. PostgREST only exposes `public`, so the
-- service-role client's `.rpc('ensure_call_session', …)` (from the livekit-token
-- Edge Function, the livekit-webhook Edge Function and the hosted tests) resolved
-- to `public.ensure_call_session` and failed with PGRST202. Every other
-- Edge-Function RPC in this project lives in `public`; these three were the
-- outliers.
--
-- This migration:
--   1. adds thin `public` service-role-only wrappers so the canonical
--      unqualified RPC names resolve through PostgREST — WITHOUT changing the
--      request contract (only p_booking / the same event args are accepted);
--   2. re-asserts the FINAL AUDITED bodies of the two functions that were
--      corrected in commit 3d7feb0, so that regardless of which 0064 revision is
--      physically live on the hosted database (the migration-ledger repair only
--      rewrote the ledger, not the function bodies), the hosted functions contain
--      the three audit corrections:
--        A. call_join_eligibility fails CLOSED (configuration_missing) when the
--           single call_config row is absent — never an always-open window;
--        B. ingest_call_event locks the call session row FOR UPDATE so concurrent
--           deliveries apply serially;
--        C. a late participant_joined cannot reactivate an ended/failed session.
--
-- 0064 is NOT edited. No cron, no financial writes, no Stripe/LiveKit calls.
-- Security posture is preserved: SECURITY DEFINER, search_path='', fully-qualified
-- references, service-role-only on the service entrypoints, authenticated on the
-- read RPC.
-- ============================================================

-- ------------------------------------------------------------
-- A. Re-assert call_join_eligibility with the fail-closed config check.
--    (public, authenticated — unchanged contract.)
-- ------------------------------------------------------------
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
  elsif app_private.has_profile_access(v_b.member_profile_id)
        or app_private.has_profile_access(v_b.companion_profile_id) then
    return jsonb_build_object('eligible', false, 'reason', 'coordinator_not_permitted',
      'scheduled_start', v_b.starts_at, 'scheduled_end', v_b.ends_at);
  else
    return jsonb_build_object('eligible', false, 'reason', 'not_found');
  end if;

  select * into v_cfg from public.call_config where id;
  -- Fail CLOSED if the single configuration row is somehow absent.
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

-- ------------------------------------------------------------
-- B/C. Re-assert app_private.ingest_call_event with the FOR UPDATE session lock
--      and the terminal-session join guard (final audited body).
-- ------------------------------------------------------------
create or replace function app_private.ingest_call_event(
  p_provider_event_id text, p_event_type text, p_room text,
  p_identity text, p_provider_created_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.call_sessions;
  v_part public.call_participants;
  v_evt_time timestamptz := coalesce(p_provider_created_at, now());
  v_result text;
  v_both boolean;
begin
  insert into public.call_provider_events (provider_event_id, event_type, room_name, participant_identity, provider_created_at)
  values (p_provider_event_id, p_event_type, p_room, p_identity, p_provider_created_at)
  on conflict (provider_event_id) do nothing;
  if not found then
    return jsonb_build_object('result', 'duplicate_ignored', 'event_id', p_provider_event_id);
  end if;

  -- Lock the session row so all events for one session apply serially.
  select * into v_session from public.call_sessions where room_name = p_room for update;
  if v_session.id is null then
    update public.call_provider_events
      set processed_at = now(), result = 'ignored_unknown_room'
      where provider_event_id = p_provider_event_id;
    return jsonb_build_object('result', 'ignored_unknown_room');
  end if;

  update public.call_provider_events
    set call_session_id = v_session.id where provider_event_id = p_provider_event_id;

  if p_event_type in ('participant_joined', 'participant_left', 'participant_connection_aborted') then
    select * into v_part from public.call_participants
      where call_session_id = v_session.id and provider_identity = p_identity;
    if v_part.id is null then
      update public.call_provider_events
        set processed_at = now(), result = 'ignored_unexpected_identity'
        where provider_event_id = p_provider_event_id;
      return jsonb_build_object('result', 'ignored_unexpected_identity');
    end if;
  end if;

  if p_event_type = 'room_started' then
    update public.call_sessions
      set state = case when state = 'pending' then 'active' else state end,
          last_provider_event_at = greatest(coalesce(last_provider_event_at, v_evt_time), v_evt_time),
          updated_at = now()
      where id = v_session.id;
    v_result := 'room_activated';

  elsif p_event_type = 'participant_joined' then
    -- A late join after a terminal room_finished/failure must NOT reactivate the
    -- call's live state (the session is locked above, so state is current).
    update public.call_participants set
      first_joined_at = coalesce(first_joined_at, v_evt_time),
      last_joined_at = greatest(coalesce(last_joined_at, v_evt_time), v_evt_time),
      join_count = join_count + 1,
      currently_connected = case
        when v_session.state in ('ended', 'failed') then currently_connected
        when v_evt_time >= coalesce(last_event_at, v_evt_time) then true else currently_connected end,
      last_event_at = greatest(coalesce(last_event_at, v_evt_time), v_evt_time),
      updated_at = now()
      where id = v_part.id;
    update public.call_sessions
      set first_participant_joined_at = coalesce(first_participant_joined_at, v_evt_time),
          state = case when state = 'pending' then 'active' else state end,
          last_provider_event_at = greatest(coalesce(last_provider_event_at, v_evt_time), v_evt_time),
          updated_at = now()
      where id = v_session.id;
    if v_session.state not in ('ended', 'failed') then
      select count(*) = 2 and bool_and(currently_connected) into v_both
        from public.call_participants where call_session_id = v_session.id;
      if v_both then
        update public.call_sessions set both_connected_at = coalesce(both_connected_at, v_evt_time), updated_at = now()
          where id = v_session.id;
      end if;
    end if;
    v_result := 'participant_joined';

  elsif p_event_type = 'participant_left' then
    update public.call_participants set
      last_left_at = greatest(coalesce(last_left_at, v_evt_time), v_evt_time),
      connected_seconds = connected_seconds + case
        when v_evt_time >= coalesce(last_event_at, v_evt_time) and last_joined_at is not null and currently_connected
        then greatest(0, floor(extract(epoch from (v_evt_time - last_joined_at)))::int) else 0 end,
      currently_connected = case when v_evt_time >= coalesce(last_event_at, v_evt_time) then false else currently_connected end,
      last_event_at = greatest(coalesce(last_event_at, v_evt_time), v_evt_time),
      updated_at = now()
      where id = v_part.id;
    update public.call_sessions set last_provider_event_at = greatest(coalesce(last_provider_event_at, v_evt_time), v_evt_time), updated_at = now()
      where id = v_session.id;
    v_result := 'participant_left';

  elsif p_event_type = 'participant_connection_aborted' then
    update public.call_participants set
      connection_abort_count = connection_abort_count + 1,
      last_event_at = greatest(coalesce(last_event_at, v_evt_time), v_evt_time),
      updated_at = now()
      where id = v_part.id;
    v_result := 'connection_aborted';

  elsif p_event_type = 'room_finished' then
    update public.call_sessions set
      room_finished_at = coalesce(room_finished_at, v_evt_time),
      state = case when state = 'failed' then 'failed' else 'ended' end,
      last_provider_event_at = greatest(coalesce(last_provider_event_at, v_evt_time), v_evt_time),
      updated_at = now()
      where id = v_session.id;
    v_result := 'room_finished';

  elsif p_event_type = 'track_published' then
    v_result := 'track_microphone';

  elsif p_event_type = 'track_anomaly' then
    update public.call_sessions set anomaly_count = anomaly_count + 1, updated_at = now() where id = v_session.id;
    v_result := 'track_anomaly_non_audio';

  else
    v_result := 'ignored_irrelevant';
  end if;

  update public.call_provider_events
    set processed_at = now(), result = v_result, call_session_id = v_session.id
    where provider_event_id = p_provider_event_id;
  return jsonb_build_object('result', v_result, 'call_session_id', v_session.id);
end;
$$;
revoke all on function app_private.ingest_call_event(text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function app_private.ingest_call_event(text, text, text, text, timestamptz) to service_role;

-- ------------------------------------------------------------
-- Public, service-role-only wrappers. These expose the canonical unqualified RPC
-- names through PostgREST. They accept exactly the same arguments (no room name,
-- identity or role is ever accepted from a caller) and simply delegate to the
-- immutable app_private implementations — the audited logic stays the single
-- source of truth.
-- ------------------------------------------------------------
create or replace function public.ensure_call_session(p_booking uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return app_private.ensure_call_session(p_booking);
end;
$$;
revoke all on function public.ensure_call_session(uuid) from public, anon, authenticated;
grant execute on function public.ensure_call_session(uuid) to service_role;

create or replace function public.ingest_call_event(
  p_provider_event_id text, p_event_type text, p_room text,
  p_identity text, p_provider_created_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return app_private.ingest_call_event(p_provider_event_id, p_event_type, p_room, p_identity, p_provider_created_at);
end;
$$;
revoke all on function public.ingest_call_event(text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.ingest_call_event(text, text, text, text, timestamptz) to service_role;

create or replace function public.record_call_token_audit(
  p_session uuid, p_booking uuid, p_account uuid, p_role text, p_expires timestamptz
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.record_call_token_audit(p_session, p_booking, p_account, p_role, p_expires);
end;
$$;
revoke all on function public.record_call_token_audit(uuid, uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_call_token_audit(uuid, uuid, uuid, text, timestamptz) to service_role;

select pg_notify('pgrst', 'reload schema');
