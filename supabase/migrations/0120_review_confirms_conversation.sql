-- 0120 — The review confirms the conversation (member-authoritative completion).
--
-- For the pilot, the paying side's post-call review IS the confirmation: a
-- Member/Coordinator confirming a finished conversation finalises it, without
-- waiting for a separate Companion confirmation (which left the booking
-- 'confirmed', so the rating — gated on status='completed' by 0007's
-- ratings_source_check — could never save; that's the "isn't confirmed complete
-- yet" error).
--
-- This is ADDITIVE: the two-party submit_completion_confirmation is unchanged
-- and still used elsewhere. confirm_conversation_for_review is a distinct,
-- explicit path the review card calls before writing the review. It records the
-- Member confirmation and runs the SAME finalisation side-effects as a two-party
-- completion (transition audit + package-credit consume). Payout safety is
-- unaffected — attendance-evidence payout holds (0072) still gate any transfer.
-- If the reviewer instead reports a problem, the existing report_concern outcome
-- moves the booking to needs_review (held). Apply after 0119.

set search_path = '';

create or replace function public.confirm_conversation_for_review(p_booking uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.bookings;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required' using errcode = '42501'; end if;
  select * into v from public.bookings where id = p_booking for update;
  -- Only the Member/Coordinator who can act for this booking's Member may confirm.
  if v.id is null or not app_private.can_act_for_member(v.member_profile_id) then
    raise exception 'not_found: conversation' using errcode = '42501';
  end if;
  if v.status = 'completed' then
    return public.get_completion_state(p_booking);            -- idempotent
  end if;
  if v.status = 'needs_review' then
    raise exception 'already_finalised: this conversation is under review' using errcode = 'P0001';
  end if;
  if v.status <> 'confirmed' then
    raise exception 'booking_not_eligible: only confirmed conversations can be completed' using errcode = 'P0001';
  end if;
  if v.ends_at > now() then
    raise exception 'too_early: this conversation has not finished yet' using errcode = 'P0001';
  end if;

  -- Record the Member/Coordinator confirmation (authoritative for the pilot).
  insert into public.completion_confirmations
    (booking_id, participant_side, submitted_by_account_id, participant_profile_id, outcome)
  values (p_booking, 'member', auth.uid(), v.member_profile_id, 'completed')
  on conflict (booking_id, participant_side) do update
    set outcome = 'completed', submitted_by_account_id = excluded.submitted_by_account_id, updated_at = now();

  -- Finalise with the SAME side-effects as a two-party completion.
  update public.bookings set status = 'completed', updated_at = now() where id = p_booking;
  perform app_private.record_transition(p_booking, v.status, 'completed', 'Confirmed by review');
  perform app_private.settle_package_credit(p_booking, 'consume');

  return public.get_completion_state(p_booking);
end;
$$;
revoke all on function public.confirm_conversation_for_review(uuid) from public, anon;
grant execute on function public.confirm_conversation_for_review(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
