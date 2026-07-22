-- ============================================================
-- Stage 3B1 — normalise completion read-model booleans (migration 0070).
--
-- Additive over the immutable 0001–0069 baseline. NARROW corrective redefinition
-- of ONE function, public.get_conversation_completion_state, copied VERBATIM from
-- its final cumulative 0069 body with only two changes:
--
--   1. `review_eligible` is now a STRICT boolean. In 0069 it was
--        v_role = 'member' and v_b.status = 'confirmed' and v_ended and v_mconf = 'completed'
--      When the Member has not yet confirmed, v_mconf is NULL, so the AND chain
--      collapses to SQL NULL (three-valued logic: `true and NULL` = NULL) and the
--      RPC returned review_eligible = null instead of false. It is now wrapped in
--      coalesce(..., false) so an authorised Member/Coordinator always receives a
--      strict boolean (false when not yet eligible, true when eligible).
--
--   2. A strict-boolean `review_submitted` is added alongside the existing
--      `review_recorded` (both = a conversation_review exists), so callers have a
--      normalised boolean for "a review has been submitted".
--
-- Every OTHER boolean-style field was audited and is already strict:
--   evidence_processing (assigned true/false in every branch; `not
--   evidence.finalised` where finalised is NOT NULL), evidence_conflict
--   (defaulted false, only ever set true), both/companion/member_observed
--   (coalesced), issue_open (exists()), review_recorded (id is not null),
--   attendance_submitted (id is not null). The `member_confirmation` and
--   `companion_declaration` fields remain nullable OUTCOME TEXT by design
--   (null = no confirmation/declaration yet) — they are not booleans.
--
-- PRESERVED UNCHANGED: caller-role derivation, not_found behaviour, the
-- authorise-then-recompute-on-read order, Member/Coordinator payout redaction,
-- the Companion-only payout status, evidence/window/conflict/completion-state
-- logic, SECURITY DEFINER, set search_path = '', and the existing grants/revokes.
--
-- No booking rows, confirmations, ratings/reviews or earnings are created or
-- altered. No transfer/refund/reconciliation. No backfill. No worker. No Stripe.
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
  -- All boolean-style fields are STRICT booleans; member_confirmation and
  -- companion_declaration remain nullable outcome text (null = none yet).
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
    'review_submitted', v_review_done,
    -- STRICT boolean: coalesce guards the three-valued AND chain (v_mconf may be
    -- NULL before the Member confirms) so an authorised caller never gets null.
    'review_eligible', coalesce(v_role = 'member' and v_b.status = 'confirmed' and v_ended and v_mconf = 'completed', false));

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

select pg_notify('pgrst', 'reload schema');
