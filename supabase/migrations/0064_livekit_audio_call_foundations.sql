-- ============================================================
-- Stage 3A — secure LiveKit audio-call foundations (migration 0064)
--
-- Additive to the immutable 0001–0063 baseline. Establishes the SECURE server
-- foundation for one-to-one, audio-only calls between the booked Member and
-- Companion:
--   * a durable call-session model (one stable logical room per booking);
--   * the two expected call participants (Member owner + Companion owner);
--   * an immutable, idempotent LiveKit provider-event ledger (NO raw payloads);
--   * a token-issuance audit (NO JWTs stored);
--   * ONE authoritative join-eligibility RPC (server clock + server-derived role);
--   * service-role ingestion + session-provisioning RPCs;
--   * safe user + support read RPCs.
--
-- BOUNDARY (Stage 3A): this stage NEVER completes a booking, confirms attendance
-- for settlement, decides a no-show, consumes credit, creates/releases an
-- earning, starts a transfer, issues a refund, resolves a dispute, or changes
-- billing. The ONLY booking-adjacent writes are: create/retrieve a call session,
-- record safe provider events, and record token-issuance audit. Deciding how
-- these authoritative events feed attendance/completion/no-show/earning
-- eligibility is deferred to Stage 3B.
--
-- Recording is OUT OF SCOPE: no egress, no roomRecord grant, no audio/transcript
-- storage. No Stripe call. No cron. Applying this migration schedules nothing.
-- ============================================================

-- ------------------------------------------------------------
-- 0. Single server-side configuration source for the join window.
-- ------------------------------------------------------------
create table if not exists public.call_config (
  id boolean primary key default true check (id),          -- single-row table
  join_opens_before_start_minutes integer not null default 10 check (join_opens_before_start_minutes >= 0),
  join_closes_after_end_minutes integer not null default 30 check (join_closes_after_end_minutes >= 0),
  updated_at timestamptz not null default now()
);
insert into public.call_config (id) values (true) on conflict (id) do nothing;
alter table public.call_config enable row level security;

-- ------------------------------------------------------------
-- 1. Call session — one stable logical LiveKit room per booking.
-- ------------------------------------------------------------
create table if not exists public.call_sessions (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id),  -- prevents two sessions per booking
  provider text not null default 'livekit' check (provider = 'livekit'),
  room_name text not null unique,                          -- opaque, server-generated, no PII
  state text not null default 'pending' check (state in ('pending', 'active', 'ended', 'failed')),
  scheduled_start timestamptz not null,                    -- snapshot from the booking
  scheduled_end timestamptz not null,
  first_participant_joined_at timestamptz,
  both_connected_at timestamptz,
  room_finished_at timestamptz,
  anomaly_count integer not null default 0,                -- unexpected non-audio track publications
  last_provider_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists call_sessions_booking_idx on public.call_sessions (booking_id);
alter table public.call_sessions enable row level security;

-- ------------------------------------------------------------
-- 2. Call participants — the two expected accounts (Member + Companion).
--    The Coordinator who booked is NEVER inserted here.
-- ------------------------------------------------------------
create table if not exists public.call_participants (
  id uuid primary key default gen_random_uuid(),
  call_session_id uuid not null references public.call_sessions(id) on delete cascade,
  account_id uuid not null references public.accounts(id),
  booking_role text not null check (booking_role in ('member', 'companion')),
  provider_identity text not null,                         -- 'account:<uuid>' (server-derived)
  first_joined_at timestamptz,
  last_joined_at timestamptz,
  last_left_at timestamptz,
  join_count integer not null default 0,
  connection_abort_count integer not null default 0,
  connected_seconds integer not null default 0,
  currently_connected boolean not null default false,
  last_event_at timestamptz,                               -- newest PROVIDER event time applied
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (call_session_id, account_id),
  unique (call_session_id, booking_role),
  unique (call_session_id, provider_identity)
);
create index if not exists call_participants_session_idx on public.call_participants (call_session_id);
create index if not exists call_participants_identity_idx on public.call_participants (provider_identity);
alter table public.call_participants enable row level security;

-- ------------------------------------------------------------
-- 3. Immutable, idempotent provider-event ledger. SAFE operational fields ONLY:
--    no raw body, no token, no keys, no audio, no IP, no device data.
-- ------------------------------------------------------------
create table if not exists public.call_provider_events (
  id uuid primary key default gen_random_uuid(),
  provider_event_id text not null unique,                  -- LiveKit event id: natural idempotency
  event_type text not null,
  room_name text,
  participant_identity text,
  call_session_id uuid references public.call_sessions(id),
  provider_created_at timestamptz,                         -- provider clock (ordering)
  received_at timestamptz not null default now(),          -- server clock (audit)
  processed_at timestamptz,
  result text,                                             -- safe vocabulary
  error_code text                                          -- safe code only
);
create index if not exists call_provider_events_session_idx on public.call_provider_events (call_session_id, provider_created_at);
alter table public.call_provider_events enable row level security;

-- ------------------------------------------------------------
-- 4. Token-issuance audit. Records successful issuance; NEVER the JWT itself.
-- ------------------------------------------------------------
create table if not exists public.call_token_audits (
  id uuid primary key default gen_random_uuid(),
  call_session_id uuid not null references public.call_sessions(id),
  booking_id uuid not null references public.bookings(id),
  account_id uuid not null references public.accounts(id),
  participant_role text not null check (participant_role in ('member', 'companion')),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  result text not null default 'issued',
  created_at timestamptz not null default now()
);
create index if not exists call_token_audits_session_idx on public.call_token_audits (call_session_id, issued_at);
alter table public.call_token_audits enable row level security;

-- ============================================================
-- 5. Private helpers.
-- ============================================================

-- Resolve the OWNER account of a profile (the profile's own login). A managing
-- Coordinator holds access_role 'coordinator' and is deliberately excluded.
create or replace function app_private.profile_owner_account(p_profile uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select pa.account_id from public.profile_access pa
  where pa.profile_id = p_profile and pa.access_role = 'owner'
    and pa.consent_status <> 'withdrawn'
  order by pa.created_at limit 1;
$$;
revoke all on function app_private.profile_owner_account(uuid) from public, anon, authenticated;

-- ============================================================
-- 6. THE authoritative join-eligibility function. Server clock + server-derived
--    role. Fails CLOSED and identically for unauthorised/nonexistent bookings.
--    Read-only: it never creates a session or mints a token.
-- ============================================================
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
  -- Unauthorised and nonexistent look identical (no detail leak).
  if v_b.id is null then
    return jsonb_build_object('eligible', false, 'reason', 'not_found');
  end if;

  -- Server-derived role: ONLY the profile's own owner account may join.
  if auth.uid() = app_private.profile_owner_account(v_b.companion_profile_id) then
    v_role := 'companion';
  elsif auth.uid() = app_private.profile_owner_account(v_b.member_profile_id) then
    v_role := 'member';
  elsif app_private.has_profile_access(v_b.member_profile_id)
        or app_private.has_profile_access(v_b.companion_profile_id) then
    -- A Coordinator/viewer with access is a KNOWN non-participant: tell the UI
    -- clearly, but issue no token and no session.
    return jsonb_build_object('eligible', false, 'reason', 'coordinator_not_permitted',
      'scheduled_start', v_b.starts_at, 'scheduled_end', v_b.ends_at);
  else
    return jsonb_build_object('eligible', false, 'reason', 'not_found');
  end if;

  select * into v_cfg from public.call_config where id;
  v_opens := v_b.starts_at - make_interval(mins => v_cfg.join_opens_before_start_minutes);
  v_closes := v_b.ends_at + make_interval(mins => v_cfg.join_closes_after_end_minutes);
  select id into v_session from public.call_sessions where booking_id = v_b.id;

  if v_b.status <> 'confirmed' then
    v_reason := 'not_confirmed';
  elsif v_session is not null and (select state from public.call_sessions where id = v_session) = 'failed' then
    v_reason := 'call_closed';                     -- administratively/terminally closed
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

-- ============================================================
-- 7. Service-role: idempotently create/retrieve a booking's call session and its
--    two expected participants. Guards status = 'confirmed'. Never for a
--    cancelled/declined booking.
-- ============================================================
create or replace function app_private.ensure_call_session(p_booking uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_b public.bookings;
  v_session public.call_sessions;
  v_member_acct uuid; v_companion_acct uuid;
begin
  select * into v_b from public.bookings where id = p_booking for update;
  if v_b.id is null then raise exception 'not_found'; end if;
  if v_b.status <> 'confirmed' then raise exception 'not_eligible'; end if;

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

-- Service-role: record a SUCCESSFUL token issuance (never the JWT).
create or replace function app_private.record_call_token_audit(
  p_session uuid, p_booking uuid, p_account uuid, p_role text, p_expires timestamptz
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.call_token_audits (call_session_id, booking_id, account_id, participant_role, expires_at)
  values (p_session, p_booking, p_account, p_role, p_expires);
end;
$$;
revoke all on function app_private.record_call_token_audit(uuid, uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function app_private.record_call_token_audit(uuid, uuid, uuid, text, timestamptz) to service_role;

-- ============================================================
-- 8. Service-role: idempotent provider-event ingestion + aggregation.
--    Idempotency via provider_event_id uniqueness. Ordering via provider time.
--    NEVER moves money, completes a booking or trusts participant metadata.
-- ============================================================
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
  -- Idempotency gate: a duplicate provider event is recorded once and applied
  -- once. A repeat simply short-circuits (no double counting).
  insert into public.call_provider_events (provider_event_id, event_type, room_name, participant_identity, provider_created_at)
  values (p_provider_event_id, p_event_type, p_room, p_identity, p_provider_created_at)
  on conflict (provider_event_id) do nothing;
  if not found then
    return jsonb_build_object('result', 'duplicate_ignored', 'event_id', p_provider_event_id);
  end if;

  -- Locate the session by EXACT opaque room name. Unknown rooms are a safe
  -- ignore — never an authorisation to fabricate a session.
  select * into v_session from public.call_sessions where room_name = p_room;
  if v_session.id is null then
    update public.call_provider_events
      set processed_at = now(), result = 'ignored_unknown_room'
      where provider_event_id = p_provider_event_id;
    return jsonb_build_object('result', 'ignored_unknown_room');
  end if;

  update public.call_provider_events
    set call_session_id = v_session.id where provider_event_id = p_provider_event_id;

  -- Participant events must match an EXPECTED participant identity.
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
    update public.call_participants set
      first_joined_at = coalesce(first_joined_at, v_evt_time),
      last_joined_at = greatest(coalesce(last_joined_at, v_evt_time), v_evt_time),
      join_count = join_count + 1,                         -- once per unique event (idempotency-gated)
      -- Only the NEWEST participant event flips live state (late events cannot reverse).
      currently_connected = case when v_evt_time >= coalesce(last_event_at, v_evt_time) then true else currently_connected end,
      last_event_at = greatest(coalesce(last_event_at, v_evt_time), v_evt_time),
      updated_at = now()
      where id = v_part.id;
    update public.call_sessions
      set first_participant_joined_at = coalesce(first_participant_joined_at, v_evt_time),
          state = case when state = 'pending' then 'active' else state end,
          last_provider_event_at = greatest(coalesce(last_provider_event_at, v_evt_time), v_evt_time),
          updated_at = now()
      where id = v_session.id;
    -- both_connected_at set ONCE when both expected participants are live.
    select count(*) = 2 and bool_and(currently_connected) into v_both
      from public.call_participants where call_session_id = v_session.id;
    if v_both then
      update public.call_sessions set both_connected_at = coalesce(both_connected_at, v_evt_time), updated_at = now()
        where id = v_session.id;
    end if;
    v_result := 'participant_joined';

  elsif p_event_type = 'participant_left' then
    update public.call_participants set
      last_left_at = greatest(coalesce(last_left_at, v_evt_time), v_evt_time),
      -- Add this segment's duration only when it is the newest event and a join is open.
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
      connection_abort_count = connection_abort_count + 1,  -- recorded once; NOT a completed call, NOT a join
      last_event_at = greatest(coalesce(last_event_at, v_evt_time), v_evt_time),
      updated_at = now()
      where id = v_part.id;
    v_result := 'connection_aborted';

  elsif p_event_type = 'room_finished' then
    update public.call_sessions set
      room_finished_at = coalesce(room_finished_at, v_evt_time),
      state = case when state = 'failed' then 'failed' else 'ended' end,   -- do not weaken a terminal failure
      last_provider_event_at = greatest(coalesce(last_provider_event_at, v_evt_time), v_evt_time),
      updated_at = now()
      where id = v_session.id;
    v_result := 'room_finished';

  elsif p_event_type = 'track_published' then
    -- A microphone publication is expected. No media is ever stored.
    v_result := 'track_microphone';

  elsif p_event_type = 'track_anomaly' then
    -- The webhook classified a non-audio (camera/screen-share) publication. Record
    -- a support-safe anomaly counter only — never any media, never the source blob.
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

-- ============================================================
-- 9. Safe USER read: call state for a booking the caller may access. Hides the
--    room name, provider identities and all provider diagnostics.
-- ============================================================
create or replace function public.call_state_for_booking(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_b public.bookings; v_s public.call_sessions;
  v_role text; v_other_connected boolean := false;
begin
  if auth.uid() is null then raise exception 'not_found: call state'; end if;
  select * into v_b from public.bookings where id = p_booking;
  if v_b.id is null then raise exception 'not_found: call state'; end if;

  if auth.uid() = app_private.profile_owner_account(v_b.companion_profile_id) then v_role := 'companion';
  elsif auth.uid() = app_private.profile_owner_account(v_b.member_profile_id) then v_role := 'member';
  elsif app_private.has_profile_access(v_b.member_profile_id)
        or app_private.has_profile_access(v_b.companion_profile_id) then v_role := 'observer';
  else raise exception 'not_found: call state'; end if;

  select * into v_s from public.call_sessions where booking_id = p_booking;
  if v_s.id is not null and v_role in ('member', 'companion') then
    select bool_or(currently_connected) into v_other_connected
      from public.call_participants where call_session_id = v_s.id and booking_role <> v_role;
  end if;

  return jsonb_build_object(
    'your_role', v_role,
    'booking_status', v_b.status,
    'call_state', coalesce(v_s.state, 'none'),
    'scheduled_start', coalesce(v_s.scheduled_start, v_b.starts_at),
    'scheduled_end', coalesce(v_s.scheduled_end, v_b.ends_at),
    'both_connected_at', v_s.both_connected_at,
    'other_participant_connected', coalesce(v_other_connected, false));
end;
$$;
revoke all on function public.call_state_for_booking(uuid) from public, anon;
grant execute on function public.call_state_for_booking(uuid) to authenticated;

-- ============================================================
-- 10. Support-only diagnostic RPC. Connection metadata ONLY, never call content.
-- ============================================================
create or replace function public.support_call_diagnostics(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; v_s public.call_sessions;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: diagnostics'; end if;
  select * into v_s from public.call_sessions where booking_id = p_booking;
  if v_s.id is null then return jsonb_build_object('session', null); end if;
  select jsonb_build_object(
    'session', jsonb_build_object(
      'id', v_s.id, 'booking_id', v_s.booking_id, 'provider', v_s.provider, 'room_name', v_s.room_name,
      'state', v_s.state, 'scheduled_start', v_s.scheduled_start, 'scheduled_end', v_s.scheduled_end,
      'first_participant_joined_at', v_s.first_participant_joined_at, 'both_connected_at', v_s.both_connected_at,
      'room_finished_at', v_s.room_finished_at, 'anomaly_count', v_s.anomaly_count,
      'last_provider_event_at', v_s.last_provider_event_at),
    'participants', coalesce((select jsonb_agg(jsonb_build_object(
        'account_id', p.account_id, 'booking_role', p.booking_role, 'provider_identity', p.provider_identity,
        'first_joined_at', p.first_joined_at, 'last_joined_at', p.last_joined_at, 'last_left_at', p.last_left_at,
        'join_count', p.join_count, 'connection_abort_count', p.connection_abort_count,
        'connected_seconds', p.connected_seconds, 'currently_connected', p.currently_connected)
      order by p.booking_role) from public.call_participants p where p.call_session_id = v_s.id), '[]'::jsonb),
    'latest_events', coalesce((select jsonb_agg(jsonb_build_object(
        'event_type', e.event_type, 'result', e.result, 'error_code', e.error_code,
        'provider_created_at', e.provider_created_at, 'received_at', e.received_at)
      order by e.received_at desc) from (
        select * from public.call_provider_events where call_session_id = v_s.id order by received_at desc limit 20) e), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;
revoke all on function public.support_call_diagnostics(uuid) from public, anon;
grant execute on function public.support_call_diagnostics(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');

-- ============================================================
-- 11. Deferred to Stage 3B (documented, NOT implemented here): mapping
--     authoritative call events to attendance, completion confirmation, no-show
--     handling, booking completion and earning eligibility. Stage 3A performs no
--     financial or booking-completion writes.
-- ============================================================
