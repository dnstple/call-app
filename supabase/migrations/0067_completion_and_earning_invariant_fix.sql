-- ============================================================
-- Completion & earning invariant fix (migration 0067).
--
-- Additive corrective migration over the immutable 0001–0066 baseline. It closes
-- an invariant break observed in production (booking ba4f943c): a booking that
-- was NEVER accepted (status 'requested') but was funded and whose end time had
-- passed was swept into the completion workflow — it received an attendance
-- reminder and a review prompt, the Companion submitted 'took_place' attendance,
-- an earning was created and made 'payable', and a transfer was claimed. No
-- booking confirmation ever occurred and no completion_confirmation existed.
--
-- ROOT CAUSE: the attendance/earning/automation paths gated only on
-- `status not in ('cancelled','declined')` (which INCLUDES 'requested') plus a
-- succeeded payment order and elapsed ends_at. None required the booking to have
-- been ACCEPTED.
--
-- AUTHORITATIVE COMPLETION POLICY (enforced here): only a booking that was
-- accepted — `status = 'confirmed'` — may enter the attendance/completion/earning
-- workflow. `requested` (never accepted), `declined`, `cancelled` and
-- `change_proposed` (pending re-negotiation) are ineligible and FAIL CLOSED,
-- regardless of funding or elapsed time. Companion attendance remains the trusted
-- completion signal, but ONLY for a confirmed booking.
--
-- These are `create or replace` redefinitions of applied functions (0034/0035/
-- 0037); 0034–0037 files are not edited. Financial mechanics (thresholds,
-- make_earning_payable, held_for_issue, idempotency, recurring-plan earnings in
-- 0046) are UNCHANGED — only the eligibility gate is tightened. No cron, no
-- Stripe call, no worker run, no data repair.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Earning creation: FAIL CLOSED unless the booking was accepted.
--    This is the single choke point for one-off / trial earnings; it now refuses
--    to create an earning for any non-confirmed booking, even when funded.
--    (Recurring-plan earnings in 0046 are a separate, plan-gated path and are
--    intentionally not touched.)
-- ------------------------------------------------------------
create or replace function app_private.ensure_companion_earning(p_booking uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.payment_orders;
  v_companion_account uuid;
  v_id uuid;
  v_status text;
begin
  select id into v_id from public.companion_earnings where booking_id = p_booking;
  if v_id is not null then return v_id; end if;

  -- INVARIANT: only an ACCEPTED (confirmed) booking may ever earn.
  select status into v_status from public.bookings where id = p_booking;
  if v_status is distinct from 'confirmed' then
    return null; -- requested / declined / cancelled / change_proposed: NO earning, ever.
  end if;

  select * into v_order from public.payment_orders
   where booking_id = p_booking
     and provider = 'stripe_test' and status = 'succeeded'
   for update;
  if v_order.id is null then
    return null; -- simulation / unfunded / ineligible: NO earning, ever.
  end if;

  select pa.account_id into v_companion_account
  from public.profile_access pa
  where pa.profile_id = v_order.companion_profile_id
    and pa.access_role = 'owner' and pa.consent_status <> 'withdrawn'
  limit 1;
  if v_companion_account is null then return null; end if;

  insert into public.companion_earnings
    (booking_id, payment_order_id, companion_account_id, companion_profile_id,
     member_profile_id, payer_account_id, basis_minor, commission_rate_pct,
     commission_minor, net_minor)
  values
    (p_booking, v_order.id, v_companion_account, v_order.companion_profile_id,
     v_order.member_profile_id, v_order.coordinator_account_id,
     v_order.subtotal_minor - v_order.discount_minor,
     v_order.commission_rate_pct, v_order.commission_minor,
     v_order.subtotal_minor - v_order.discount_minor - v_order.commission_minor)
  on conflict (booking_id) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.companion_earnings where booking_id = p_booking;
  end if;
  return v_id;
end;
$$;
revoke all on function app_private.ensure_companion_earning(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Companion attendance: refuse a non-confirmed booking with a clear error
--    (belt-and-braces with the earning gate above). Body identical to 0035
--    except for the added status guard.
-- ------------------------------------------------------------
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
  -- INVARIANT: only an accepted (confirmed) conversation can be attended.
  if v_b.status <> 'confirmed' then
    raise exception 'not_eligible: this conversation was not confirmed, so attendance cannot be recorded';
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

-- ------------------------------------------------------------
-- 3. Attendance reminders: only for accepted (confirmed) bookings.
--    Body identical to 0037 except the eligibility gate.
-- ------------------------------------------------------------
create or replace function public.create_companion_attendance_reminders()
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_companion_account uuid;
  v_member_name text;
  v_count integer := 0;
begin
  for v_row in
    select b.id as booking_id, b.companion_profile_id, b.member_profile_id
    from public.bookings b
    join public.payment_orders po
      on po.booking_id = b.id and po.provider = 'stripe_test' and po.status = 'succeeded'
    where b.ends_at <= now() - interval '2 hours'
      and b.status = 'confirmed'                     -- INVARIANT: accepted bookings only
      and not exists (select 1 from public.conversation_attendance a where a.booking_id = b.id)
      and not exists (select 1 from public.conversation_issues i
                      where i.booking_id = b.id and i.state <> 'resolved')
      and not exists (select 1 from public.notifications n
                      where n.related_booking_id = b.id
                        and n.dedupe_key = 'attendance-reminder-2h:' || b.id::text)
    limit 200
  loop
    select pa.account_id into v_companion_account
    from public.profile_access pa
    where pa.profile_id = v_row.companion_profile_id
      and pa.access_role = 'owner' and pa.consent_status <> 'withdrawn'
    limit 1;
    if v_companion_account is null then continue; end if;

    select first_name into v_member_name from public.profiles where id = v_row.member_profile_id;

    perform app_private.notify_account(
      v_companion_account, 'attendance_reminder', 'Confirm your conversation',
      'Please confirm whether your conversation with '
        || coalesce(v_member_name, 'your member') || ' took place.',
      v_row.booking_id, 'attendance-reminder-2h:' || v_row.booking_id::text);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.create_companion_attendance_reminders() from public, anon, authenticated;
grant execute on function public.create_companion_attendance_reminders() to service_role;

-- ------------------------------------------------------------
-- 4. Review prompts: only for accepted (confirmed) bookings.
-- ------------------------------------------------------------
create or replace function public.create_review_prompts()
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_member_name text;
  v_companion_name text;
  v_count integer := 0;
begin
  for v_row in
    select b.id as booking_id, b.booked_by_account_id, b.member_profile_id, b.companion_profile_id
    from public.bookings b
    join public.payment_orders po
      on po.booking_id = b.id and po.provider = 'stripe_test' and po.status = 'succeeded'
    where b.ends_at <= now()
      and b.status = 'confirmed'                     -- INVARIANT: accepted bookings only
      and not exists (select 1 from public.conversation_reviews r where r.booking_id = b.id)
      and not exists (select 1 from public.conversation_issues i
                      where i.booking_id = b.id and i.state <> 'resolved')
      and not exists (select 1 from public.notifications n
                      where n.related_booking_id = b.id
                        and n.dedupe_key = 'review-prompt:' || b.id::text)
    limit 200
  loop
    select first_name into v_member_name from public.profiles where id = v_row.member_profile_id;
    select first_name into v_companion_name from public.profiles where id = v_row.companion_profile_id;
    perform app_private.notify_account(
      v_row.booked_by_account_id, 'review_prompt', 'How did the conversation go?',
      'Tell us how ' || coalesce(v_member_name, 'your member') || '’s conversation with '
        || coalesce(v_companion_name, 'the companion') || ' went.',
      v_row.booking_id, 'review-prompt:' || v_row.booking_id::text);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.create_review_prompts() from public, anon, authenticated;
grant execute on function public.create_review_prompts() to service_role;

-- ------------------------------------------------------------
-- 5. 24-hour fallback resolver: only for accepted (confirmed) bookings.
--    Body identical to 0037 except the eligibility gate; financial mechanics
--    unchanged.
-- ------------------------------------------------------------
create or replace function public.resolve_unconfirmed_attendance()
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_comp integer;
  v_mem integer;
  v_earning uuid;
  v_companion_account uuid;
  v_member_name text;
  v_companion_name text;
  v_count integer := 0;
begin
  for v_row in
    select b.id as booking_id, b.ends_at, b.booked_by_account_id,
           b.member_profile_id, b.companion_profile_id
    from public.bookings b
    join public.payment_orders po
      on po.booking_id = b.id and po.provider = 'stripe_test' and po.status = 'succeeded'
    where b.ends_at + interval '24 hours' <= now()
      and b.status = 'confirmed'                     -- INVARIANT: accepted bookings only
      and not exists (select 1 from public.conversation_attendance a where a.booking_id = b.id)
      and not exists (select 1 from public.conversation_issues i
                      where i.booking_id = b.id and i.state <> 'resolved')
    limit 100
    for update of b skip locked
  loop
    v_earning := app_private.ensure_companion_earning(v_row.booking_id);
    if v_earning is null then continue; end if;

    select companion_account_id into v_companion_account
      from public.companion_earnings where id = v_earning;
    select first_name into v_member_name from public.profiles where id = v_row.member_profile_id;
    select first_name into v_companion_name from public.profiles where id = v_row.companion_profile_id;

    select coalesce(sum(duration_seconds), 0) into v_comp
      from public.call_attendance_segments
      where booking_id = v_row.booking_id and side = 'companion';
    select coalesce(sum(duration_seconds), 0) into v_mem
      from public.call_attendance_segments
      where booking_id = v_row.booking_id and side = 'member';

    if v_comp >= 120 and v_mem >= 120 then
      insert into public.conversation_attendance
        (booking_id, outcome, source, explanation)
      values (v_row.booking_id, 'took_place', 'system',
              'Apparent completion from trusted attendance')
      on conflict (booking_id) do nothing;
      perform app_private.make_earning_payable(v_earning);
      perform app_private.notify_account(
        v_companion_account, 'conversation_completed', 'Conversation completed',
        'We confirmed the conversation attendance from the call record.',
        v_row.booking_id, 'fallback-completed:' || v_row.booking_id::text);
      perform app_private.notify_account(
        v_row.booked_by_account_id, 'conversation_completed', 'Conversation completed',
        'The conversation between ' || coalesce(v_member_name, 'the member') || ' and '
          || coalesce(v_companion_name, 'the companion') || ' has been marked as completed.',
        v_row.booking_id, 'fallback-completed:' || v_row.booking_id::text);

    elsif v_comp >= 600 and v_mem < 120 then
      insert into public.conversation_attendance
        (booking_id, outcome, source, explanation)
      values (v_row.booking_id, 'member_no_show', 'system',
              'Likely Member no-show from trusted attendance')
      on conflict (booking_id) do nothing;
      perform app_private.make_earning_payable(v_earning);
      perform app_private.notify_account(
        v_companion_account, 'attendance_confirmed', 'Attendance confirmed',
        'Your attendance was confirmed and your earnings are ready for payout.',
        v_row.booking_id, 'fallback-attendance:' || v_row.booking_id::text);
      perform app_private.notify_account(
        v_row.booked_by_account_id, 'attendance_updated', 'Conversation attendance updated',
        'The conversation attendance was reviewed using the call record.',
        v_row.booking_id, 'fallback-attendance:' || v_row.booking_id::text);

    else
      update public.companion_earnings set state = 'held_for_issue', updated_at = now()
       where id = v_earning and state = 'pending_completion';
      insert into public.conversation_issues
        (booking_id, earning_id, reporter_account_id, reporter_role, category,
         description, idempotency_key)
      select v_row.booking_id, v_earning, e.companion_account_id, 'system', 'unclear_attendance',
             'Attendance evidence unclear — manual review required',
             'unclear-' || v_row.booking_id::text
      from public.companion_earnings e where e.id = v_earning
      on conflict (idempotency_key) do nothing;
      perform app_private.notify_account(
        v_companion_account, 'attendance_under_review', 'Conversation under review',
        'We could not confirm the conversation outcome automatically. It is being reviewed.',
        v_row.booking_id, 'attendance-review:' || v_row.booking_id::text);
      perform app_private.notify_account(
        v_row.booked_by_account_id, 'attendance_under_review', 'Conversation under review',
        'The conversation outcome could not be confirmed automatically and is being reviewed.',
        v_row.booking_id, 'attendance-review:' || v_row.booking_id::text);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.resolve_unconfirmed_attendance() from public, anon, authenticated;
grant execute on function public.resolve_unconfirmed_attendance() to service_role;

select pg_notify('pgrst', 'reload schema');
