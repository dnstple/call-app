-- ============================================================
-- Stage 3B1 — authoritative call attendance evidence + safe completion state
-- (migration 0069).
--
-- Additive to the immutable 0001–0068 baseline. This migration introduces ONLY
-- NEW tables and NEW functions — it does NOT `create or replace` any existing
-- function, so the 0067 stale-cumulative-body class of defect cannot occur here.
--
-- WHAT THIS ADDS
--   * public.call_attendance_evidence — a DERIVED, per-booking evidence cache
--     (one row per call session) computed deterministically from the immutable
--     Stage 3A provider ledger (call_provider_events + call_participants +
--     call_sessions). Raw events are never deleted; the cache is recomputable.
--   * app_private.recompute_attendance_evidence(booking) — the deterministic,
--     idempotent, concurrency-safe aggregator (window-bounded, overlap-aware,
--     with a FIXED aggregation as-of that never lets an open segment grow).
--   * NARROW evidence-only triggers on call_provider_events, call_sessions and
--     call_participants — every recomputation entry point, no polling worker.
--   * public.get_conversation_completion_state(booking) — a role-aware
--     completion read model (payout data is Companion-only; no Stripe / transfer
--     / provider-room / raw-event / secret leakage). It refreshes the evidence
--     cache on read so a window that closes with no further event still finalises.
--   * public.support_attendance_diagnostics(booking) — support-only diagnostics.
--
-- DETERMINISM (see §2 of the audit). Aggregation uses a FIXED as-of boundary:
--   * while the call is not yet finalised (window still open, no room_finished),
--     evidence is PENDING and an unterminated (open) presence contributes ZERO
--     counted seconds — no open segment can grow;
--   * a call finalises when room_finished_at is set OR the evidence window has
--     closed; at that moment the as-of boundary and the evidence WINDOW are
--     FROZEN onto the row, so later recomputes (and later global call_config
--     changes) never rewrite a historical call's durations or classification;
--   * a missing leave is bounded to the frozen as-of — never unbounded.
-- For an identical ledger AND identical finalisation, every SUBSTANTIVE field is
-- identical across recomputes; only calculated_at / updated_at advance.
--
-- FINANCIAL FIREWALL (Stage 3B1 boundary). NOTHING here creates, releases,
-- reverses or alters an earning; calls ensure_companion_earning /
-- make_earning_payable; starts a transfer; creates a refund; resolves a dispute;
-- touches account credit or payment-order money; runs a worker/cron; or calls
-- Stripe/LiveKit. Provider presence is EVIDENCE ONLY. How this evidence affects
-- payout eligibility is deferred to Stage 3B2.
--
-- NO historical rows are updated. NO booking is completed. NO backfill.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Derived evidence model. One row per booking's call session. Every column is
--    server-derived from the immutable ledger; nothing is client-supplied.
-- ------------------------------------------------------------
create table if not exists public.call_attendance_evidence (
  booking_id uuid primary key references public.bookings(id) on delete cascade,
  call_session_id uuid not null references public.call_sessions(id) on delete cascade,

  -- The evidence window actually used. Snapshot- + config-derived while pending;
  -- FROZEN here at finalisation so later config changes cannot rewrite it.
  window_opens_at timestamptz not null,
  window_closes_at timestamptz not null,

  -- Lifecycle. `finalised` = the call is over (room finished OR window closed);
  -- `evidence_asof_at` is the FIXED upper bound used for any open segment.
  finalised boolean not null default false,
  evidence_asof_at timestamptz,

  -- Per logical side (a managed guest is the Member side, never a third role).
  companion_first_joined_at timestamptz,
  companion_last_left_at timestamptz,
  companion_connected_seconds integer not null default 0 check (companion_connected_seconds >= 0),
  companion_join_count integer not null default 0 check (companion_join_count >= 0),
  companion_ever_connected boolean not null default false,
  member_first_joined_at timestamptz,
  member_last_left_at timestamptz,
  member_connected_seconds integer not null default 0 check (member_connected_seconds >= 0),
  member_join_count integer not null default 0 check (member_join_count >= 0),
  member_ever_connected boolean not null default false,

  -- Cross-side simultaneity.
  overlap_seconds integer not null default 0 check (overlap_seconds >= 0),
  both_connected boolean not null default false,

  -- Provider-event consistency signals.
  relevant_event_count integer not null default 0 check (relevant_event_count >= 0),
  had_missing_leave boolean not null default false,
  had_open_segment boolean not null default false,        -- an unterminated presence (pending or finalised)
  had_inconsistent_events boolean not null default false,

  -- Neutral evidence quality + classification (never a financial verdict).
  evidence_quality text not null check (evidence_quality in
    ('complete', 'partial', 'no_provider_events', 'inconsistent_provider_events',
     'outside_eligible_booking', 'pending_call_window')),
  evidence_classification text not null check (evidence_classification in
    ('both_connected', 'companion_only', 'member_only', 'neither_observed',
     'insufficient_evidence', 'pending')),

  -- Recompute provenance.
  evidence_version integer not null default 2,
  last_provider_event_id text,
  last_provider_event_at timestamptz,
  calculated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists call_attendance_evidence_session_idx
  on public.call_attendance_evidence (call_session_id);
alter table public.call_attendance_evidence enable row level security;
-- Belt-and-braces: force RLS so even a future table owner / BYPASSRLS mishap is
-- covered. There are NO policies, so every direct client read/write is denied by
-- default; the table is reachable ONLY through the SECURITY DEFINER RPCs below,
-- which derive the caller's role server-side.
alter table public.call_attendance_evidence force row level security;

-- ============================================================
-- 2. Deterministic aggregator. Pure function of the immutable ledger + the FROZEN
--    or snapshot window + a FIXED as-of. Idempotent and concurrency-safe (locks
--    the session row, exactly like ingest_call_event). EVIDENCE ONLY.
-- ============================================================
-- p_resnapshot = the caller is a LEGITIMATE reschedule (scheduled_start/end
-- changed) and may replace the stored window — but ONLY while the window has not
-- opened, no relevant event exists and the call is not finalised. Every other
-- caller (default false) always reuses the stored window and never re-reads
-- call_config, so a later GLOBAL config change can never rewrite an existing call.
create or replace function app_private.recompute_attendance_evidence(p_booking uuid, p_resnapshot boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c_version constant integer := 2;                 -- bump when the algorithm changes
  v_b public.bookings;
  v_s public.call_sessions;
  v_cfg public.call_config;
  v_ex public.call_attendance_evidence;            -- existing row (for the freeze rule)
  v_has_evidence boolean; v_frozen boolean;        -- window-snapshot freeze latch
  v_opens timestamptz; v_closes timestamptz;
  v_finalised boolean; v_asof timestamptz;
  v_evt record;
  -- per-side segment accumulators (within-side segments are non-overlapping by
  -- construction: a new segment opens only when the previous one has closed).
  v_cs timestamptz[] := '{}'; v_ce timestamptz[] := '{}';   -- companion starts/ends
  v_ms timestamptz[] := '{}'; v_me timestamptz[] := '{}';   -- member starts/ends
  v_c_open timestamptz; v_m_open timestamptz;
  v_c_joins int := 0; v_m_joins int := 0;
  v_rel int := 0; v_inconsistent boolean := false; v_missing_leave boolean := false; v_open boolean := false;
  v_c_secs int := 0; v_m_secs int := 0; v_overlap int := 0;
  v_c_first timestamptz; v_c_last timestamptz; v_m_first timestamptz; v_m_last timestamptz;
  v_c_ever boolean; v_m_ever boolean;
  v_quality text; v_class text;
  v_last_id text; v_last_at timestamptz;
  i int; j int; s1 timestamptz; e1 timestamptz;
begin
  select * into v_b from public.bookings where id = p_booking;
  if v_b.id is null then return; end if;
  -- Lock the session so all events for one session aggregate serially; a missing
  -- session means there is nothing to derive yet (evidence stays absent).
  select * into v_s from public.call_sessions where booking_id = p_booking for update;
  if v_s.id is null then return; end if;
  select * into v_cfg from public.call_config where id;
  select * into v_ex from public.call_attendance_evidence where booking_id = p_booking;

  -- Has a RELEVANT, mapped provider event already been recorded for this session?
  -- (participant join/leave/abort resolved to a known side.) Determined purely
  -- from the immutable ledger.
  select exists (
    select 1 from public.call_provider_events e
    join public.call_participants cp
      on cp.call_session_id = v_s.id and cp.provider_identity = e.participant_identity
    where e.call_session_id = v_s.id
      and e.event_type in ('participant_joined', 'participant_left', 'participant_connection_aborted')
  ) into v_has_evidence;

  -- WINDOW SNAPSHOT + FREEZE. call_config is read ONLY when a window is first
  -- created OR replaced by a legitimate pre-evidence reschedule — NEVER on an
  -- ordinary recompute. The window is PERMANENTLY frozen once ANY of: the call is
  -- finalised, the (stored) window has opened, or the first relevant event exists.
  -- Effect: a later global call_config change touches only sessions created after
  -- the change; it can never rewrite an existing call's boundaries, durations,
  -- overlap or classification.
  if v_ex.booking_id is null then
    -- First creation: snapshot the CURRENT config (the ONLY unconditional read).
    v_opens := v_s.scheduled_start - make_interval(mins => coalesce(v_cfg.join_opens_before_start_minutes, 10));
    v_closes := v_s.scheduled_end + make_interval(mins => coalesce(v_cfg.join_closes_after_end_minutes, 30));
  else
    v_frozen := v_ex.finalised or now() >= v_ex.window_opens_at or v_has_evidence;
    if p_resnapshot and not v_frozen then
      -- A LEGITIMATE reschedule BEFORE the window opens and BEFORE any evidence:
      -- re-snapshot from the new schedule + current config.
      v_opens := v_s.scheduled_start - make_interval(mins => coalesce(v_cfg.join_opens_before_start_minutes, 10));
      v_closes := v_s.scheduled_end + make_interval(mins => coalesce(v_cfg.join_closes_after_end_minutes, 30));
    else
      -- ORDINARY recompute (and any reschedule attempted after evidence started):
      -- ALWAYS reuse the STORED window — existing events are never reinterpreted
      -- under new boundaries, and current call_config is never re-read.
      v_opens := v_ex.window_opens_at; v_closes := v_ex.window_closes_at;
    end if;
  end if;

  -- FIXED aggregation as-of. Finalised ⇔ the call is over. The as-of NEVER
  -- depends on now() once finalised, so recompute is historically stable.
  if v_ex.booking_id is not null and v_ex.finalised then
    v_finalised := true; v_asof := v_ex.evidence_asof_at;
  elsif v_s.room_finished_at is not null then
    v_finalised := true; v_asof := least(v_s.room_finished_at, v_closes);
  elsif now() >= v_closes then
    v_finalised := true; v_asof := v_closes;
  else
    v_finalised := false; v_asof := null;                  -- PENDING: open presence is not counted
  end if;

  -- Walk the ledger in a fully deterministic order. Map identity → logical side
  -- via the expected participant rows (guest identity resolves to Member).
  for v_evt in
    select e.provider_event_id, e.event_type,
           coalesce(e.provider_created_at, e.received_at) as t,
           cp.booking_role as side
    from public.call_provider_events e
    left join public.call_participants cp
      on cp.call_session_id = v_s.id and cp.provider_identity = e.participant_identity
    where e.call_session_id = v_s.id
      and e.event_type in ('participant_joined', 'participant_left', 'participant_connection_aborted')
    order by coalesce(e.provider_created_at, e.received_at), e.received_at, e.provider_event_id
  loop
    v_last_id := v_evt.provider_event_id; v_last_at := v_evt.t;
    if v_evt.side is null then continue; end if;      -- unexpected identity: never counted
    v_rel := v_rel + 1;

    if v_evt.event_type = 'participant_joined' then
      if v_evt.side = 'companion' then
        v_c_joins := v_c_joins + 1;
        if v_c_open is null then v_c_open := v_evt.t; end if;   -- duplicate/again-open: keep earliest
      else
        v_m_joins := v_m_joins + 1;
        if v_m_open is null then v_m_open := v_evt.t; end if;
      end if;

    elsif v_evt.event_type = 'participant_left' then
      if v_evt.side = 'companion' then
        if v_c_open is not null then
          v_cs := array_append(v_cs, v_c_open); v_ce := array_append(v_ce, v_evt.t); v_c_open := null;
        else
          v_inconsistent := true;                     -- leave with no open join
        end if;
      else
        if v_m_open is not null then
          v_ms := array_append(v_ms, v_m_open); v_me := array_append(v_me, v_evt.t); v_m_open := null;
        else
          v_inconsistent := true;
        end if;
      end if;
    end if;
    -- participant_connection_aborted: counted as a relevant event only.
  end loop;

  -- Handle any still-open (unterminated) presence.
  --   * FINALISED  → close at the FIXED as-of boundary (bounded, stable, never
  --                  unbounded) and record a missing leave.
  --   * PENDING    → do NOT count it — an open segment must never grow. Only the
  --                  fact of an open presence is recorded.
  if v_c_open is not null then
    v_open := true;
    if v_finalised then v_cs := array_append(v_cs, v_c_open); v_ce := array_append(v_ce, v_asof); v_missing_leave := true; end if;
  end if;
  if v_m_open is not null then
    v_open := true;
    if v_finalised then v_ms := array_append(v_ms, v_m_open); v_me := array_append(v_me, v_asof); v_missing_leave := true; end if;
  end if;

  -- Companion: clamp each segment to the window, accumulate seconds + edges.
  for i in 1 .. coalesce(array_length(v_cs, 1), 0) loop
    if v_ce[i] < v_cs[i] then v_inconsistent := true; end if;
    s1 := greatest(v_cs[i], v_opens); e1 := least(v_ce[i], v_closes);
    if e1 > s1 then
      v_c_secs := v_c_secs + floor(extract(epoch from (e1 - s1)))::int;
      v_c_first := least(coalesce(v_c_first, s1), s1);
      v_c_last := greatest(coalesce(v_c_last, e1), e1);
    end if;
  end loop;
  -- Member: same.
  for i in 1 .. coalesce(array_length(v_ms, 1), 0) loop
    if v_me[i] < v_ms[i] then v_inconsistent := true; end if;
    s1 := greatest(v_ms[i], v_opens); e1 := least(v_me[i], v_closes);
    if e1 > s1 then
      v_m_secs := v_m_secs + floor(extract(epoch from (e1 - s1)))::int;
      v_m_first := least(coalesce(v_m_first, s1), s1);
      v_m_last := greatest(coalesce(v_m_last, e1), e1);
    end if;
  end loop;

  -- Overlap: sum of intersections of every companion×member clamped segment.
  -- Non-overlapping within a side ⇒ this equals the true simultaneous seconds.
  for i in 1 .. coalesce(array_length(v_cs, 1), 0) loop
    for j in 1 .. coalesce(array_length(v_ms, 1), 0) loop
      s1 := greatest(greatest(v_cs[i], v_ms[j]), v_opens);
      e1 := least(least(v_ce[i], v_me[j]), v_closes);
      if e1 > s1 then v_overlap := v_overlap + floor(extract(epoch from (e1 - s1)))::int; end if;
    end loop;
  end loop;

  v_c_ever := v_c_secs > 0;
  v_m_ever := v_m_secs > 0;

  -- Neutral quality. Never infers absence from silence; pending until finalised.
  if v_b.status <> 'confirmed' then
    v_quality := 'outside_eligible_booking';
  elsif not v_finalised then
    v_quality := 'pending_call_window';
  elsif v_rel = 0 then
    v_quality := 'no_provider_events';
  elsif v_inconsistent then
    v_quality := 'inconsistent_provider_events';
  elsif v_missing_leave then
    v_quality := 'partial';
  else
    v_quality := 'complete';
  end if;

  -- Neutral classification (evidence-focused, NOT a financial verdict).
  if v_quality = 'pending_call_window' then
    v_class := 'pending';
  elsif v_quality in ('outside_eligible_booking', 'no_provider_events', 'inconsistent_provider_events') then
    v_class := 'insufficient_evidence';
  elsif v_c_ever and v_m_ever then
    v_class := 'both_connected';
  elsif v_c_ever then
    v_class := 'companion_only';
  elsif v_m_ever then
    v_class := 'member_only';
  else
    v_class := 'neither_observed';
  end if;

  insert into public.call_attendance_evidence as ev (
    booking_id, call_session_id, window_opens_at, window_closes_at, finalised, evidence_asof_at,
    companion_first_joined_at, companion_last_left_at, companion_connected_seconds,
    companion_join_count, companion_ever_connected,
    member_first_joined_at, member_last_left_at, member_connected_seconds,
    member_join_count, member_ever_connected,
    overlap_seconds, both_connected, relevant_event_count, had_missing_leave, had_open_segment,
    had_inconsistent_events, evidence_quality, evidence_classification,
    evidence_version, last_provider_event_id, last_provider_event_at, calculated_at, updated_at)
  values (
    p_booking, v_s.id, v_opens, v_closes, v_finalised, v_asof,
    v_c_first, v_c_last, v_c_secs, v_c_joins, v_c_ever,
    v_m_first, v_m_last, v_m_secs, v_m_joins, v_m_ever,
    v_overlap, v_overlap > 0, v_rel, v_missing_leave, v_open,
    v_inconsistent, v_quality, v_class,
    c_version, v_last_id, v_last_at, now(), now())
  on conflict (booking_id) do update set
    call_session_id = excluded.call_session_id,
    window_opens_at = excluded.window_opens_at, window_closes_at = excluded.window_closes_at,
    finalised = excluded.finalised, evidence_asof_at = excluded.evidence_asof_at,
    companion_first_joined_at = excluded.companion_first_joined_at,
    companion_last_left_at = excluded.companion_last_left_at,
    companion_connected_seconds = excluded.companion_connected_seconds,
    companion_join_count = excluded.companion_join_count,
    companion_ever_connected = excluded.companion_ever_connected,
    member_first_joined_at = excluded.member_first_joined_at,
    member_last_left_at = excluded.member_last_left_at,
    member_connected_seconds = excluded.member_connected_seconds,
    member_join_count = excluded.member_join_count,
    member_ever_connected = excluded.member_ever_connected,
    overlap_seconds = excluded.overlap_seconds, both_connected = excluded.both_connected,
    relevant_event_count = excluded.relevant_event_count,
    had_missing_leave = excluded.had_missing_leave, had_open_segment = excluded.had_open_segment,
    had_inconsistent_events = excluded.had_inconsistent_events,
    evidence_quality = excluded.evidence_quality,
    evidence_classification = excluded.evidence_classification,
    evidence_version = excluded.evidence_version,
    last_provider_event_id = excluded.last_provider_event_id,
    last_provider_event_at = excluded.last_provider_event_at,
    calculated_at = now(), updated_at = now();
end;
$$;
revoke all on function app_private.recompute_attendance_evidence(uuid, boolean) from public, anon, authenticated;
grant execute on function app_private.recompute_attendance_evidence(uuid, boolean) to service_role;

-- Public service-role wrapper (PostgREST-reachable; for ops/tests to force a
-- deterministic refresh). EVIDENCE ONLY — never a financial call. Ordinary
-- refresh only (never re-snapshots the window).
create or replace function public.recompute_attendance_evidence(p_booking uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.recompute_attendance_evidence(p_booking);
end;
$$;
revoke all on function public.recompute_attendance_evidence(uuid) from public, anon, authenticated;
grant execute on function public.recompute_attendance_evidence(uuid) to service_role;

-- ============================================================
-- 3. NARROW, EVIDENCE-ONLY triggers — every recomputation entry point. Each
--    writes ONLY call_attendance_evidence, so none can recurse or move money.
-- ============================================================

-- 3a. A provider event was attached to its session. Fire ONCE per event, for
--     evidence-relevant types only — never on the later processed_at/result
--     bookkeeping update (guarded by the call_session_id transition). Split
--     INSERT/UPDATE triggers so each WHEN references only the legal row images.
create or replace function app_private.trg_evidence_from_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_booking uuid;
begin
  select booking_id into v_booking from public.call_sessions where id = new.call_session_id;
  if v_booking is not null then perform app_private.recompute_attendance_evidence(v_booking); end if;
  return new;
end;
$$;
revoke all on function app_private.trg_evidence_from_event() from public, anon, authenticated;
drop trigger if exists call_provider_events_evidence_sync on public.call_provider_events;
drop trigger if exists call_provider_events_evidence_ins on public.call_provider_events;
drop trigger if exists call_provider_events_evidence_upd on public.call_provider_events;
create trigger call_provider_events_evidence_ins
  after insert on public.call_provider_events
  for each row
  when (new.call_session_id is not null
        and new.event_type in ('participant_joined', 'participant_left', 'participant_connection_aborted',
                               'room_finished', 'room_started'))
  execute function app_private.trg_evidence_from_event();
create trigger call_provider_events_evidence_upd
  after update on public.call_provider_events
  for each row
  when (new.call_session_id is not null
        and old.call_session_id is distinct from new.call_session_id
        and new.event_type in ('participant_joined', 'participant_left', 'participant_connection_aborted',
                               'room_finished', 'room_started'))
  execute function app_private.trg_evidence_from_event();

-- 3b. The session snapshot changed: reschedule (scheduled_start/end), the call
--     ending (room_finished_at) or a state change — including the case where the
--     window closes and the terminal room_finished event lands (updating the
--     session) with no NEW provider-event row. Fires on the exact columns that
--     affect evidence.
create or replace function app_private.trg_evidence_from_session()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_resnapshot boolean := false;
begin
  -- Only a genuine reschedule (scheduled_start/end changed) may re-snapshot the
  -- window — and recompute still enforces the pre-window / no-evidence guard.
  if tg_op = 'UPDATE' then
    v_resnapshot := old.scheduled_start is distinct from new.scheduled_start
                    or old.scheduled_end is distinct from new.scheduled_end;
  end if;
  perform app_private.recompute_attendance_evidence(new.booking_id, v_resnapshot);
  return new;
end;
$$;
revoke all on function app_private.trg_evidence_from_session() from public, anon, authenticated;
drop trigger if exists call_sessions_evidence_sync on public.call_sessions;
drop trigger if exists call_sessions_evidence_ins on public.call_sessions;
drop trigger if exists call_sessions_evidence_upd on public.call_sessions;
create trigger call_sessions_evidence_ins
  after insert on public.call_sessions
  for each row
  execute function app_private.trg_evidence_from_session();
create trigger call_sessions_evidence_upd
  after update on public.call_sessions
  for each row
  when (old.scheduled_start is distinct from new.scheduled_start
        or old.scheduled_end is distinct from new.scheduled_end
        or old.room_finished_at is distinct from new.room_finished_at
        or old.state is distinct from new.state)
  execute function app_private.trg_evidence_from_session();

-- 3c. A participant slot was created or its identity mapping changed (e.g. a
--     verified guest materialised into the Member slot). Re-derive so the ledger
--     maps to the right side.
create or replace function app_private.trg_evidence_from_participant()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_booking uuid;
begin
  select booking_id into v_booking from public.call_sessions where id = new.call_session_id;
  if v_booking is not null then perform app_private.recompute_attendance_evidence(v_booking); end if;
  return new;
end;
$$;
revoke all on function app_private.trg_evidence_from_participant() from public, anon, authenticated;
drop trigger if exists call_participants_evidence_sync on public.call_participants;
drop trigger if exists call_participants_evidence_ins on public.call_participants;
drop trigger if exists call_participants_evidence_upd on public.call_participants;
create trigger call_participants_evidence_ins
  after insert on public.call_participants
  for each row
  execute function app_private.trg_evidence_from_participant();
create trigger call_participants_evidence_upd
  after update on public.call_participants
  for each row
  when (old.provider_identity is distinct from new.provider_identity
        or old.guest_invitation_id is distinct from new.guest_invitation_id
        or old.account_id is distinct from new.account_id)
  execute function app_private.trg_evidence_from_participant();

select pg_notify('pgrst', 'reload schema');

-- ============================================================
-- 4. Role-aware completion read model. The caller's role is derived server-side.
--    Payout data is Companion-only. This RPC NEVER writes money, never creates a
--    declaration/confirmation, and never transitions a booking. It DOES refresh
--    the evidence cache on read (AFTER authorising the caller), so a window that
--    closes with no further provider event still finalises deterministically.
--
--    Completion states are ALL DERIVED here (nothing new is stored): the only
--    persisted attendance state remains conversation_attendance (Companion
--    declaration), completion_confirmations (Member confirmation),
--    conversation_issues (issues) and companion_earnings (payout).
--
--    Derived completion_state vocabulary + priority (post-end, confirmed):
--      cancelled_or_declined / not_eligible / scheduled / call_window_open /
--      issue_open / evidence_conflict / companion_reported_member_absent /
--      finalised / member_confirmed / companion_reported_took_place /
--      awaiting_companion_report.
-- ============================================================
create or replace function public.get_conversation_completion_state(p_booking uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_substantial_overlap_seconds constant integer := 60;   -- named policy threshold (§7)
  v_b public.bookings;
  v_role text;
  v_cfg public.call_config;
  v_s public.call_sessions;
  v_ev public.call_attendance_evidence;
  v_a public.conversation_attendance;
  v_mc public.completion_confirmations;
  v_rev public.conversation_reviews;
  v_earn public.companion_earnings;
  v_opens timestamptz; v_closes timestamptz;
  v_ended boolean; v_window_open boolean;
  v_issue_open boolean;
  v_quality text; v_class text; v_processing boolean;
  v_c_ever boolean; v_m_ever boolean; v_overlap int;
  v_conflict boolean := false;
  v_decl text; v_mconf text; v_review_done boolean;
  v_state text; v_payout text := null;
  v_result jsonb;
begin
  if auth.uid() is null then raise exception 'not_found: conversation'; end if;
  select * into v_b from public.bookings where id = p_booking;
  if v_b.id is null then raise exception 'not_found: conversation'; end if;

  -- Server-derived role. Companion (profile editor) wins; then the Member side
  -- (self or managing Coordinator); then support (redacted, non-payout view).
  if app_private.can_edit_profile(v_b.companion_profile_id) then
    v_role := 'companion';
  elsif v_b.booked_by_account_id = auth.uid() or app_private.can_act_for_member(v_b.member_profile_id) then
    v_role := 'member';
  elsif app_private.is_support_admin() then
    v_role := 'support';
  else
    raise exception 'not_found: conversation';           -- unrelated: identical to nonexistent
  end if;

  -- Refresh the evidence cache ONLY after the caller is authorised (an unrelated
  -- caller can never trigger a recompute). Idempotent + evidence-only.
  perform app_private.recompute_attendance_evidence(p_booking);

  select * into v_cfg from public.call_config where id;
  select * into v_s from public.call_sessions where booking_id = p_booking;
  select * into v_ev from public.call_attendance_evidence where booking_id = p_booking;
  select * into v_a from public.conversation_attendance where booking_id = p_booking;
  select * into v_mc from public.completion_confirmations where booking_id = p_booking and participant_side = 'member';
  select * into v_rev from public.conversation_reviews where booking_id = p_booking;
  select * into v_earn from public.companion_earnings where booking_id = p_booking;
  v_issue_open := exists (select 1 from public.conversation_issues i
                          where i.booking_id = p_booking and i.state <> 'resolved');

  -- Prefer the FROZEN evidence window when present (historical stability), else
  -- derive from the session snapshot or booking + config.
  v_opens := coalesce(v_ev.window_opens_at, coalesce(v_s.scheduled_start, v_b.starts_at) - make_interval(mins => coalesce(v_cfg.join_opens_before_start_minutes, 10)));
  v_closes := coalesce(v_ev.window_closes_at, coalesce(v_s.scheduled_end, v_b.ends_at) + make_interval(mins => coalesce(v_cfg.join_closes_after_end_minutes, 30)));
  v_ended := v_b.ends_at <= now();
  v_window_open := now() >= v_opens and now() <= v_closes;

  -- Evidence facts (overlay LIVE booking status so a later decline/cancel is
  -- reflected even if the cached row predates the status change).
  v_c_ever := coalesce(v_ev.companion_ever_connected, false);
  v_m_ever := coalesce(v_ev.member_ever_connected, false);
  v_overlap := coalesce(v_ev.overlap_seconds, 0);
  if v_b.status <> 'confirmed' then
    v_quality := 'outside_eligible_booking'; v_class := 'insufficient_evidence'; v_processing := false;
  elsif v_ev.booking_id is not null then
    v_quality := v_ev.evidence_quality; v_class := v_ev.evidence_classification; v_processing := not v_ev.finalised;
  elsif now() < v_closes then
    v_quality := 'pending_call_window'; v_class := 'pending'; v_processing := true;
  else
    v_quality := 'no_provider_events'; v_class := 'insufficient_evidence'; v_processing := false;
  end if;

  v_decl := v_a.outcome;                                 -- Companion declaration (nullable)
  v_mconf := v_mc.outcome;                               -- Member confirmation (nullable)
  v_review_done := v_rev.id is not null;

  -- DERIVED conflict — surfaced, never auto-actioned, never overwrites a source.
  -- Only meaningful once there is real, judgeable evidence (not pending/absent).
  if v_class in ('both_connected', 'companion_only', 'member_only', 'neither_observed') then
    if v_decl = 'took_place' and not v_c_ever then v_conflict := true; end if;          -- A
    if v_mconf = 'completed' and v_class = 'neither_observed' then v_conflict := true; end if;  -- C
    if v_mconf in ('did_not_happen', 'report_concern') and v_overlap >= c_substantial_overlap_seconds then v_conflict := true; end if; -- D
    if v_decl = 'took_place' and v_mconf = 'did_not_happen' then v_conflict := true; end if;    -- declaration clash
  end if;
  if v_quality = 'inconsistent_provider_events' and (v_decl is not null or v_mconf is not null) then
    v_conflict := true;                                                                  -- E
  end if;

  -- DERIVED completion state (priority order).
  if v_b.status in ('cancelled', 'declined') then
    v_state := 'cancelled_or_declined';
  elsif v_b.status in ('requested', 'change_proposed') then
    v_state := 'not_eligible';
  elsif v_b.status = 'confirmed' and not v_ended and now() < v_opens then
    v_state := 'scheduled';
  elsif v_b.status = 'confirmed' and not v_ended and v_window_open then
    v_state := 'call_window_open';
  elsif v_b.status = 'confirmed' and not v_ended then
    v_state := 'scheduled';
  elsif v_b.status = 'confirmed' then                    -- confirmed AND ended
    if v_issue_open then v_state := 'issue_open';
    elsif v_conflict then v_state := 'evidence_conflict';
    elsif v_decl = 'member_no_show' then v_state := 'companion_reported_member_absent';
    elsif v_decl = 'took_place' and v_review_done then v_state := 'finalised';
    elsif v_decl = 'took_place' and v_mconf = 'completed' then v_state := 'member_confirmed';
    elsif v_decl = 'took_place' then v_state := 'companion_reported_took_place';
    elsif v_decl in ('technical_problem', 'other') then v_state := 'companion_reported_took_place';
    else v_state := 'awaiting_companion_report';
    end if;
  else
    v_state := 'not_eligible';
  end if;

  -- Common, role-safe payload (NO payout data, NO room name, NO raw events).
  v_result := jsonb_build_object(
    'your_role', v_role,
    'booking_status', v_b.status,
    'ended', v_ended,
    'scheduled_start', coalesce(v_s.scheduled_start, v_b.starts_at),
    'scheduled_end', coalesce(v_s.scheduled_end, v_b.ends_at),
    'completion_state', v_state,
    'evidence_processing', v_processing,
    'evidence_quality', v_quality,
    'evidence_classification', v_class,
    'both_observed', v_c_ever and v_m_ever,
    'companion_observed', v_c_ever,
    'member_observed', v_m_ever,
    'evidence_conflict', v_conflict,
    'companion_declaration', v_decl,
    'member_confirmation', v_mconf,
    'issue_open', v_issue_open,
    'review_recorded', v_review_done,
    'review_eligible', v_role = 'member' and v_b.status = 'confirmed' and v_ended and v_mconf = 'completed');

  -- Companion-only: a user-safe payout status. NEVER Stripe ids, transfer state,
  -- amounts or worker diagnostics.
  if v_role = 'companion' then
    v_payout := case v_earn.state
      when 'payable' then 'ready_for_payout'
      when 'held_for_issue' then 'on_hold'
      when 'pending_completion' then 'pending'
      when 'reversed' then 'reversed'
      else 'none' end;
    v_result := v_result || jsonb_build_object(
      'attendance_submitted', v_a.id is not null,
      'payout_status', v_payout,
      'companion_connected_seconds', coalesce(v_ev.companion_connected_seconds, 0),
      'member_connected_seconds', coalesce(v_ev.member_connected_seconds, 0),
      'overlap_seconds', v_overlap);
  end if;

  return v_result;
end;
$$;
revoke all on function public.get_conversation_completion_state(uuid) from public, anon;
grant execute on function public.get_conversation_completion_state(uuid) to authenticated;

-- ============================================================
-- 5. Support-only diagnostics. Connection + declaration + confirmation metadata
--    ONLY. No access tokens, no LiveKit/Stripe secrets, no guest invitation
--    secret, no message bodies, no private review feedback, no provider room
--    name, no raw provider events, no card/bank detail. Refreshes the cache
--    on read (support-gated first).
-- ============================================================
create or replace function public.support_attendance_diagnostics(p_booking uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_substantial_overlap_seconds constant integer := 60;
  v_b public.bookings; v_s public.call_sessions; v_ev public.call_attendance_evidence;
  v_a public.conversation_attendance; v_mc public.completion_confirmations;
  v_issue_open boolean;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: diagnostics'; end if;
  select * into v_b from public.bookings where id = p_booking;
  if v_b.id is null then return jsonb_build_object('booking', null); end if;
  perform app_private.recompute_attendance_evidence(p_booking);   -- support-gated refresh
  select * into v_s from public.call_sessions where booking_id = p_booking;
  select * into v_ev from public.call_attendance_evidence where booking_id = p_booking;
  select * into v_a from public.conversation_attendance where booking_id = p_booking;
  select * into v_mc from public.completion_confirmations where booking_id = p_booking and participant_side = 'member';
  v_issue_open := exists (select 1 from public.conversation_issues i
                          where i.booking_id = p_booking and i.state <> 'resolved');

  return jsonb_build_object(
    'booking', jsonb_build_object('id', v_b.id, 'status', v_b.status,
      'scheduled_start', v_b.starts_at, 'scheduled_end', v_b.ends_at),
    'call_session', case when v_s.id is null then null else jsonb_build_object(
      'state', v_s.state, 'scheduled_start', v_s.scheduled_start, 'scheduled_end', v_s.scheduled_end,
      'first_participant_joined_at', v_s.first_participant_joined_at, 'both_connected_at', v_s.both_connected_at,
      'room_finished_at', v_s.room_finished_at, 'anomaly_count', v_s.anomaly_count) end,
    'sides', case when v_s.id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('booking_role', p.booking_role,
        'holder', case when p.account_id is not null then 'account' else 'guest' end,
        'first_joined_at', p.first_joined_at, 'last_left_at', p.last_left_at,
        'join_count', p.join_count, 'connection_abort_count', p.connection_abort_count,
        'connected_seconds', p.connected_seconds, 'currently_connected', p.currently_connected)
        order by p.booking_role) from public.call_participants p where p.call_session_id = v_s.id), '[]'::jsonb) end,
    'evidence', case when v_ev.booking_id is null then null else jsonb_build_object(
      'finalised', v_ev.finalised, 'evidence_asof_at', v_ev.evidence_asof_at,
      'window_opens_at', v_ev.window_opens_at, 'window_closes_at', v_ev.window_closes_at,
      'companion_connected_seconds', v_ev.companion_connected_seconds, 'companion_ever_connected', v_ev.companion_ever_connected,
      'companion_join_count', v_ev.companion_join_count,
      'member_connected_seconds', v_ev.member_connected_seconds, 'member_ever_connected', v_ev.member_ever_connected,
      'member_join_count', v_ev.member_join_count,
      'overlap_seconds', v_ev.overlap_seconds, 'both_connected', v_ev.both_connected,
      'relevant_event_count', v_ev.relevant_event_count, 'had_missing_leave', v_ev.had_missing_leave,
      'had_open_segment', v_ev.had_open_segment, 'had_inconsistent_events', v_ev.had_inconsistent_events,
      'evidence_quality', v_ev.evidence_quality, 'evidence_classification', v_ev.evidence_classification,
      'evidence_version', v_ev.evidence_version, 'calculated_at', v_ev.calculated_at,
      'last_provider_event_at', v_ev.last_provider_event_at) end,
    'companion_declaration', jsonb_build_object('outcome', v_a.outcome, 'source', v_a.source, 'submitted_at', v_a.created_at),
    'member_confirmation', case when v_mc.id is null then null else
      jsonb_build_object('outcome', v_mc.outcome, 'submitted_at', v_mc.updated_at) end,
    'issue_open', v_issue_open,
    'evidence_conflict', (
      v_ev.booking_id is not null
      and v_ev.evidence_classification in ('both_connected', 'companion_only', 'member_only', 'neither_observed')
      and (
        (v_a.outcome = 'took_place' and not v_ev.companion_ever_connected)
        or (v_mc.outcome = 'completed' and v_ev.evidence_classification = 'neither_observed')
        or (v_mc.outcome in ('did_not_happen', 'report_concern') and v_ev.overlap_seconds >= c_substantial_overlap_seconds)
        or (v_a.outcome = 'took_place' and v_mc.outcome = 'did_not_happen'))));
end;
$$;
revoke all on function public.support_attendance_diagnostics(uuid) from public, anon;
grant execute on function public.support_attendance_diagnostics(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
