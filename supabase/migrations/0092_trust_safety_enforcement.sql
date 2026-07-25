-- ============================================================================
-- 0092 — Block 2 (Trust & Safety): enforcement of consent, blocking and
--        Companion moderation across discovery, booking, conversation start,
--        messaging and call-token eligibility.
-- ============================================================================
-- The models live in 0088 (consent), 0089 (reporting), 0090 (blocking) and
-- 0091 (moderation). This migration wires the gates in ONE place so the
-- interactions are auditable together. All gates fail CLOSED and only ever
-- restrict NEW interactions — no completed booking/call/message/payment/
-- earning/transfer row is read-modified here.
--
-- Enforcement points:
--   1. discoverable_companions view: approved + companion consent + not blocked
--      relative to the viewer.
--   2. bookings BEFORE INSERT: not blocked, companion approved, both parties'
--      current consent.
--   3. conversations BEFORE INSERT: not blocked, companion approved (not
--      rejected/suspended), both parties' current consent (new contact).
--   4. messages BEFORE INSERT (kind='user' only): not blocked.
--   5. call_join_eligibility: not blocked, companion not suspended, both
--      parties' current consent.
--   6. support view of block↔future-booking conflicts (surface, never cancel).
--
-- System messages (kind='system'), the lifecycle notifiers and service-role
-- back-office paths are unaffected: the message gate skips system rows, and the
-- booking/conversation gates concern only the user-facing creation paths.
-- ----------------------------------------------------------------------------

-- ============================================================
-- 1. Discovery view: layer moderation + consent + block-exclusion onto v3.
-- ============================================================
drop view if exists public.discoverable_companions;
create view public.discoverable_companions
with (security_invoker = true) as
select
  p.id,
  p.first_name,
  left(p.last_name, 1) as last_initial,
  p.headline,
  p.bio,
  p.region,
  p.age_band,
  p.languages,
  p.mediums,
  p.style,
  p.avatar_path,
  p.photo_url,
  p.joined_at,
  cp.conversation_style,
  cp.is_accepting_new_members,
  cp.verification_status,
  cp.profile_completion_percentage,
  cp.timezone,
  cp.minimum_notice_hours,
  cp.booking_horizon_days,
  coalesce(
    (select array_agg(i.name order by i.sort_order)
       from public.profile_interests pi
       join public.interests i on i.id = pi.interest_id and i.active
      where pi.profile_id = p.id),
    '{}'
  ) as interest_names,
  (select o.price_minor from public.conversation_offers o
    where o.companion_profile_id = p.id and o.offer_type = 'trial' and o.active
    limit 1) as trial_price_minor,
  (select o.duration_minutes from public.conversation_offers o
    where o.companion_profile_id = p.id and o.offer_type = 'trial' and o.active
    limit 1) as trial_duration_minutes,
  (select min(o.price_minor) from public.conversation_offers o
    where o.companion_profile_id = p.id and o.offer_type = 'single' and o.active
  ) as min_single_price_minor,
  coalesce(
    (select array_agg(distinct o.duration_minutes)
       from public.conversation_offers o
      where o.companion_profile_id = p.id and o.offer_type = 'single' and o.active),
    '{}'
  ) as single_durations,
  coalesce(
    (select array_agg(distinct ar.day_of_week)
       from public.availability_rules ar
      where ar.companion_profile_id = p.id and ar.active),
    '{}'
  ) as available_days,
  coalesce(
    (select array_agg(distinct dp.part)
       from public.availability_rules ar
       cross join lateral (
         select unnest(array_remove(array[
           case when ar.start_local_time < time '12:00' then 'morning' end,
           case when ar.start_local_time < time '17:00' and ar.end_local_time > time '12:00' then 'afternoon' end,
           case when ar.end_local_time > time '17:00' then 'evening' end
         ], null)) as part
       ) dp
      where ar.companion_profile_id = p.id and ar.active),
    '{}'
  ) as available_dayparts
from public.profiles p
left join public.companion_profiles cp on cp.profile_id = p.id
where p.role = 'companion'
  and p.profile_status = 'active'
  and p.visibility = 'public'
  and coalesce(p.avatar_path, p.photo_url) is not null
  and char_length(trim(coalesce(p.bio, ''))) >= 120
  -- 0091: only APPROVED Companions are discoverable.
  and cp.moderation_status = 'approved'
  -- 0088: the Companion must hold current pilot consent.
  and app_private.has_current_consent(p.id, 'companion_pilot')
  -- 0090: hide any Companion in an active block with a member the viewer controls.
  and not exists (
    select 1
    from public.user_blocks ub
    join public.profile_access pa on pa.profile_id = ub.member_profile_id
    where ub.companion_profile_id = p.id
      and ub.removed_at is null
      and pa.account_id = auth.uid()
      and pa.consent_status <> 'withdrawn'
  );

grant select on public.discoverable_companions to authenticated;

-- ============================================================
-- 2. Booking creation gate.
-- ============================================================
create or replace function app_private.enforce_booking_trust()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if app_private.active_block_between(new.member_profile_id, new.companion_profile_id) then
    raise exception 'blocked: this booking cannot be created while a block is in place'
      using errcode = 'check_violation';
  end if;
  if not app_private.companion_is_approved(new.companion_profile_id) then
    raise exception 'companion_not_bookable: this companion is not currently accepting bookings'
      using errcode = 'check_violation';
  end if;
  if not app_private.has_current_consent(new.member_profile_id, 'member_pilot') then
    raise exception 'member_consent_required: the member must accept the current terms first'
      using errcode = 'check_violation';
  end if;
  if not app_private.has_current_consent(new.companion_profile_id, 'companion_pilot') then
    raise exception 'companion_consent_required: the companion must accept the current terms first'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function app_private.enforce_booking_trust() from public, anon, authenticated;
drop trigger if exists bookings_enforce_trust on public.bookings;
create trigger bookings_enforce_trust
  before insert on public.bookings
  for each row execute function app_private.enforce_booking_trust();

-- ============================================================
-- 3. Conversation (new contact) gate.
-- ============================================================
create or replace function app_private.enforce_conversation_trust()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if app_private.active_block_between(new.member_profile_id, new.companion_profile_id) then
    raise exception 'blocked: this conversation cannot be started while a block is in place'
      using errcode = 'check_violation';
  end if;
  if app_private.companion_is_suspended(new.companion_profile_id)
     or not app_private.companion_is_approved(new.companion_profile_id) then
    raise exception 'companion_unavailable: this companion is not currently available'
      using errcode = 'check_violation';
  end if;
  if not app_private.has_current_consent(new.member_profile_id, 'member_pilot')
     or not app_private.has_current_consent(new.companion_profile_id, 'companion_pilot') then
    raise exception 'consent_required: both parties must accept the current terms first'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function app_private.enforce_conversation_trust() from public, anon, authenticated;
drop trigger if exists conversations_enforce_trust on public.conversations;
create trigger conversations_enforce_trust
  before insert on public.conversations
  for each row execute function app_private.enforce_conversation_trust();

-- ============================================================
-- 4. Messaging gate (user messages only; system rows pass through).
-- ============================================================
create or replace function app_private.enforce_message_trust()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_c public.conversations;
begin
  if new.kind is distinct from 'user' then return new; end if;
  select * into v_c from public.conversations where id = new.conversation_id;
  if v_c.id is null then return new; end if;
  if app_private.active_block_between(v_c.member_profile_id, v_c.companion_profile_id) then
    raise exception 'blocked: messages cannot be sent while a block is in place'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function app_private.enforce_message_trust() from public, anon, authenticated;
drop trigger if exists messages_enforce_trust on public.messages;
create trigger messages_enforce_trust
  before insert on public.messages
  for each row execute function app_private.enforce_message_trust();

-- ============================================================
-- 5. Call-token eligibility gate (re-assert the authoritative function with
--    the added block / suspension / consent checks; the rest is unchanged
--    from 0065).
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

  -- 0090/0091/0088: trust gates. A block or suspension prevents unsafe contact
  -- even on an already-scheduled booking; missing current consent blocks join.
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

-- ============================================================
-- 6. Support surface: active blocks that collide with a FUTURE confirmed
--    booking. Surfaced for review; never auto-cancelled or refunded.
-- ============================================================
create or replace function public.support_block_conflicts_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_rows jsonb;
begin
  if not app_private.is_support_admin() then raise exception 'unauthorised: support only'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'block_id', ub.id,
           'member_profile_id', ub.member_profile_id,
           'companion_profile_id', ub.companion_profile_id,
           'direction', ub.direction,
           'booking_id', b.id,
           'starts_at', b.starts_at
         ) order by b.starts_at), '[]'::jsonb)
    into v_rows
  from public.user_blocks ub
  join public.bookings b
    on b.member_profile_id = ub.member_profile_id
   and b.companion_profile_id = ub.companion_profile_id
   and b.status = 'confirmed'
   and b.starts_at > now()
  where ub.removed_at is null;
  return jsonb_build_object('ok', true, 'conflicts', v_rows);
end;
$$;
revoke all on function public.support_block_conflicts_overview() from public, anon;
grant execute on function public.support_block_conflicts_overview() to authenticated;

select pg_notify('pgrst', 'reload schema');
