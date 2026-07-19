-- ============================================================
-- 2G4B — trusted LiveKit attendance + evidence-backed no-show (0035).
--
-- Audit result: rooms (`booking-{uuid}`) and identities (`companion-…`,
-- `member-…`, `guest_member-{invitationId}`) are ALREADY server-authored
-- by the livekit-token function with single-room grants — clients cannot
-- choose either. The webhook therefore resolves the room name and then
-- VERIFIES it against a funded booking + participant identity in the
-- database (never trusting the name alone). Segments land in 0034's
-- call_attendance_segments via service role only.
--
-- This migration adds the trusted aggregation helper, the safe
-- Companion-facing state reader, and upgrades submit_companion_attendance
-- so member_no_show consults TRUSTED evidence (companion ≥600s, member
-- <120s, no open issue → payable; otherwise held for review). No client
-- can supply or override durations; no Stripe transfers.
-- ============================================================

-- Trusted totals (service/definer use only).
create or replace function app_private.attendance_summary(p_booking uuid)
returns table (companion_seconds integer, member_seconds integer)
language sql stable security definer
set search_path = ''
as $$
  select
    coalesce(sum(duration_seconds) filter (where side = 'companion'), 0)::integer,
    coalesce(sum(duration_seconds) filter (where side = 'member'), 0)::integer
  from public.call_attendance_segments
  where booking_id = p_booking;
$$;
revoke all on function app_private.attendance_summary(uuid) from public, anon, authenticated;

-- Safe Companion-facing completion state (no amounts of the payer, no
-- complaint text, no raw segments).
create or replace function public.get_companion_completion_state(p_booking uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_b public.bookings;
  v_e public.companion_earnings;
  v_a public.conversation_attendance;
begin
  select * into v_b from public.bookings where id = p_booking;
  if v_b.id is null or not exists (
    select 1 from public.profile_access pa
    where pa.profile_id = v_b.companion_profile_id and pa.account_id = auth.uid()
      and pa.access_role = 'owner' and pa.consent_status <> 'withdrawn'
  ) then
    raise exception 'not_found: conversation';
  end if;
  select * into v_e from public.companion_earnings where booking_id = p_booking;
  select * into v_a from public.conversation_attendance where booking_id = p_booking;
  return jsonb_build_object(
    'ended', v_b.ends_at <= now(),
    'funded', v_e.id is not null
      or exists (select 1 from public.payment_orders po
                 where po.booking_id = p_booking
                   and po.provider = 'stripe_test' and po.status = 'succeeded'),
    'attendance_submitted', v_a.id is not null,
    'attendance_outcome', v_a.outcome,
    'earning_state', coalesce(v_e.state, 'pending_completion'));
end;
$$;
revoke all on function public.get_companion_completion_state(uuid) from public, anon;
grant execute on function public.get_companion_completion_state(uuid) to authenticated;

-- Evidence-backed member_no_show (redefines the 0034 RPC; other branches
-- unchanged). The server derives the evidence — no client boolean exists.
create or replace function public.submit_companion_attendance(
  p_booking uuid, p_outcome text, p_explanation text
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_b public.bookings;
  v_earning uuid;
  v_review public.conversation_reviews;
  v_comp integer;
  v_mem integer;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  select * into v_b from public.bookings where id = p_booking;
  if v_b.id is null or not exists (
    select 1 from public.profile_access pa
    where pa.profile_id = v_b.companion_profile_id and pa.account_id = auth.uid()
      and pa.access_role = 'owner' and pa.consent_status <> 'withdrawn'
  ) then
    raise exception 'not_found: conversation';
  end if;
  if v_b.ends_at > now() then
    raise exception 'too_early: the conversation has not finished yet';
  end if;
  if p_outcome not in ('took_place', 'member_no_show', 'technical_problem', 'other') then
    raise exception 'invalid_outcome: unknown attendance outcome';
  end if;
  if p_outcome <> 'took_place' and (p_explanation is null or trim(p_explanation) = '') then
    raise exception 'explanation_required: please describe what happened';
  end if;

  v_earning := app_private.ensure_companion_earning(p_booking);
  if v_earning is null then
    raise exception 'not_eligible: this conversation has no real payment to release';
  end if;

  if exists (select 1 from public.conversation_attendance where booking_id = p_booking) then
    if exists (select 1 from public.conversation_attendance
               where booking_id = p_booking and outcome = p_outcome and source = 'companion') then
      return jsonb_build_object('ok', true, 'repeat', true);
    end if;
    raise exception 'already_submitted: attendance has already been recorded';
  end if;

  insert into public.conversation_attendance
    (booking_id, outcome, source, submitted_by, explanation)
  values (p_booking, p_outcome, 'companion', auth.uid(), nullif(trim(coalesce(p_explanation, '')), ''));

  if p_outcome = 'took_place' then
    select * into v_review from public.conversation_reviews where booking_id = p_booking;
    if (v_review.id is not null and v_review.approved)
       or (v_b.ends_at + interval '12 hours' <= now()
           and not exists (select 1 from public.conversation_issues
                           where booking_id = p_booking and state <> 'resolved')) then
      perform app_private.make_earning_payable(v_earning);
    end if;
  elsif p_outcome = 'member_no_show' then
    -- 2G4B: TRUSTED evidence decides — never the assertion, never a
    -- browser flag. Companion ≥ 600s AND member < 120s AND no open issue.
    select companion_seconds, member_seconds into v_comp, v_mem
      from app_private.attendance_summary(p_booking);
    if v_comp >= 600 and v_mem < 120
       and not exists (select 1 from public.conversation_issues
                       where booking_id = p_booking and state <> 'resolved') then
      update public.conversation_attendance
         set explanation = coalesce(explanation, '')
             || ' [verified by trusted attendance: companion ' || v_comp || 's, member ' || v_mem || 's]'
       where booking_id = p_booking;
      perform app_private.make_earning_payable(v_earning);
      return jsonb_build_object('ok', true, 'evidence', 'verified');
    end if;
    update public.companion_earnings set state = 'held_for_issue', updated_at = now()
     where id = v_earning and state = 'pending_completion';
    insert into public.conversation_issues
      (booking_id, earning_id, reporter_account_id, reporter_role, category,
       description, idempotency_key)
    values (p_booking, v_earning, auth.uid(), 'companion', 'member_no_show',
            trim(p_explanation), 'att-issue-' || p_booking::text)
    on conflict (idempotency_key) do nothing;
    return jsonb_build_object('ok', true, 'evidence', 'insufficient');
  else
    update public.companion_earnings set state = 'held_for_issue', updated_at = now()
     where id = v_earning and state = 'pending_completion';
    insert into public.conversation_issues
      (booking_id, earning_id, reporter_account_id, reporter_role, category,
       description, idempotency_key)
    values (p_booking, v_earning, auth.uid(), 'companion',
            case when p_outcome = 'technical_problem' then 'technical_problem' else 'other' end,
            trim(p_explanation), 'att-issue-' || p_booking::text)
    on conflict (idempotency_key) do nothing;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.submit_companion_attendance(uuid, text, text) from public, anon;
grant execute on function public.submit_companion_attendance(uuid, text, text) to authenticated;
