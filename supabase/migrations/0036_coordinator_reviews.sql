-- ============================================================
-- 2G4C — Coordinator reviews: public-rating projection, idempotent
-- private message, threshold visibility, safe reader (migration 0036).
--
-- Audit: 0034's submit_conversation_review already enforces authorship,
-- funding, post-end, null|1–5 stars, one-review-per-booking, the 24-hour
-- edit window and the release rule. This migration ADDS (same signature,
-- additive redefinition): projection of the star score into the 0007
-- ratings table (unique member→companion pair ⇒ repeat submissions can
-- never stack, and unique MEMBERS are exactly the rating rows), ONE
-- idempotent private Companion message through the existing trusted
-- send_message path (author = auth.uid() Coordinator ⇒ 0020 attribution
-- "Sarah, Coordinator for Mary" is preserved automatically), a neutral
-- completion system event, and companion approval notification.
-- get_companion_rating_summary now hides the average until THREE unique
-- Members have rated. Historical ratings remain included unchanged.
-- ============================================================

-- Public summary: hidden below three unique rated Members.
create or replace function public.get_companion_rating_summary(p_profile uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_avg numeric;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not (app_private.is_discoverable_companion(p_profile)
          or app_private.has_profile_access(p_profile)) then
    raise exception 'Profile not found';
  end if;
  select count(*), round(avg(r.score)::numeric, 1)
    into v_count, v_avg
  from public.ratings r
  where r.reviewee_profile_id = p_profile;
  return jsonb_build_object(
    'average', case when v_count >= 3 then v_avg else null end,
    'reviewer_count', v_count,
    'visible', v_count >= 3);
end;
$$;

-- Safe Coordinator review-state reader (their own managed bookings only).
create or replace function public.get_review_state(p_booking uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_b public.bookings;
  v_r public.conversation_reviews;
  v_e public.companion_earnings;
begin
  select * into v_b from public.bookings where id = p_booking;
  if v_b.id is null or not exists (
    select 1 from public.profile_access pa
    where pa.profile_id = v_b.member_profile_id and pa.account_id = auth.uid()
      and pa.consent_status <> 'withdrawn'
  ) then
    raise exception 'not_found: conversation';
  end if;
  select * into v_r from public.conversation_reviews
   where booking_id = p_booking and coordinator_account_id = auth.uid();
  select * into v_e from public.companion_earnings where booking_id = p_booking;
  return jsonb_build_object(
    'ended', v_b.ends_at <= now(),
    'eligible', exists (select 1 from public.payment_orders po
                        where po.booking_id = p_booking
                          and po.provider = 'stripe_test' and po.status = 'succeeded'),
    'review_submitted', v_r.id is not null,
    'submitted_at', v_r.created_at,
    'editable_until', v_r.created_at + interval '24 hours',
    'editable', v_r.id is not null and v_r.created_at + interval '24 hours' > now(),
    'rating', v_r.rating,
    'private_feedback', v_r.private_feedback,
    'message_sent', v_r.message_idempotency is not null,
    'issue_exists', exists (select 1 from public.conversation_issues i
                            where i.booking_id = p_booking and i.state <> 'resolved'),
    'attendance_confirmed', exists (select 1 from public.conversation_attendance a
                                    where a.booking_id = p_booking and a.outcome = 'took_place'),
    'earning_state', coalesce(v_e.state, 'pending_completion'));
end;
$$;
revoke all on function public.get_review_state(uuid) from public, anon;
grant execute on function public.get_review_state(uuid) to authenticated;

-- Extended review submission (same signature as 0034; additive redefine).
create or replace function public.submit_conversation_review(
  p_booking uuid, p_rating smallint, p_feedback text, p_message_idempotency text
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_b public.bookings;
  v_earning uuid;
  v_existing public.conversation_reviews;
  v_conv uuid;
  v_msg text;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  select * into v_b from public.bookings where id = p_booking;
  if v_b.id is null or not exists (
    select 1 from public.profile_access pa
    where pa.profile_id = v_b.member_profile_id and pa.account_id = auth.uid()
      and pa.consent_status <> 'withdrawn'
  ) then
    raise exception 'not_found: conversation';
  end if;
  if v_b.ends_at > now() then
    raise exception 'too_early: the conversation has not finished yet';
  end if;
  if p_rating is not null and (p_rating < 1 or p_rating > 5) then
    raise exception 'invalid_rating: stars must be between 1 and 5';
  end if;
  if p_feedback is not null and char_length(p_feedback) > 2000 then
    raise exception 'feedback_too_long: keep feedback under 2000 characters';
  end if;

  v_earning := app_private.ensure_companion_earning(p_booking);
  if v_earning is null then
    raise exception 'not_eligible: this conversation has no real payment to review';
  end if;

  select * into v_existing from public.conversation_reviews
   where booking_id = p_booking for update;
  if v_existing.id is not null then
    if v_existing.coordinator_account_id <> auth.uid() then
      raise exception 'not_found: conversation';
    end if;
    if v_existing.created_at + interval '24 hours' < now() then
      raise exception 'edit_window_closed: reviews can be edited for 24 hours';
    end if;
    -- Edit: same row; created_at untouched; message NEVER resent; money
    -- untouched; the pair rating row updates (or is created if stars were
    -- added to an everything-was-fine approval).
    update public.conversation_reviews
       set rating = p_rating, private_feedback = p_feedback, edited_at = now()
     where id = v_existing.id;
    if p_rating is not null then
      insert into public.ratings
        (reviewer_profile_id, reviewee_profile_id, submitted_by_account_id,
         source_booking_id, score)
      values (v_b.member_profile_id, v_b.companion_profile_id, auth.uid(),
              p_booking, p_rating)
      on conflict (reviewer_profile_id, reviewee_profile_id)
      do update set score = excluded.score, source_booking_id = excluded.source_booking_id,
                    updated_at = now();
    end if;
    return jsonb_build_object('ok', true, 'edited', true);
  end if;

  -- Initial submission. The optional private message goes through the
  -- EXISTING trusted path exactly once (author = this Coordinator, so
  -- 0020 renders "Sarah, Coordinator for Mary"); empty ⇒ no message.
  v_msg := nullif(trim(coalesce(p_message_idempotency, '')), '');

  insert into public.conversation_reviews
    (booking_id, coordinator_account_id, member_profile_id, companion_profile_id,
     rating, private_feedback, approved, message_idempotency)
  values (p_booking, auth.uid(), v_b.member_profile_id, v_b.companion_profile_id,
          p_rating, p_feedback, true,
          case when v_msg is not null then 'review-msg-' || p_booking::text end);

  if v_msg is not null then
    if char_length(v_msg) > 1000 then
      raise exception 'message_too_long: keep messages under 1000 characters';
    end if;
    select c.id into v_conv from public.conversations c
     where c.member_profile_id = v_b.member_profile_id
       and c.companion_profile_id = v_b.companion_profile_id;
    if v_conv is not null then
      perform public.send_message(v_conv, v_msg);
    end if;
  end if;

  -- Public-rating projection: unique member→companion pair means repeat
  -- Members update (one unique Member), never stack.
  if p_rating is not null then
    insert into public.ratings
      (reviewer_profile_id, reviewee_profile_id, submitted_by_account_id,
       source_booking_id, score)
    values (v_b.member_profile_id, v_b.companion_profile_id, auth.uid(),
            p_booking, p_rating)
    on conflict (reviewer_profile_id, reviewee_profile_id)
    do update set score = excluded.score, source_booking_id = excluded.source_booking_id,
                  updated_at = now();
  end if;

  -- Neutral shared system event + companion approval notification.
  begin
    perform app_private.post_system_message(
      c.id, 'conversation_completed', '{}'::jsonb,
      'conversation_completed:' || p_booking::text)
    from public.conversations c
    where c.member_profile_id = v_b.member_profile_id
      and c.companion_profile_id = v_b.companion_profile_id;
  exception when others then null;
  end;
  perform app_private.notify_account(
    (select pa.account_id from public.profile_access pa
      where pa.profile_id = v_b.companion_profile_id and pa.access_role = 'owner'
        and pa.consent_status <> 'withdrawn' limit 1),
    'review_approved', 'Conversation approved',
    'The Coordinator approved the conversation.',
    p_booking, 'review_approved:' || p_booking::text);

  if exists (select 1 from public.conversation_attendance
             where booking_id = p_booking and outcome = 'took_place')
     and not exists (select 1 from public.conversation_issues
                     where booking_id = p_booking and state <> 'resolved') then
    perform app_private.make_earning_payable(v_earning);
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.submit_conversation_review(uuid, smallint, text, text) from public, anon;
grant execute on function public.submit_conversation_review(uuid, smallint, text, text) to authenticated;
