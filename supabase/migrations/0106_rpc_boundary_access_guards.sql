-- 0106 — Explicit pilot-access guards at every restricted RPC boundary.
--
-- Corrective migration. The 0105 table triggers gate WRITES to gated tables but
-- do not cover RPCs that update existing rows, read protected data, compute a
-- session, or otherwise do not directly INSERT into a gated table. Here every
-- client-callable RPC for a gated feature is wrapped with an authoritative
-- capability check WITHOUT altering its logic: the original function is renamed
-- to <name>__impl (body verbatim, untouched) and a same-signature wrapper takes
-- its place, calling app_private.require_feature(<feature>) before delegating.
-- The wrapper's SECURITY mode matches the original so RLS/definer semantics are
-- preserved exactly. Waitlisted / blocked / suspended callers are refused with
-- errcode pilot_access_inactive; system/service contexts (null auth.uid()) pass
-- through so already-authorised background processing is unaffected.
--
-- Setup, consent, moderation, blocking, reporting and payout-control RPCs are
-- deliberately NOT gated. Additive only. Apply hosted after 0105.

set search_path = '';

create or replace function app_private.require_feature(p_feature text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  -- System/service context (no end-user session) is already authorised upstream.
  if auth.uid() is null then return; end if;
  if not app_private.account_has_feature(auth.uid(), p_feature) then
    raise exception 'pilot_access_inactive: feature % not available', p_feature
      using errcode = 'P0001', hint = 'pilot_access_inactive';
  end if;
end;
$$;
revoke all on function app_private.require_feature(text) from public, anon, authenticated;

-- accept_booking(p_booking uuid) → feature 'booking'
alter function public.accept_booking(p_booking uuid) rename to accept_booking__impl;
create function public.accept_booking(p_booking uuid) returns public.bookings
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('booking');
  return public.accept_booking__impl(p_booking);
end;
$$;
revoke all on function public.accept_booking(p_booking uuid) from public, anon;
grant execute on function public.accept_booking(p_booking uuid) to authenticated, service_role;
revoke all on function public.accept_booking__impl(p_booking uuid) from public, anon, authenticated, service_role;

-- accept_booking_time_proposal(p_proposal uuid) → feature 'booking'
alter function public.accept_booking_time_proposal(p_proposal uuid) rename to accept_booking_time_proposal__impl;
create function public.accept_booking_time_proposal(p_proposal uuid) returns public.bookings
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('booking');
  return public.accept_booking_time_proposal__impl(p_proposal);
end;
$$;
revoke all on function public.accept_booking_time_proposal(p_proposal uuid) from public, anon;
grant execute on function public.accept_booking_time_proposal(p_proposal uuid) to authenticated, service_role;
revoke all on function public.accept_booking_time_proposal__impl(p_proposal uuid) from public, anon, authenticated, service_role;

-- accept_plan(p_plan uuid, p_message text) → feature 'conversations'
alter function public.accept_plan(p_plan uuid, p_message text) rename to accept_plan__impl;
create function public.accept_plan(p_plan uuid, p_message text DEFAULT NULL::text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('conversations');
  return public.accept_plan__impl(p_plan, p_message);
end;
$$;
revoke all on function public.accept_plan(p_plan uuid, p_message text) from public, anon;
grant execute on function public.accept_plan(p_plan uuid, p_message text) to authenticated, service_role;
revoke all on function public.accept_plan__impl(p_plan uuid, p_message text) from public, anon, authenticated, service_role;

-- accept_plan_change(p_plan uuid, p_message text) → feature 'conversations'
alter function public.accept_plan_change(p_plan uuid, p_message text) rename to accept_plan_change__impl;
create function public.accept_plan_change(p_plan uuid, p_message text DEFAULT NULL::text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('conversations');
  return public.accept_plan_change__impl(p_plan, p_message);
end;
$$;
revoke all on function public.accept_plan_change(p_plan uuid, p_message text) from public, anon;
grant execute on function public.accept_plan_change(p_plan uuid, p_message text) to authenticated, service_role;
revoke all on function public.accept_plan_change__impl(p_plan uuid, p_message text) from public, anon, authenticated, service_role;

-- activate_plan_billing(p_plan uuid) → feature 'conversations'
alter function public.activate_plan_billing(p_plan uuid) rename to activate_plan_billing__impl;
create function public.activate_plan_billing(p_plan uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('conversations');
  return public.activate_plan_billing__impl(p_plan);
end;
$$;
revoke all on function public.activate_plan_billing(p_plan uuid) from public, anon;
grant execute on function public.activate_plan_billing(p_plan uuid) to authenticated, service_role;
revoke all on function public.activate_plan_billing__impl(p_plan uuid) from public, anon, authenticated, service_role;

-- call_join_eligibility(p_booking uuid) → feature 'calls'
alter function public.call_join_eligibility(p_booking uuid) rename to call_join_eligibility__impl;
create function public.call_join_eligibility(p_booking uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('calls');
  return public.call_join_eligibility__impl(p_booking);
end;
$$;
revoke all on function public.call_join_eligibility(p_booking uuid) from public, anon;
grant execute on function public.call_join_eligibility(p_booking uuid) to authenticated, service_role;
revoke all on function public.call_join_eligibility__impl(p_booking uuid) from public, anon, authenticated, service_role;

-- call_state_for_booking(p_booking uuid) → feature 'calls'
alter function public.call_state_for_booking(p_booking uuid) rename to call_state_for_booking__impl;
create function public.call_state_for_booking(p_booking uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('calls');
  return public.call_state_for_booking__impl(p_booking);
end;
$$;
revoke all on function public.call_state_for_booking(p_booking uuid) from public, anon;
grant execute on function public.call_state_for_booking(p_booking uuid) to authenticated, service_role;
revoke all on function public.call_state_for_booking__impl(p_booking uuid) from public, anon, authenticated, service_role;

-- cancel_booking(p_booking uuid, p_reason text) → feature 'booking'
alter function public.cancel_booking(p_booking uuid, p_reason text) rename to cancel_booking__impl;
create function public.cancel_booking(p_booking uuid, p_reason text DEFAULT NULL::text) returns public.bookings
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('booking');
  return public.cancel_booking__impl(p_booking, p_reason);
end;
$$;
revoke all on function public.cancel_booking(p_booking uuid, p_reason text) from public, anon;
grant execute on function public.cancel_booking(p_booking uuid, p_reason text) to authenticated, service_role;
revoke all on function public.cancel_booking__impl(p_booking uuid, p_reason text) from public, anon, authenticated, service_role;

-- companion_favouriters() → feature 'favourites'
alter function public.companion_favouriters() rename to companion_favouriters__impl;
create function public.companion_favouriters() returns TABLE(member_profile_id uuid, member_first_name text, member_region text, via_coordinator boolean, favourited_at timestamp with time zone, conversation_status text)
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('favourites');
  return query select * from public.companion_favouriters__impl();
end;
$$;
revoke all on function public.companion_favouriters() from public, anon;
grant execute on function public.companion_favouriters() to authenticated, service_role;
revoke all on function public.companion_favouriters__impl() from public, anon, authenticated, service_role;

-- companion_introduce(p_companion uuid, p_member uuid, p_message text) → feature 'message_requests'
alter function public.companion_introduce(p_companion uuid, p_member uuid, p_message text) rename to companion_introduce__impl;
create function public.companion_introduce(p_companion uuid, p_member uuid, p_message text) returns public.conversations
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('message_requests');
  return public.companion_introduce__impl(p_companion, p_member, p_message);
end;
$$;
revoke all on function public.companion_introduce(p_companion uuid, p_member uuid, p_message text) from public, anon;
grant execute on function public.companion_introduce(p_companion uuid, p_member uuid, p_message text) to authenticated, service_role;
revoke all on function public.companion_introduce__impl(p_companion uuid, p_member uuid, p_message text) from public, anon, authenticated, service_role;

-- create_booking_request(p_member uuid, p_offer uuid, p_starts_at timestamp with time zone, p_method text) → feature 'booking'
alter function public.create_booking_request(p_member uuid, p_offer uuid, p_starts_at timestamp with time zone, p_method text) rename to create_booking_request__impl;
create function public.create_booking_request(p_member uuid, p_offer uuid, p_starts_at timestamp with time zone, p_method text) returns public.bookings
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('booking');
  return public.create_booking_request__impl(p_member, p_offer, p_starts_at, p_method);
end;
$$;
revoke all on function public.create_booking_request(p_member uuid, p_offer uuid, p_starts_at timestamp with time zone, p_method text) from public, anon;
grant execute on function public.create_booking_request(p_member uuid, p_offer uuid, p_starts_at timestamp with time zone, p_method text) to authenticated, service_role;
revoke all on function public.create_booking_request__impl(p_member uuid, p_offer uuid, p_starts_at timestamp with time zone, p_method text) from public, anon, authenticated, service_role;

-- create_conversation_plan(p_member uuid, p_companion uuid, p_frequency integer, p_duration integer, p_method text, p_slots jsonb, p_message text) → feature 'conversations'
alter function public.create_conversation_plan(p_member uuid, p_companion uuid, p_frequency integer, p_duration integer, p_method text, p_slots jsonb, p_message text) rename to create_conversation_plan__impl;
create function public.create_conversation_plan(p_member uuid, p_companion uuid, p_frequency integer, p_duration integer, p_method text, p_slots jsonb, p_message text DEFAULT NULL::text) returns public.conversation_plans
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('conversations');
  return public.create_conversation_plan__impl(p_member, p_companion, p_frequency, p_duration, p_method, p_slots, p_message);
end;
$$;
revoke all on function public.create_conversation_plan(p_member uuid, p_companion uuid, p_frequency integer, p_duration integer, p_method text, p_slots jsonb, p_message text) from public, anon;
grant execute on function public.create_conversation_plan(p_member uuid, p_companion uuid, p_frequency integer, p_duration integer, p_method text, p_slots jsonb, p_message text) to authenticated, service_role;
revoke all on function public.create_conversation_plan__impl(p_member uuid, p_companion uuid, p_frequency integer, p_duration integer, p_method text, p_slots jsonb, p_message text) from public, anon, authenticated, service_role;

-- create_guest_invitation(p_booking uuid) → feature 'calls'
alter function public.create_guest_invitation(p_booking uuid) rename to create_guest_invitation__impl;
create function public.create_guest_invitation(p_booking uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('calls');
  return public.create_guest_invitation__impl(p_booking);
end;
$$;
revoke all on function public.create_guest_invitation(p_booking uuid) from public, anon;
grant execute on function public.create_guest_invitation(p_booking uuid) to authenticated, service_role;
revoke all on function public.create_guest_invitation__impl(p_booking uuid) from public, anon, authenticated, service_role;

-- create_package_booking_request(p_purchase uuid, p_starts_at timestamp with time zone, p_method text) → feature 'booking'
alter function public.create_package_booking_request(p_purchase uuid, p_starts_at timestamp with time zone, p_method text) rename to create_package_booking_request__impl;
create function public.create_package_booking_request(p_purchase uuid, p_starts_at timestamp with time zone, p_method text) returns public.bookings
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('booking');
  return public.create_package_booking_request__impl(p_purchase, p_starts_at, p_method);
end;
$$;
revoke all on function public.create_package_booking_request(p_purchase uuid, p_starts_at timestamp with time zone, p_method text) from public, anon;
grant execute on function public.create_package_booking_request(p_purchase uuid, p_starts_at timestamp with time zone, p_method text) to authenticated, service_role;
revoke all on function public.create_package_booking_request__impl(p_purchase uuid, p_starts_at timestamp with time zone, p_method text) from public, anon, authenticated, service_role;

-- create_paid_request(p_member uuid, p_companion uuid, p_offer uuid, p_starts_at timestamp with time zone, p_idempotency text) → feature 'payments'
alter function public.create_paid_request(p_member uuid, p_companion uuid, p_offer uuid, p_starts_at timestamp with time zone, p_idempotency text) rename to create_paid_request__impl;
create function public.create_paid_request(p_member uuid, p_companion uuid, p_offer uuid, p_starts_at timestamp with time zone, p_idempotency text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('payments');
  return public.create_paid_request__impl(p_member, p_companion, p_offer, p_starts_at, p_idempotency);
end;
$$;
revoke all on function public.create_paid_request(p_member uuid, p_companion uuid, p_offer uuid, p_starts_at timestamp with time zone, p_idempotency text) from public, anon;
grant execute on function public.create_paid_request(p_member uuid, p_companion uuid, p_offer uuid, p_starts_at timestamp with time zone, p_idempotency text) to authenticated, service_role;
revoke all on function public.create_paid_request__impl(p_member uuid, p_companion uuid, p_offer uuid, p_starts_at timestamp with time zone, p_idempotency text) from public, anon, authenticated, service_role;

-- create_simulated_package_purchase(p_member uuid, p_offer uuid) → feature 'booking'
alter function public.create_simulated_package_purchase(p_member uuid, p_offer uuid) rename to create_simulated_package_purchase__impl;
create function public.create_simulated_package_purchase(p_member uuid, p_offer uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('booking');
  return public.create_simulated_package_purchase__impl(p_member, p_offer);
end;
$$;
revoke all on function public.create_simulated_package_purchase(p_member uuid, p_offer uuid) from public, anon;
grant execute on function public.create_simulated_package_purchase(p_member uuid, p_offer uuid) to authenticated, service_role;
revoke all on function public.create_simulated_package_purchase__impl(p_member uuid, p_offer uuid) from public, anon, authenticated, service_role;

-- decline_booking(p_booking uuid, p_reason text) → feature 'booking'
alter function public.decline_booking(p_booking uuid, p_reason text) rename to decline_booking__impl;
create function public.decline_booking(p_booking uuid, p_reason text DEFAULT NULL::text) returns public.bookings
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('booking');
  return public.decline_booking__impl(p_booking, p_reason);
end;
$$;
revoke all on function public.decline_booking(p_booking uuid, p_reason text) from public, anon;
grant execute on function public.decline_booking(p_booking uuid, p_reason text) to authenticated, service_role;
revoke all on function public.decline_booking__impl(p_booking uuid, p_reason text) from public, anon, authenticated, service_role;

-- decline_plan(p_plan uuid, p_reason text) → feature 'conversations'
alter function public.decline_plan(p_plan uuid, p_reason text) rename to decline_plan__impl;
create function public.decline_plan(p_plan uuid, p_reason text DEFAULT NULL::text) returns public.conversation_plans
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('conversations');
  return public.decline_plan__impl(p_plan, p_reason);
end;
$$;
revoke all on function public.decline_plan(p_plan uuid, p_reason text) from public, anon;
grant execute on function public.decline_plan(p_plan uuid, p_reason text) to authenticated, service_role;
revoke all on function public.decline_plan__impl(p_plan uuid, p_reason text) from public, anon, authenticated, service_role;

-- decline_plan_change(p_plan uuid, p_message text) → feature 'conversations'
alter function public.decline_plan_change(p_plan uuid, p_message text) rename to decline_plan_change__impl;
create function public.decline_plan_change(p_plan uuid, p_message text DEFAULT NULL::text) returns public.conversation_plans
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('conversations');
  return public.decline_plan_change__impl(p_plan, p_message);
end;
$$;
revoke all on function public.decline_plan_change(p_plan uuid, p_message text) from public, anon;
grant execute on function public.decline_plan_change(p_plan uuid, p_message text) to authenticated, service_role;
revoke all on function public.decline_plan_change__impl(p_plan uuid, p_message text) from public, anon, authenticated, service_role;

-- end_plan(p_plan uuid, p_reason text) → feature 'conversations'
alter function public.end_plan(p_plan uuid, p_reason text) rename to end_plan__impl;
create function public.end_plan(p_plan uuid, p_reason text DEFAULT NULL::text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('conversations');
  return public.end_plan__impl(p_plan, p_reason);
end;
$$;
revoke all on function public.end_plan(p_plan uuid, p_reason text) from public, anon;
grant execute on function public.end_plan(p_plan uuid, p_reason text) to authenticated, service_role;
revoke all on function public.end_plan__impl(p_plan uuid, p_reason text) from public, anon, authenticated, service_role;

-- extend_plan_bookings(p_plan uuid) → feature 'conversations'
alter function public.extend_plan_bookings(p_plan uuid) rename to extend_plan_bookings__impl;
create function public.extend_plan_bookings(p_plan uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('conversations');
  return public.extend_plan_bookings__impl(p_plan);
end;
$$;
revoke all on function public.extend_plan_bookings(p_plan uuid) from public, anon;
grant execute on function public.extend_plan_bookings(p_plan uuid) to authenticated, service_role;
revoke all on function public.extend_plan_bookings__impl(p_plan uuid) from public, anon, authenticated, service_role;

-- get_available_package_slots(p_purchase uuid, p_from timestamp with time zone, p_to timestamp with time zone) → feature 'booking'
alter function public.get_available_package_slots(p_purchase uuid, p_from timestamp with time zone, p_to timestamp with time zone) rename to get_available_package_slots__impl;
create function public.get_available_package_slots(p_purchase uuid, p_from timestamp with time zone, p_to timestamp with time zone) returns TABLE(slot_start timestamp with time zone, slot_end timestamp with time zone)
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('booking');
  return query select * from public.get_available_package_slots__impl(p_purchase, p_from, p_to);
end;
$$;
revoke all on function public.get_available_package_slots(p_purchase uuid, p_from timestamp with time zone, p_to timestamp with time zone) from public, anon;
grant execute on function public.get_available_package_slots(p_purchase uuid, p_from timestamp with time zone, p_to timestamp with time zone) to authenticated, service_role;
revoke all on function public.get_available_package_slots__impl(p_purchase uuid, p_from timestamp with time zone, p_to timestamp with time zone) from public, anon, authenticated, service_role;

-- get_available_slots(p_companion uuid, p_offer uuid, p_from timestamp with time zone, p_to timestamp with time zone) → feature 'booking'
alter function public.get_available_slots(p_companion uuid, p_offer uuid, p_from timestamp with time zone, p_to timestamp with time zone) rename to get_available_slots__impl;
create function public.get_available_slots(p_companion uuid, p_offer uuid, p_from timestamp with time zone, p_to timestamp with time zone) returns TABLE(slot_start timestamp with time zone, slot_end timestamp with time zone)
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('booking');
  return query select * from public.get_available_slots__impl(p_companion, p_offer, p_from, p_to);
end;
$$;
revoke all on function public.get_available_slots(p_companion uuid, p_offer uuid, p_from timestamp with time zone, p_to timestamp with time zone) from public, anon;
grant execute on function public.get_available_slots(p_companion uuid, p_offer uuid, p_from timestamp with time zone, p_to timestamp with time zone) to authenticated, service_role;
revoke all on function public.get_available_slots__impl(p_companion uuid, p_offer uuid, p_from timestamp with time zone, p_to timestamp with time zone) from public, anon, authenticated, service_role;

-- get_booking_credit_state(p_booking uuid) → feature 'booking'
alter function public.get_booking_credit_state(p_booking uuid) rename to get_booking_credit_state__impl;
create function public.get_booking_credit_state(p_booking uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('booking');
  return public.get_booking_credit_state__impl(p_booking);
end;
$$;
revoke all on function public.get_booking_credit_state(p_booking uuid) from public, anon;
grant execute on function public.get_booking_credit_state(p_booking uuid) to authenticated, service_role;
revoke all on function public.get_booking_credit_state__impl(p_booking uuid) from public, anon, authenticated, service_role;

-- get_companion_public_reviews(p_profile uuid, p_limit integer, p_offset integer) → feature 'reviews'
alter function public.get_companion_public_reviews(p_profile uuid, p_limit integer, p_offset integer) rename to get_companion_public_reviews__impl;
create function public.get_companion_public_reviews(p_profile uuid, p_limit integer DEFAULT 10, p_offset integer DEFAULT 0) returns TABLE(reviewer_first_name text, reviewer_last_initial text, score integer, public_comment text, updated_at timestamp with time zone)
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('reviews');
  return query select * from public.get_companion_public_reviews__impl(p_profile, p_limit, p_offset);
end;
$$;
revoke all on function public.get_companion_public_reviews(p_profile uuid, p_limit integer, p_offset integer) from public, anon;
grant execute on function public.get_companion_public_reviews(p_profile uuid, p_limit integer, p_offset integer) to authenticated, service_role;
revoke all on function public.get_companion_public_reviews__impl(p_profile uuid, p_limit integer, p_offset integer) from public, anon, authenticated, service_role;

-- get_companion_rating_summary(p_profile uuid) → feature 'reviews'
alter function public.get_companion_rating_summary(p_profile uuid) rename to get_companion_rating_summary__impl;
create function public.get_companion_rating_summary(p_profile uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('reviews');
  return public.get_companion_rating_summary__impl(p_profile);
end;
$$;
revoke all on function public.get_companion_rating_summary(p_profile uuid) from public, anon;
grant execute on function public.get_companion_rating_summary(p_profile uuid) to authenticated, service_role;
revoke all on function public.get_companion_rating_summary__impl(p_profile uuid) from public, anon, authenticated, service_role;

-- get_conversation_completion_state(p_booking uuid) → feature 'reviews'
alter function public.get_conversation_completion_state(p_booking uuid) rename to get_conversation_completion_state__impl;
create function public.get_conversation_completion_state(p_booking uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('reviews');
  return public.get_conversation_completion_state__impl(p_booking);
end;
$$;
revoke all on function public.get_conversation_completion_state(p_booking uuid) from public, anon;
grant execute on function public.get_conversation_completion_state(p_booking uuid) to authenticated, service_role;
revoke all on function public.get_conversation_completion_state__impl(p_booking uuid) from public, anon, authenticated, service_role;

-- get_credit_summary() → feature 'payments'
alter function public.get_credit_summary() rename to get_credit_summary__impl;
create function public.get_credit_summary() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('payments');
  return public.get_credit_summary__impl();
end;
$$;
revoke all on function public.get_credit_summary() from public, anon;
grant execute on function public.get_credit_summary() to authenticated, service_role;
revoke all on function public.get_credit_summary__impl() from public, anon, authenticated, service_role;

-- get_guest_invitation_status(p_booking uuid) → feature 'calls'
alter function public.get_guest_invitation_status(p_booking uuid) rename to get_guest_invitation_status__impl;
create function public.get_guest_invitation_status(p_booking uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('calls');
  return public.get_guest_invitation_status__impl(p_booking);
end;
$$;
revoke all on function public.get_guest_invitation_status(p_booking uuid) from public, anon;
grant execute on function public.get_guest_invitation_status(p_booking uuid) to authenticated, service_role;
revoke all on function public.get_guest_invitation_status__impl(p_booking uuid) from public, anon, authenticated, service_role;

-- get_my_companion_earnings_summary() → feature 'payouts'
alter function public.get_my_companion_earnings_summary() rename to get_my_companion_earnings_summary__impl;
create function public.get_my_companion_earnings_summary() returns TABLE(bucket text, earnings_count bigint, net_minor bigint)
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('payouts');
  return query select * from public.get_my_companion_earnings_summary__impl();
end;
$$;
revoke all on function public.get_my_companion_earnings_summary() from public, anon;
grant execute on function public.get_my_companion_earnings_summary() to authenticated, service_role;
revoke all on function public.get_my_companion_earnings_summary__impl() from public, anon, authenticated, service_role;

-- get_or_create_conversation(p_member uuid, p_companion uuid) → feature 'messaging'
alter function public.get_or_create_conversation(p_member uuid, p_companion uuid) rename to get_or_create_conversation__impl;
create function public.get_or_create_conversation(p_member uuid, p_companion uuid) returns public.conversations
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('messaging');
  return public.get_or_create_conversation__impl(p_member, p_companion);
end;
$$;
revoke all on function public.get_or_create_conversation(p_member uuid, p_companion uuid) from public, anon;
grant execute on function public.get_or_create_conversation(p_member uuid, p_companion uuid) to authenticated, service_role;
revoke all on function public.get_or_create_conversation__impl(p_member uuid, p_companion uuid) from public, anon, authenticated, service_role;

-- get_package_balance(p_purchase uuid) → feature 'payments'
alter function public.get_package_balance(p_purchase uuid) rename to get_package_balance__impl;
create function public.get_package_balance(p_purchase uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('payments');
  return public.get_package_balance__impl(p_purchase);
end;
$$;
revoke all on function public.get_package_balance(p_purchase uuid) from public, anon;
grant execute on function public.get_package_balance(p_purchase uuid) to authenticated, service_role;
revoke all on function public.get_package_balance__impl(p_purchase uuid) from public, anon, authenticated, service_role;

-- get_payment_order_status(p_order uuid) → feature 'payments'
alter function public.get_payment_order_status(p_order uuid) rename to get_payment_order_status__impl;
create function public.get_payment_order_status(p_order uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('payments');
  return public.get_payment_order_status__impl(p_order);
end;
$$;
revoke all on function public.get_payment_order_status(p_order uuid) from public, anon;
grant execute on function public.get_payment_order_status(p_order uuid) to authenticated, service_role;
revoke all on function public.get_payment_order_status__impl(p_order uuid) from public, anon, authenticated, service_role;

-- get_reschedule_state(p_booking uuid) → feature 'booking'
alter function public.get_reschedule_state(p_booking uuid) rename to get_reschedule_state__impl;
create function public.get_reschedule_state(p_booking uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('booking');
  return public.get_reschedule_state__impl(p_booking);
end;
$$;
revoke all on function public.get_reschedule_state(p_booking uuid) from public, anon;
grant execute on function public.get_reschedule_state(p_booking uuid) to authenticated, service_role;
revoke all on function public.get_reschedule_state__impl(p_booking uuid) from public, anon, authenticated, service_role;

-- get_review_state(p_booking uuid) → feature 'reviews'
alter function public.get_review_state(p_booking uuid) rename to get_review_state__impl;
create function public.get_review_state(p_booking uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('reviews');
  return public.get_review_state__impl(p_booking);
end;
$$;
revoke all on function public.get_review_state(p_booking uuid) from public, anon;
grant execute on function public.get_review_state(p_booking uuid) to authenticated, service_role;
revoke all on function public.get_review_state__impl(p_booking uuid) from public, anon, authenticated, service_role;

-- get_trial_state(p_member uuid, p_companion uuid) → feature 'booking'
alter function public.get_trial_state(p_member uuid, p_companion uuid) rename to get_trial_state__impl;
create function public.get_trial_state(p_member uuid, p_companion uuid) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('booking');
  return public.get_trial_state__impl(p_member, p_companion);
end;
$$;
revoke all on function public.get_trial_state(p_member uuid, p_companion uuid) from public, anon;
grant execute on function public.get_trial_state(p_member uuid, p_companion uuid) to authenticated, service_role;
revoke all on function public.get_trial_state__impl(p_member uuid, p_companion uuid) from public, anon, authenticated, service_role;

-- list_conversation_messages(p_conversation uuid, p_before_created timestamp with time zone, p_before_id uuid, p_limit integer) → feature 'messaging'
alter function public.list_conversation_messages(p_conversation uuid, p_before_created timestamp with time zone, p_before_id uuid, p_limit integer) rename to list_conversation_messages__impl;
create function public.list_conversation_messages(p_conversation uuid, p_before_created timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 30) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('messaging');
  return public.list_conversation_messages__impl(p_conversation, p_before_created, p_before_id, p_limit);
end;
$$;
revoke all on function public.list_conversation_messages(p_conversation uuid, p_before_created timestamp with time zone, p_before_id uuid, p_limit integer) from public, anon;
grant execute on function public.list_conversation_messages(p_conversation uuid, p_before_created timestamp with time zone, p_before_id uuid, p_limit integer) to authenticated, service_role;
revoke all on function public.list_conversation_messages__impl(p_conversation uuid, p_before_created timestamp with time zone, p_before_id uuid, p_limit integer) from public, anon, authenticated, service_role;

-- list_conversations() → feature 'messaging'
alter function public.list_conversations() rename to list_conversations__impl;
create function public.list_conversations() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('messaging');
  return public.list_conversations__impl();
end;
$$;
revoke all on function public.list_conversations() from public, anon;
grant execute on function public.list_conversations() to authenticated, service_role;
revoke all on function public.list_conversations__impl() from public, anon, authenticated, service_role;

-- list_my_companion_earnings(p_limit integer) → feature 'payouts'
alter function public.list_my_companion_earnings(p_limit integer) rename to list_my_companion_earnings__impl;
create function public.list_my_companion_earnings(p_limit integer DEFAULT 50) returns TABLE(earning_id uuid, bucket text, state text, transfer_state text, booking_starts_at timestamp with time zone, member_first_name text, is_trial boolean, basis_minor integer, commission_rate_pct numeric, commission_minor integer, net_minor integer, currency text, payable_at timestamp with time zone, created_at timestamp with time zone)
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('payouts');
  return query select * from public.list_my_companion_earnings__impl(p_limit);
end;
$$;
revoke all on function public.list_my_companion_earnings(p_limit integer) from public, anon;
grant execute on function public.list_my_companion_earnings(p_limit integer) to authenticated, service_role;
revoke all on function public.list_my_companion_earnings__impl(p_limit integer) from public, anon, authenticated, service_role;

-- mark_conversation_read(p_conversation uuid, p_up_to timestamp with time zone) → feature 'messaging'
alter function public.mark_conversation_read(p_conversation uuid, p_up_to timestamp with time zone) rename to mark_conversation_read__impl;
create function public.mark_conversation_read(p_conversation uuid, p_up_to timestamp with time zone DEFAULT now()) returns public.conversation_read_state
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('messaging');
  return public.mark_conversation_read__impl(p_conversation, p_up_to);
end;
$$;
revoke all on function public.mark_conversation_read(p_conversation uuid, p_up_to timestamp with time zone) from public, anon;
grant execute on function public.mark_conversation_read(p_conversation uuid, p_up_to timestamp with time zone) to authenticated, service_role;
revoke all on function public.mark_conversation_read__impl(p_conversation uuid, p_up_to timestamp with time zone) from public, anon, authenticated, service_role;

-- my_favourite_count() → feature 'favourites'
alter function public.my_favourite_count() rename to my_favourite_count__impl;
create function public.my_favourite_count() returns integer
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('favourites');
  return public.my_favourite_count__impl();
end;
$$;
revoke all on function public.my_favourite_count() from public, anon;
grant execute on function public.my_favourite_count() to authenticated, service_role;
revoke all on function public.my_favourite_count__impl() from public, anon, authenticated, service_role;

-- my_payments_ready(p_companion uuid) → feature 'payments'
alter function public.my_payments_ready(p_companion uuid) rename to my_payments_ready__impl;
create function public.my_payments_ready(p_companion uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('payments');
  return public.my_payments_ready__impl(p_companion);
end;
$$;
revoke all on function public.my_payments_ready(p_companion uuid) from public, anon;
grant execute on function public.my_payments_ready(p_companion uuid) to authenticated, service_role;
revoke all on function public.my_payments_ready__impl(p_companion uuid) from public, anon, authenticated, service_role;

-- pause_plan(p_plan uuid, p_reason text, p_resume_on date) → feature 'conversations'
alter function public.pause_plan(p_plan uuid, p_reason text, p_resume_on date) rename to pause_plan__impl;
create function public.pause_plan(p_plan uuid, p_reason text DEFAULT NULL::text, p_resume_on date DEFAULT NULL::date) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('conversations');
  return public.pause_plan__impl(p_plan, p_reason, p_resume_on);
end;
$$;
revoke all on function public.pause_plan(p_plan uuid, p_reason text, p_resume_on date) from public, anon;
grant execute on function public.pause_plan(p_plan uuid, p_reason text, p_resume_on date) to authenticated, service_role;
revoke all on function public.pause_plan__impl(p_plan uuid, p_reason text, p_resume_on date) from public, anon, authenticated, service_role;

-- preview_plan_billing_period(p_plan uuid, p_period_start date) → feature 'conversations'
alter function public.preview_plan_billing_period(p_plan uuid, p_period_start date) rename to preview_plan_billing_period__impl;
create function public.preview_plan_billing_period(p_plan uuid, p_period_start date) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('conversations');
  return public.preview_plan_billing_period__impl(p_plan, p_period_start);
end;
$$;
revoke all on function public.preview_plan_billing_period(p_plan uuid, p_period_start date) from public, anon;
grant execute on function public.preview_plan_billing_period(p_plan uuid, p_period_start date) to authenticated, service_role;
revoke all on function public.preview_plan_billing_period__impl(p_plan uuid, p_period_start date) from public, anon, authenticated, service_role;

-- preview_plan_schedule(p_member uuid, p_companion uuid, p_duration integer, p_slots jsonb) → feature 'conversations'
alter function public.preview_plan_schedule(p_member uuid, p_companion uuid, p_duration integer, p_slots jsonb) rename to preview_plan_schedule__impl;
create function public.preview_plan_schedule(p_member uuid, p_companion uuid, p_duration integer, p_slots jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('conversations');
  return public.preview_plan_schedule__impl(p_member, p_companion, p_duration, p_slots);
end;
$$;
revoke all on function public.preview_plan_schedule(p_member uuid, p_companion uuid, p_duration integer, p_slots jsonb) from public, anon;
grant execute on function public.preview_plan_schedule(p_member uuid, p_companion uuid, p_duration integer, p_slots jsonb) to authenticated, service_role;
revoke all on function public.preview_plan_schedule__impl(p_member uuid, p_companion uuid, p_duration integer, p_slots jsonb) from public, anon, authenticated, service_role;

-- propose_booking_time(p_booking uuid, p_starts_at timestamp with time zone, p_message text) → feature 'booking'
alter function public.propose_booking_time(p_booking uuid, p_starts_at timestamp with time zone, p_message text) rename to propose_booking_time__impl;
create function public.propose_booking_time(p_booking uuid, p_starts_at timestamp with time zone, p_message text DEFAULT NULL::text) returns public.booking_time_proposals
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('booking');
  return public.propose_booking_time__impl(p_booking, p_starts_at, p_message);
end;
$$;
revoke all on function public.propose_booking_time(p_booking uuid, p_starts_at timestamp with time zone, p_message text) from public, anon;
grant execute on function public.propose_booking_time(p_booking uuid, p_starts_at timestamp with time zone, p_message text) to authenticated, service_role;
revoke all on function public.propose_booking_time__impl(p_booking uuid, p_starts_at timestamp with time zone, p_message text) from public, anon, authenticated, service_role;

-- propose_plan_change(p_plan uuid, p_frequency integer, p_duration integer, p_method text, p_slots jsonb) → feature 'conversations'
alter function public.propose_plan_change(p_plan uuid, p_frequency integer, p_duration integer, p_method text, p_slots jsonb) rename to propose_plan_change__impl;
create function public.propose_plan_change(p_plan uuid, p_frequency integer DEFAULT NULL::integer, p_duration integer DEFAULT NULL::integer, p_method text DEFAULT NULL::text, p_slots jsonb DEFAULT NULL::jsonb) returns public.conversation_plans
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('conversations');
  return public.propose_plan_change__impl(p_plan, p_frequency, p_duration, p_method, p_slots);
end;
$$;
revoke all on function public.propose_plan_change(p_plan uuid, p_frequency integer, p_duration integer, p_method text, p_slots jsonb) from public, anon;
grant execute on function public.propose_plan_change(p_plan uuid, p_frequency integer, p_duration integer, p_method text, p_slots jsonb) to authenticated, service_role;
revoke all on function public.propose_plan_change__impl(p_plan uuid, p_frequency integer, p_duration integer, p_method text, p_slots jsonb) from public, anon, authenticated, service_role;

-- quote_paid_request(p_member uuid, p_companion uuid, p_offer uuid) → feature 'payments'
alter function public.quote_paid_request(p_member uuid, p_companion uuid, p_offer uuid) rename to quote_paid_request__impl;
create function public.quote_paid_request(p_member uuid, p_companion uuid, p_offer uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('payments');
  return public.quote_paid_request__impl(p_member, p_companion, p_offer);
end;
$$;
revoke all on function public.quote_paid_request(p_member uuid, p_companion uuid, p_offer uuid) from public, anon;
grant execute on function public.quote_paid_request(p_member uuid, p_companion uuid, p_offer uuid) to authenticated, service_role;
revoke all on function public.quote_paid_request__impl(p_member uuid, p_companion uuid, p_offer uuid) from public, anon, authenticated, service_role;

-- reject_booking_time_proposal(p_proposal uuid) → feature 'booking'
alter function public.reject_booking_time_proposal(p_proposal uuid) rename to reject_booking_time_proposal__impl;
create function public.reject_booking_time_proposal(p_proposal uuid) returns public.bookings
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('booking');
  return public.reject_booking_time_proposal__impl(p_proposal);
end;
$$;
revoke all on function public.reject_booking_time_proposal(p_proposal uuid) from public, anon;
grant execute on function public.reject_booking_time_proposal(p_proposal uuid) to authenticated, service_role;
revoke all on function public.reject_booking_time_proposal__impl(p_proposal uuid) from public, anon, authenticated, service_role;

-- request_payment_refund(p_source_kind text, p_source_id uuid, p_remedy_minor integer, p_reason text, p_idempotency text) → feature 'payments'
alter function public.request_payment_refund(p_source_kind text, p_source_id uuid, p_remedy_minor integer, p_reason text, p_idempotency text) rename to request_payment_refund__impl;
create function public.request_payment_refund(p_source_kind text, p_source_id uuid, p_remedy_minor integer, p_reason text, p_idempotency text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('payments');
  return public.request_payment_refund__impl(p_source_kind, p_source_id, p_remedy_minor, p_reason, p_idempotency);
end;
$$;
revoke all on function public.request_payment_refund(p_source_kind text, p_source_id uuid, p_remedy_minor integer, p_reason text, p_idempotency text) from public, anon;
grant execute on function public.request_payment_refund(p_source_kind text, p_source_id uuid, p_remedy_minor integer, p_reason text, p_idempotency text) to authenticated, service_role;
revoke all on function public.request_payment_refund__impl(p_source_kind text, p_source_id uuid, p_remedy_minor integer, p_reason text, p_idempotency text) from public, anon, authenticated, service_role;

-- resolve_plan_occurrence(p_plan uuid, p_intended_start timestamp with time zone, p_new_start timestamp with time zone) → feature 'conversations'
alter function public.resolve_plan_occurrence(p_plan uuid, p_intended_start timestamp with time zone, p_new_start timestamp with time zone) rename to resolve_plan_occurrence__impl;
create function public.resolve_plan_occurrence(p_plan uuid, p_intended_start timestamp with time zone, p_new_start timestamp with time zone) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('conversations');
  return public.resolve_plan_occurrence__impl(p_plan, p_intended_start, p_new_start);
end;
$$;
revoke all on function public.resolve_plan_occurrence(p_plan uuid, p_intended_start timestamp with time zone, p_new_start timestamp with time zone) from public, anon;
grant execute on function public.resolve_plan_occurrence(p_plan uuid, p_intended_start timestamp with time zone, p_new_start timestamp with time zone) to authenticated, service_role;
revoke all on function public.resolve_plan_occurrence__impl(p_plan uuid, p_intended_start timestamp with time zone, p_new_start timestamp with time zone) from public, anon, authenticated, service_role;

-- respond_to_introduction(p_conversation uuid, p_accept boolean) → feature 'message_requests'
alter function public.respond_to_introduction(p_conversation uuid, p_accept boolean) rename to respond_to_introduction__impl;
create function public.respond_to_introduction(p_conversation uuid, p_accept boolean) returns public.conversations
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('message_requests');
  return public.respond_to_introduction__impl(p_conversation, p_accept);
end;
$$;
revoke all on function public.respond_to_introduction(p_conversation uuid, p_accept boolean) from public, anon;
grant execute on function public.respond_to_introduction(p_conversation uuid, p_accept boolean) to authenticated, service_role;
revoke all on function public.respond_to_introduction__impl(p_conversation uuid, p_accept boolean) from public, anon, authenticated, service_role;

-- respond_to_message_request(p_conversation uuid, p_accept boolean) → feature 'message_requests'
alter function public.respond_to_message_request(p_conversation uuid, p_accept boolean) rename to respond_to_message_request__impl;
create function public.respond_to_message_request(p_conversation uuid, p_accept boolean) returns public.conversations
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('message_requests');
  return public.respond_to_message_request__impl(p_conversation, p_accept);
end;
$$;
revoke all on function public.respond_to_message_request(p_conversation uuid, p_accept boolean) from public, anon;
grant execute on function public.respond_to_message_request(p_conversation uuid, p_accept boolean) to authenticated, service_role;
revoke all on function public.respond_to_message_request__impl(p_conversation uuid, p_accept boolean) from public, anon, authenticated, service_role;

-- resume_plan(p_plan uuid) → feature 'conversations'
alter function public.resume_plan(p_plan uuid) rename to resume_plan__impl;
create function public.resume_plan(p_plan uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('conversations');
  return public.resume_plan__impl(p_plan);
end;
$$;
revoke all on function public.resume_plan(p_plan uuid) from public, anon;
grant execute on function public.resume_plan(p_plan uuid) to authenticated, service_role;
revoke all on function public.resume_plan__impl(p_plan uuid) from public, anon, authenticated, service_role;

-- revoke_guest_invitation(p_booking uuid) → feature 'calls'
alter function public.revoke_guest_invitation(p_booking uuid) rename to revoke_guest_invitation__impl;
create function public.revoke_guest_invitation(p_booking uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('calls');
  perform public.revoke_guest_invitation__impl(p_booking);
end;
$$;
revoke all on function public.revoke_guest_invitation(p_booking uuid) from public, anon;
grant execute on function public.revoke_guest_invitation(p_booking uuid) to authenticated, service_role;
revoke all on function public.revoke_guest_invitation__impl(p_booking uuid) from public, anon, authenticated, service_role;

-- send_message(p_conversation uuid, p_body text) → feature 'messaging'
alter function public.send_message(p_conversation uuid, p_body text) rename to send_message__impl;
create function public.send_message(p_conversation uuid, p_body text) returns public.messages
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('messaging');
  return public.send_message__impl(p_conversation, p_body);
end;
$$;
revoke all on function public.send_message(p_conversation uuid, p_body text) from public, anon;
grant execute on function public.send_message(p_conversation uuid, p_body text) to authenticated, service_role;
revoke all on function public.send_message__impl(p_conversation uuid, p_body text) from public, anon, authenticated, service_role;

-- send_message_request(p_member uuid, p_companion uuid, p_body text) → feature 'message_requests'
alter function public.send_message_request(p_member uuid, p_companion uuid, p_body text) rename to send_message_request__impl;
create function public.send_message_request(p_member uuid, p_companion uuid, p_body text) returns public.messages
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('message_requests');
  return public.send_message_request__impl(p_member, p_companion, p_body);
end;
$$;
revoke all on function public.send_message_request(p_member uuid, p_companion uuid, p_body text) from public, anon;
grant execute on function public.send_message_request(p_member uuid, p_companion uuid, p_body text) to authenticated, service_role;
revoke all on function public.send_message_request__impl(p_member uuid, p_companion uuid, p_body text) from public, anon, authenticated, service_role;

-- set_booking_member_seat(p_booking uuid, p_seat text) → feature 'calls'
alter function public.set_booking_member_seat(p_booking uuid, p_seat text) rename to set_booking_member_seat__impl;
create function public.set_booking_member_seat(p_booking uuid, p_seat text) returns public.bookings
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('calls');
  return public.set_booking_member_seat__impl(p_booking, p_seat);
end;
$$;
revoke all on function public.set_booking_member_seat(p_booking uuid, p_seat text) from public, anon;
grant execute on function public.set_booking_member_seat(p_booking uuid, p_seat text) to authenticated, service_role;
revoke all on function public.set_booking_member_seat__impl(p_booking uuid, p_seat text) from public, anon, authenticated, service_role;

-- set_messaging_permission(p_profile uuid, p_account uuid, p_allowed boolean) → feature 'message_requests'
alter function public.set_messaging_permission(p_profile uuid, p_account uuid, p_allowed boolean) rename to set_messaging_permission__impl;
create function public.set_messaging_permission(p_profile uuid, p_account uuid, p_allowed boolean) returns public.profile_access
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('message_requests');
  return public.set_messaging_permission__impl(p_profile, p_account, p_allowed);
end;
$$;
revoke all on function public.set_messaging_permission(p_profile uuid, p_account uuid, p_allowed boolean) from public, anon;
grant execute on function public.set_messaging_permission(p_profile uuid, p_account uuid, p_allowed boolean) to authenticated, service_role;
revoke all on function public.set_messaging_permission__impl(p_profile uuid, p_account uuid, p_allowed boolean) from public, anon, authenticated, service_role;

-- skip_plan_occurrence(p_booking uuid) → feature 'conversations'
alter function public.skip_plan_occurrence(p_booking uuid) rename to skip_plan_occurrence__impl;
create function public.skip_plan_occurrence(p_booking uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('conversations');
  return public.skip_plan_occurrence__impl(p_booking);
end;
$$;
revoke all on function public.skip_plan_occurrence(p_booking uuid) from public, anon;
grant execute on function public.skip_plan_occurrence(p_booking uuid) to authenticated, service_role;
revoke all on function public.skip_plan_occurrence__impl(p_booking uuid) from public, anon, authenticated, service_role;

-- skip_plan_week(p_plan uuid, p_week_start date) → feature 'conversations'
alter function public.skip_plan_week(p_plan uuid, p_week_start date) rename to skip_plan_week__impl;
create function public.skip_plan_week(p_plan uuid, p_week_start date) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('conversations');
  return public.skip_plan_week__impl(p_plan, p_week_start);
end;
$$;
revoke all on function public.skip_plan_week(p_plan uuid, p_week_start date) from public, anon;
grant execute on function public.skip_plan_week(p_plan uuid, p_week_start date) to authenticated, service_role;
revoke all on function public.skip_plan_week__impl(p_plan uuid, p_week_start date) from public, anon, authenticated, service_role;

-- submit_companion_attendance(p_booking uuid, p_outcome text, p_explanation text) → feature 'reviews'
alter function public.submit_companion_attendance(p_booking uuid, p_outcome text, p_explanation text) rename to submit_companion_attendance__impl;
create function public.submit_companion_attendance(p_booking uuid, p_outcome text, p_explanation text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('reviews');
  return public.submit_companion_attendance__impl(p_booking, p_outcome, p_explanation);
end;
$$;
revoke all on function public.submit_companion_attendance(p_booking uuid, p_outcome text, p_explanation text) from public, anon;
grant execute on function public.submit_companion_attendance(p_booking uuid, p_outcome text, p_explanation text) to authenticated, service_role;
revoke all on function public.submit_companion_attendance__impl(p_booking uuid, p_outcome text, p_explanation text) from public, anon, authenticated, service_role;

-- submit_completion_confirmation(p_booking uuid, p_outcome text, p_note text) → feature 'reviews'
alter function public.submit_completion_confirmation(p_booking uuid, p_outcome text, p_note text) rename to submit_completion_confirmation__impl;
create function public.submit_completion_confirmation(p_booking uuid, p_outcome text, p_note text DEFAULT NULL::text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('reviews');
  return public.submit_completion_confirmation__impl(p_booking, p_outcome, p_note);
end;
$$;
revoke all on function public.submit_completion_confirmation(p_booking uuid, p_outcome text, p_note text) from public, anon;
grant execute on function public.submit_completion_confirmation(p_booking uuid, p_outcome text, p_note text) to authenticated, service_role;
revoke all on function public.submit_completion_confirmation__impl(p_booking uuid, p_outcome text, p_note text) from public, anon, authenticated, service_role;

-- submit_conversation_review(p_booking uuid, p_rating smallint, p_feedback text, p_message_idempotency text) → feature 'reviews'
alter function public.submit_conversation_review(p_booking uuid, p_rating smallint, p_feedback text, p_message_idempotency text) rename to submit_conversation_review__impl;
create function public.submit_conversation_review(p_booking uuid, p_rating smallint, p_feedback text, p_message_idempotency text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('reviews');
  return public.submit_conversation_review__impl(p_booking, p_rating, p_feedback, p_message_idempotency);
end;
$$;
revoke all on function public.submit_conversation_review(p_booking uuid, p_rating smallint, p_feedback text, p_message_idempotency text) from public, anon;
grant execute on function public.submit_conversation_review(p_booking uuid, p_rating smallint, p_feedback text, p_message_idempotency text) to authenticated, service_role;
revoke all on function public.submit_conversation_review__impl(p_booking uuid, p_rating smallint, p_feedback text, p_message_idempotency text) from public, anon, authenticated, service_role;

-- submit_rating(p_booking uuid, p_score integer, p_public_comment text, p_private_feedback text) → feature 'reviews'
alter function public.submit_rating(p_booking uuid, p_score integer, p_public_comment text, p_private_feedback text) rename to submit_rating__impl;
create function public.submit_rating(p_booking uuid, p_score integer, p_public_comment text DEFAULT NULL::text, p_private_feedback text DEFAULT NULL::text) returns public.ratings
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('reviews');
  return public.submit_rating__impl(p_booking, p_score, p_public_comment, p_private_feedback);
end;
$$;
revoke all on function public.submit_rating(p_booking uuid, p_score integer, p_public_comment text, p_private_feedback text) from public, anon;
grant execute on function public.submit_rating(p_booking uuid, p_score integer, p_public_comment text, p_private_feedback text) to authenticated, service_role;
revoke all on function public.submit_rating__impl(p_booking uuid, p_score integer, p_public_comment text, p_private_feedback text) from public, anon, authenticated, service_role;

-- update_plan_request_message(p_plan uuid, p_message text) → feature 'conversations'
alter function public.update_plan_request_message(p_plan uuid, p_message text) rename to update_plan_request_message__impl;
create function public.update_plan_request_message(p_plan uuid, p_message text) returns public.conversation_plans
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_feature('conversations');
  return public.update_plan_request_message__impl(p_plan, p_message);
end;
$$;
revoke all on function public.update_plan_request_message(p_plan uuid, p_message text) from public, anon;
grant execute on function public.update_plan_request_message(p_plan uuid, p_message text) to authenticated, service_role;
revoke all on function public.update_plan_request_message__impl(p_plan uuid, p_message text) from public, anon, authenticated, service_role;

select pg_notify('pgrst', 'reload schema');