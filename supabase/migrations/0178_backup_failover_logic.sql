-- ===========================================================================
-- 0178_backup_failover_logic.sql
--
-- Automatic backup-companion & call-failover — LOGIC (RPCs, scheduler, backfill,
-- admin actions). Builds on 0177. Everything is a no-op while
-- backup_failover_config.failover_enabled = false, so this is safe to deploy and
-- schedule before you switch it on.
--
-- Source of truth = this database. Twilio (added in the edge function) is only
-- the transport. All reassignment is atomic (row locks + status-guarded
-- conditional updates) and idempotent (safe to run the tick/backfill repeatedly).
-- ===========================================================================

set search_path = '';

-- Active statuses that occupy a companion's calendar (mirrors 0167's guard).
-- Kept in one place so the conflict check never drifts from the booking flow.

-- ---------------------------------------------------------------- helpers ----

-- Is a companion approved, within availability, and free of a conflicting call
-- at [p_starts, p_ends)? Reuses the EXACT existing availability + overlap logic.
create or replace function app_private.companion_free_at(
  p_companion uuid, p_starts timestamptz, p_ends timestamptz, p_exclude_booking uuid default null)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.companion_is_approved(p_companion)
     and app_private.slot_within_availability(p_companion, p_starts, p_ends)
     and not exists (
       select 1 from public.bookings b
       where b.companion_profile_id = p_companion
         and (p_exclude_booking is null or b.id <> p_exclude_booking)
         and b.status in ('requested','confirmed','change_proposed','booked','companion_confirmed','admin_fallback')
         and b.starts_at < p_ends and b.ends_at > p_starts);
$$;

-- Owner account of a profile (for SMS destination / in-app notify).
create or replace function app_private.profile_owner_account(p_profile uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select pa.account_id from public.profile_access pa
  where pa.profile_id = p_profile and pa.access_role = 'owner'
  order by pa.created_at limit 1;
$$;

create or replace function app_private.log_failover(
  p_booking uuid, p_event text, p_detail jsonb default '{}'::jsonb,
  p_actor uuid default null, p_companion uuid default null)
returns void language sql security definer set search_path = '' as $$
  insert into public.backup_failover_events (booking_id, event, actor_account_id, companion_profile_id, detail)
  values (p_booking, p_event, p_actor, p_companion, coalesce(p_detail, '{}'::jsonb));
$$;

create or replace function app_private.failover_config()
returns public.backup_failover_config language sql stable security definer set search_path = '' as $$
  select * from public.backup_failover_config where id = true;
$$;

-- (In-app notices reuse the existing app_private.notify_account(account, type,
--  title, body, booking, dedupe) helper from 0032 — deduped by key.)

-- Queue an SMS in the outbox (idempotent via dedupe_key). Transport = edge fn.
create or replace function app_private.queue_failover_sms(
  p_booking uuid, p_account uuid, p_kind text, p_body text, p_dedupe text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_account is null then return; end if;
  insert into public.failover_sms_outbox (booking_id, recipient_account_id, kind, body, dedupe_key)
  values (p_booking, p_account, p_kind, p_body, p_dedupe)
  on conflict (dedupe_key) do nothing;
end;
$$;

-- Friendly local time like "6:00pm" for SMS copy.
create or replace function app_private.friendly_call_time(p_starts timestamptz, p_tz text)
returns text language sql immutable set search_path = '' as $$
  select trim(to_char(p_starts at time zone coalesce(p_tz,'Europe/London'), 'FMHH12:MIam'));
$$;

-- ------------------------------------------------- release / booking trigger --

create or replace function public.release_backup_offers(p_booking uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.backup_offers set status = 'released', updated_at = now()
   where booking_id = p_booking and status in ('offered','available');
  update public.bookings set backup_state = null, updated_at = now()
   where id = p_booking and backup_state is not null and status <> 'companion_confirmed';
  perform app_private.log_failover(p_booking, 'BACKUP_OFFERS_RELEASED',
          jsonb_build_object('reason', p_reason));
end;
$$;
revoke all on function public.release_backup_offers(uuid, text) from public, anon, authenticated;
grant execute on function public.release_backup_offers(uuid, text) to service_role;

-- When the primary accepts (booked→companion_confirmed WITHOUT a failover) or the
-- call is cancelled, release outstanding offers automatically. This single
-- trigger covers companion_confirm_booking, admin actions and member/admin
-- cancellation without editing each of those RPCs.
create or replace function app_private.on_booking_status_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if NEW.status = 'companion_confirmed' and OLD.status = 'booked'
     and NEW.reassigned_at is null then
    update public.backup_offers set status = 'released', updated_at = now()
     where booking_id = NEW.id and status in ('offered','available');
    NEW.backup_state := null;
    perform app_private.log_failover(NEW.id, 'PRIMARY_ACCEPTED', '{}'::jsonb, auth.uid(), NEW.companion_profile_id);
  elsif NEW.status = 'cancelled' and OLD.status <> 'cancelled' then
    update public.backup_offers set status = 'released', updated_at = now()
     where booking_id = NEW.id and status in ('offered','available');
    NEW.backup_state := null;
    perform app_private.log_failover(NEW.id, 'CANCELLED', '{}'::jsonb, auth.uid(), null);
  end if;
  return NEW;
end;
$$;
drop trigger if exists booking_release_backup_offers on public.bookings;
create trigger booking_release_backup_offers
  before update on public.bookings
  for each row execute function app_private.on_booking_status_change();

-- ------------------------------------------------------ start backup search --

-- Create up to N standby (or emergency) offers for a booking's eligible backups.
-- Idempotent: the partial unique index on live offers prevents duplicates, and
-- we top up only to the configured batch size. Returns number of NEW offers.
create or replace function public.start_backup_search(p_booking uuid, p_emergency boolean default false)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  b record; cfg public.backup_failover_config; v_limit integer; v_have integer; v_made integer := 0; r record;
begin
  cfg := app_private.failover_config();
  select * into b from public.bookings where id = p_booking for update;
  if not found or b.offer_id is not null or b.status <> 'booked' or b.starts_at <= now() then
    return 0;
  end if;

  v_limit := case when p_emergency then cfg.emergency_batch_size else cfg.initial_batch_size end;
  select count(*) into v_have from public.backup_offers
   where booking_id = p_booking and status in ('offered','available','selected');
  v_limit := greatest(0, v_limit - v_have);

  if b.backup_search_started_at is null then
    update public.bookings set backup_search_started_at = now(),
           backup_state = case when p_emergency then 'cover_required' else 'searching' end,
           cover_required_at = case when p_emergency then now() else cover_required_at end,
           updated_at = now()
     where id = p_booking;
    perform app_private.log_failover(p_booking, 'BACKUP_SEARCH_STARTED',
            jsonb_build_object('emergency', p_emergency));
  elsif p_emergency then
    update public.bookings set backup_state = 'cover_required',
           cover_required_at = coalesce(cover_required_at, now()), updated_at = now()
     where id = p_booking;
  end if;

  if v_limit <= 0 then return 0; end if;

  for r in
    select p.id as profile_id, app_private.profile_owner_account(p.id) as account_id
    from public.profiles p
    join public.companion_profiles cp on cp.profile_id = p.id
    where p.role = 'companion'
      and cp.moderation_status = 'approved'
      and p.id <> b.companion_profile_id
      and app_private.companion_free_at(p.id, b.starts_at, b.ends_at, p_booking)
      and not exists (
        select 1 from public.backup_offers o
        where o.booking_id = p_booking and o.companion_profile_id = p.id
          and o.status in ('offered','available','selected'))
    order by cp.explore_rank desc nulls last, random()
    limit v_limit
  loop
    insert into public.backup_offers
      (booking_id, companion_profile_id, companion_account_id, status, batch, offered_at, expires_at)
    values
      (p_booking, r.profile_id, r.account_id, 'offered',
       case when p_emergency then 'emergency' else 'initial' end, now(), b.starts_at)
    on conflict do nothing;
    if found then
      v_made := v_made + 1;
      perform app_private.log_failover(p_booking, 'BACKUP_OFFER_SENT',
              jsonb_build_object('companion_profile', r.profile_id, 'emergency', p_emergency),
              null, r.profile_id);
    end if;
  end loop;

  return v_made;
end;
$$;
revoke all on function public.start_backup_search(uuid, boolean) from public, anon, authenticated;
grant execute on function public.start_backup_search(uuid, boolean) to service_role;

-- ------------------------------------------------------- atomic reassignment --

-- Transfer a call to the best AVAILABLE backup, atomically. Idempotent: a second
-- run sees status <> 'booked' and no-ops. Two workers can't double-assign — the
-- booking row is locked and the flip is conditional on status = 'booked'.
create or replace function public.execute_call_failover(p_booking uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  b record; o record;
  v_new_companion uuid; v_new_account uuid; v_orig_profile uuid; v_orig_account uuid; v_member_account uuid;
begin
  select * into b from public.bookings where id = p_booking for update;
  if not found then return jsonb_build_object('outcome','not_found'); end if;
  if b.offer_id is not null then return jsonb_build_object('outcome','not_credit'); end if;
  if b.status = 'companion_confirmed' then
    perform public.release_backup_offers(p_booking, 'primary_or_backup_confirmed');
    return jsonb_build_object('outcome','already_confirmed');
  end if;
  if b.status <> 'booked' then
    return jsonb_build_object('outcome', b.status);
  end if;
  if b.starts_at <= now() then return jsonb_build_object('outcome','too_late'); end if;

  v_orig_profile := b.companion_profile_id;
  update public.bookings set backup_state = 'reassigning', updated_at = now() where id = p_booking;

  for o in
    select * from public.backup_offers
     where booking_id = p_booking and status = 'available'
     order by priority asc nulls last, responded_at asc
     for update
  loop
    if app_private.companion_free_at(o.companion_profile_id, b.starts_at, b.ends_at, p_booking) then
      v_new_companion := o.companion_profile_id;
      v_new_account   := o.companion_account_id;
      update public.bookings set
        original_companion_profile_id = coalesce(original_companion_profile_id, companion_profile_id),
        companion_profile_id = v_new_companion,
        status = 'companion_confirmed', companion_confirmed_at = now(),
        reassigned_at = now(), backup_state = null, updated_at = now()
      where id = p_booking;
      update public.backup_offers set status = 'selected', updated_at = now() where id = o.id;
      update public.backup_offers set status = 'released', updated_at = now()
        where booking_id = p_booking and id <> o.id and status in ('offered','available');

      v_member_account := b.booked_by_account_id;
      v_orig_account   := app_private.profile_owner_account(v_orig_profile);
      perform app_private.log_failover(p_booking, 'BACKUP_SELECTED',
              jsonb_build_object('companion_profile', v_new_companion), null, v_new_companion);
      perform app_private.log_failover(p_booking, 'PRIMARY_REPLACED',
              jsonb_build_object('original_profile', v_orig_profile), null, v_orig_profile);

      return jsonb_build_object(
        'outcome','reassigned', 'booking_id', p_booking,
        'new_companion_profile', v_new_companion, 'new_companion_account', v_new_account,
        'original_companion_profile', v_orig_profile, 'original_companion_account', v_orig_account,
        'member_account', v_member_account,
        'starts_at', b.starts_at, 'duration_minutes', b.duration_minutes, 'timezone', b.timezone);
    else
      update public.backup_offers set status = 'released', updated_at = now() where id = o.id;
    end if;
  end loop;

  -- No assignable backup → cover required (emergency batch is sent by the tick).
  update public.bookings set backup_state = 'cover_required',
         cover_required_at = coalesce(cover_required_at, now()), updated_at = now()
   where id = p_booking;
  perform app_private.log_failover(p_booking, 'COVER_REQUIRED', '{}'::jsonb);
  return jsonb_build_object('outcome','cover_required', 'booking_id', p_booking,
    'starts_at', b.starts_at, 'duration_minutes', b.duration_minutes, 'timezone', b.timezone);
end;
$$;
revoke all on function public.execute_call_failover(uuid) from public, anon, authenticated;
grant execute on function public.execute_call_failover(uuid) to service_role;

-- ---------------------------------------------------- companion responses ----

-- Standby / emergency response from the SMS link. Auth = matching response_token
-- OR the signed-in owner companion. For an EMERGENCY offer, "available" claims
-- the call immediately (first eligible wins). Idempotent & race-safe.
create or replace function public.respond_backup_offer(
  p_offer uuid, p_token uuid, p_available boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o record; b record; v_prio integer; v_orig_profile uuid; v_orig_account uuid;
begin
  select * into o from public.backup_offers where id = p_offer for update;
  if not found then return jsonb_build_object('ok', false, 'state', 'not_found'); end if;
  if not (o.response_token = p_token
          or (auth.uid() is not null and o.companion_account_id = auth.uid())) then
    return jsonb_build_object('ok', false, 'state', 'forbidden');
  end if;

  select * into b from public.bookings where id = o.booking_id for update;
  if b.status <> 'booked' or b.starts_at <= now() then
    update public.backup_offers set status = 'expired', updated_at = now()
     where id = p_offer and status in ('offered','available');
    return jsonb_build_object('ok', false, 'state', 'expired');
  end if;
  if o.status in ('released','expired','declined') then
    return jsonb_build_object('ok', false, 'state', o.status);
  end if;
  if o.status = 'selected' then return jsonb_build_object('ok', true, 'state', 'selected'); end if;

  if not p_available then
    update public.backup_offers set status = 'declined', responded_at = now(), updated_at = now() where id = p_offer;
    perform app_private.log_failover(o.booking_id, 'BACKUP_DECLINED',
            jsonb_build_object('offer', p_offer), o.companion_account_id, o.companion_profile_id);
    return jsonb_build_object('ok', true, 'state', 'declined');
  end if;

  -- p_available = true
  -- Emergency batch: claim the call immediately if still available & free.
  if o.batch = 'emergency' and b.backup_state = 'cover_required' then
    if not app_private.companion_free_at(o.companion_profile_id, b.starts_at, b.ends_at, o.booking_id) then
      update public.backup_offers set status = 'expired', updated_at = now() where id = p_offer;
      return jsonb_build_object('ok', false, 'state', 'no_longer_free');
    end if;
    v_orig_profile := b.companion_profile_id;
    update public.bookings set
      original_companion_profile_id = coalesce(original_companion_profile_id, companion_profile_id),
      companion_profile_id = o.companion_profile_id,
      status = 'companion_confirmed', companion_confirmed_at = now(),
      reassigned_at = now(), backup_state = null, updated_at = now()
    where id = o.booking_id and status = 'booked';
    if not found then return jsonb_build_object('ok', false, 'state', 'already_taken'); end if;
    update public.backup_offers set status = 'selected', priority = 1, responded_at = now(), updated_at = now() where id = p_offer;
    update public.backup_offers set status = 'released', updated_at = now()
      where booking_id = o.booking_id and id <> p_offer and status in ('offered','available');
    v_orig_account := app_private.profile_owner_account(v_orig_profile);
    perform app_private.log_failover(o.booking_id, 'BACKUP_SELECTED',
            jsonb_build_object('offer', p_offer, 'emergency', true), o.companion_account_id, o.companion_profile_id);
    perform app_private.log_failover(o.booking_id, 'PRIMARY_REPLACED',
            jsonb_build_object('original_profile', v_orig_profile), null, v_orig_profile);
    -- Queue notifications for the reassignment (member + new + original companion).
    perform app_private.enqueue_reassignment_notices(
      o.booking_id, o.companion_profile_id, o.companion_account_id, v_orig_profile, v_orig_account,
      b.booked_by_account_id, b.starts_at, b.duration_minutes, b.timezone);
    return jsonb_build_object('ok', true, 'state', 'selected');
  end if;

  -- Standby (initial batch): record availability, do NOT assign yet.
  if o.status = 'available' then return jsonb_build_object('ok', true, 'state', 'available'); end if; -- idempotent
  select coalesce(max(priority), 0) + 1 into v_prio
    from public.backup_offers where booking_id = o.booking_id and status = 'available';
  update public.backup_offers set status = 'available', priority = v_prio, responded_at = now(), updated_at = now()
   where id = p_offer;
  update public.bookings set backup_state = 'available', updated_at = now()
   where id = o.booking_id and backup_state in ('searching','cover_required');
  perform app_private.log_failover(o.booking_id, 'BACKUP_AVAILABLE',
          jsonb_build_object('offer', p_offer, 'priority', v_prio), o.companion_account_id, o.companion_profile_id);
  return jsonb_build_object('ok', true, 'state', 'available');
end;
$$;
revoke all on function public.respond_backup_offer(uuid, uuid, boolean) from public;
grant execute on function public.respond_backup_offer(uuid, uuid, boolean) to anon, authenticated;

-- Read a single offer for the companion response page (token or owner). Exposes
-- only the minimum (date/time/duration) — NO member details before assignment.
create or replace function public.get_backup_offer(p_offer uuid, p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare o record; b record;
begin
  select * into o from public.backup_offers where id = p_offer;
  if not found then return jsonb_build_object('ok', false, 'state', 'not_found'); end if;
  if not (o.response_token = p_token
          or (auth.uid() is not null and o.companion_account_id = auth.uid())) then
    return jsonb_build_object('ok', false, 'state', 'forbidden');
  end if;
  select * into b from public.bookings where id = o.booking_id;
  return jsonb_build_object('ok', true, 'state', o.status,
    'batch', o.batch, 'booking_id', o.booking_id,
    'starts_at', b.starts_at, 'ends_at', b.ends_at, 'duration_minutes', b.duration_minutes,
    'timezone', b.timezone,
    'call_status', b.status, 'is_open', (b.status = 'booked' and b.starts_at > now()));
end;
$$;
revoke all on function public.get_backup_offer(uuid, uuid) from public;
grant execute on function public.get_backup_offer(uuid, uuid) to anon, authenticated;

-- Queue the three reassignment SMS/in-app notices (idempotent per booking).
create or replace function app_private.enqueue_reassignment_notices(
  p_booking uuid, p_new_profile uuid, p_new_account uuid,
  p_orig_profile uuid, p_orig_account uuid, p_member_account uuid,
  p_starts timestamptz, p_duration integer, p_tz text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_time text; v_new_name text; v_orig_name text;
begin
  v_time := app_private.friendly_call_time(p_starts, p_tz);
  select first_name into v_new_name  from public.profiles where id = p_new_profile;
  select first_name into v_orig_name from public.profiles where id = p_orig_profile;

  -- Member: reassuring — the call is still going ahead.
  perform app_private.notify_account(p_member_account, 'call_companion_changed',
    'Your call is still going ahead',
    format('%s wasn''t able to confirm, so your %s call will now be with %s.',
           coalesce(v_orig_name,'Your companion'), v_time, coalesce(v_new_name,'another companion')),
    p_booking, 'member_reassigned:' || p_booking::text);
  perform app_private.queue_failover_sms(p_booking, p_member_account, 'member_reassigned',
    format('Apricoti: Your call at %s is still going ahead. %s wasn''t able to confirm, so your call will now be with %s. View your call: %s',
           v_time, coalesce(v_orig_name,'Your companion'), coalesce(v_new_name,'another companion'),
           'https://apricoti.co.uk/#/conversations'),
    'member_reassigned:' || p_booking::text);

  -- New companion: confirmed.
  perform app_private.notify_account(p_new_account, 'call_backup_assigned',
    'You''re confirmed for a call',
    format('You''re now confirmed for the %s call you offered to cover.', v_time),
    p_booking, 'backup_assigned:' || p_booking::text);
  perform app_private.queue_failover_sms(p_booking, p_new_account, 'backup_assigned',
    format('Apricoti: You''re now confirmed for the %s call you offered to cover. View call: %s',
           v_time, 'https://apricoti.co.uk/#/conversations'),
    'backup_assigned:' || p_booking::text);

  -- Original companion: no longer theirs.
  perform app_private.notify_account(p_orig_account, 'call_reassigned_away',
    'A call was reassigned',
    format('As your %s call was not confirmed by the deadline, another companion has now been assigned.', v_time),
    p_booking, 'primary_replaced:' || p_booking::text);
  perform app_private.queue_failover_sms(p_booking, p_orig_account, 'primary_replaced',
    format('Apricoti: As your %s call was not confirmed by the deadline, another companion has now been assigned.', v_time),
    'primary_replaced:' || p_booking::text);
end;
$$;

-- --------------------------------------------------------------- the tick ----

-- Server-side sweep run by pg_cron (below). Safe to run every minute and
-- repeatedly (idempotent). Does ALL state transitions; queues notices/SMS to the
-- outbox for the transport worker. No-op unless failover_enabled = true.
create or replace function public.process_failover_tick()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cfg public.backup_failover_config; b record; res jsonb;
  v_searches integer := 0; v_failovers integer := 0; v_cover integer := 0;
begin
  cfg := app_private.failover_config();
  if not cfg.failover_enabled then
    return jsonb_build_object('enabled', false);
  end if;

  -- 1. Start standby search at ~T-4h (or immediately for existing/short-notice).
  for b in
    select id from public.bookings
    where offer_id is null and status = 'booked'
      and starts_at > now()
      and starts_at <= now() + make_interval(mins => cfg.backup_search_start_mins)
      and starts_at >  now() + make_interval(mins => cfg.primary_acceptance_deadline_mins)
      and backup_search_started_at is null
    order by starts_at
    limit 200
  loop
    perform public.start_backup_search(b.id, false);
    v_searches := v_searches + 1;
  end loop;

  -- 2. Failover at ~T-2h for calls the primary still hasn't confirmed.
  for b in
    select id from public.bookings
    where offer_id is null and status = 'booked'
      and starts_at > now()
      and starts_at <= now() + make_interval(mins => cfg.primary_acceptance_deadline_mins)
      and coalesce(backup_state, '') <> 'cover_required'
    order by starts_at
    limit 200
  loop
    -- If T-4h search never ran (short-notice booking created inside the window),
    -- execute goes straight to cover_required, which step 3 turns into an urgent
    -- emergency batch — no wasted standby batch.
    res := public.execute_call_failover(b.id);
    if res->>'outcome' = 'reassigned' then
      v_failovers := v_failovers + 1;
      perform app_private.enqueue_reassignment_notices(
        (res->>'booking_id')::uuid,
        (res->>'new_companion_profile')::uuid, (res->>'new_companion_account')::uuid,
        (res->>'original_companion_profile')::uuid, (res->>'original_companion_account')::uuid,
        (res->>'member_account')::uuid, (res->>'starts_at')::timestamptz,
        (res->>'duration_minutes')::integer, res->>'timezone');
    elsif res->>'outcome' = 'cover_required' then
      v_cover := v_cover + 1;
    end if;
  end loop;

  -- 3. Emergency batch for cover_required calls with no live offers left.
  for b in
    select id from public.bookings
    where offer_id is null and status = 'booked'
      and starts_at > now() and backup_state = 'cover_required'
      and not exists (select 1 from public.backup_offers o
                      where o.booking_id = bookings.id and o.status in ('offered','available'))
    order by starts_at
    limit 200
  loop
    perform public.start_backup_search(b.id, true);
    -- Surface prominently to admins.
    perform app_private.notify_admins_cover_required(b.id);
  end loop;

  return jsonb_build_object('enabled', true, 'searches_started', v_searches,
    'failovers', v_failovers, 'cover_required', v_cover);
end;
$$;
revoke all on function public.process_failover_tick() from public, anon, authenticated;
grant execute on function public.process_failover_tick() to service_role;

-- Notify all support admins that a call needs cover (idempotent per booking/day).
create or replace function app_private.notify_admins_cover_required(p_booking uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare a record; v_day text := to_char(now(), 'YYYY-MM-DD');
begin
  for a in select account_id from public.support_admins loop
    perform app_private.notify_account(a.account_id, 'admin_cover_required',
      'A call needs cover',
      'A booked call was not confirmed and no backup companion is available yet. Open the internal calls to assign cover.',
      p_booking, 'admin_cover_required:' || p_booking::text || ':' || v_day);
  end loop;
end;
$$;

-- ---------------------------------------------------- backfill (existing calls)

-- One-shot, idempotent bootstrap for calls that already existed before deploy —
-- including TODAY's. It simply runs the same tick logic (which is window-aware),
-- so a call >4h away waits for its T-4h, a 2–4h call starts search now, and a
-- <2h call immediately fails over / enters urgent cover. Safe to run repeatedly.
create or replace function public.backfill_backup_failover()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not app_private.is_support_admin()
     and current_setting('request.jwt.role', true) is distinct from 'service_role' then
    raise exception 'support_or_service_only' using errcode = '42501';
  end if;
  return public.process_failover_tick();
end;
$$;
revoke all on function public.backfill_backup_failover() from public, anon;
grant execute on function public.backfill_backup_failover() to authenticated, service_role;

-- ------------------------------------------------- transport (edge) helpers --

-- Outbox rows + offers that still need an SMS sent. Service role (edge fn).
create or replace function public.failover_sms_pending()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'sms_enabled', (select sms_enabled from public.backup_failover_config where id = true),
    'app_url', 'https://apricoti.co.uk',
    'notices', coalesce((select jsonb_agg(jsonb_build_object(
        'id', x.id, 'kind', x.kind, 'body', x.body,
        'phone', acc.phone_e164, 'phone_verified', acc.phone_verified))
      from public.failover_sms_outbox x
      join public.accounts acc on acc.id = x.recipient_account_id
      where x.status = 'pending'
      limit 200), '[]'::jsonb),
    'offers', coalesce((select jsonb_agg(jsonb_build_object(
        'offer_id', o.id, 'token', o.response_token, 'batch', o.batch,
        'phone', acc.phone_e164, 'phone_verified', acc.phone_verified,
        'first_name', p.first_name,
        'starts_at', b.starts_at, 'duration_minutes', b.duration_minutes, 'timezone', b.timezone))
      from public.backup_offers o
      join public.bookings b on b.id = o.booking_id
      join public.profiles p on p.id = o.companion_profile_id
      left join public.accounts acc on acc.id = o.companion_account_id
      where o.status = 'offered' and o.twilio_message_sid is null
        and b.status = 'booked' and b.starts_at > now()
      limit 200), '[]'::jsonb));
$$;
revoke all on function public.failover_sms_pending() from public, anon, authenticated;
grant execute on function public.failover_sms_pending() to service_role;

create or replace function public.record_offer_sms(p_offer uuid, p_sid text, p_status text)
returns void language sql security definer set search_path = '' as $$
  update public.backup_offers set twilio_message_sid = p_sid, twilio_status = p_status, updated_at = now()
  where id = p_offer;
$$;
revoke all on function public.record_offer_sms(uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_offer_sms(uuid, text, text) to service_role;

create or replace function public.record_outbox_sms(p_id bigint, p_sid text, p_status text, p_ok boolean)
returns void language sql security definer set search_path = '' as $$
  update public.failover_sms_outbox
    set twilio_message_sid = p_sid, twilio_status = p_status,
        status = case when p_ok then 'sent' else 'failed' end, sent_at = now()
  where id = p_id;
$$;
revoke all on function public.record_outbox_sms(bigint, text, text, boolean) from public, anon, authenticated;
grant execute on function public.record_outbox_sms(bigint, text, text, boolean) to service_role;

-- Twilio delivery status callback → update whichever row carries the SID.
create or replace function public.record_twilio_status(p_sid text, p_status text)
returns void language sql security definer set search_path = '' as $$
  update public.backup_offers set twilio_status = p_status, updated_at = now() where twilio_message_sid = p_sid;
  update public.failover_sms_outbox set twilio_status = p_status where twilio_message_sid = p_sid;
$$;
revoke all on function public.record_twilio_status(text, text) from public, anon, authenticated;
grant execute on function public.record_twilio_status(text, text) to service_role;

-- ----------------------------------------------------------- config admin ----

create or replace function public.admin_get_failover_config()
returns public.backup_failover_config language plpgsql stable security definer set search_path = '' as $$
declare c public.backup_failover_config;
begin
  perform app_private.require_support();
  select * into c from public.backup_failover_config where id = true;
  return c;
end;
$$;
revoke all on function public.admin_get_failover_config() from public, anon;
grant execute on function public.admin_get_failover_config() to authenticated;

create or replace function public.admin_set_failover_config(
  p_failover_enabled boolean default null, p_sms_enabled boolean default null,
  p_primary_deadline_mins integer default null, p_search_start_mins integer default null,
  p_initial_batch integer default null, p_emergency_batch integer default null)
returns public.backup_failover_config language plpgsql security definer set search_path = '' as $$
declare c public.backup_failover_config;
begin
  perform app_private.require_support();
  update public.backup_failover_config set
    failover_enabled = coalesce(p_failover_enabled, failover_enabled),
    sms_enabled      = coalesce(p_sms_enabled, sms_enabled),
    primary_acceptance_deadline_mins = coalesce(p_primary_deadline_mins, primary_acceptance_deadline_mins),
    backup_search_start_mins = coalesce(p_search_start_mins, backup_search_start_mins),
    initial_batch_size = coalesce(p_initial_batch, initial_batch_size),
    emergency_batch_size = coalesce(p_emergency_batch, emergency_batch_size),
    updated_at = now()
  where id = true returning * into c;
  return c;
end;
$$;
revoke all on function public.admin_set_failover_config(boolean, boolean, integer, integer, integer, integer) from public, anon;
grant execute on function public.admin_set_failover_config(boolean, boolean, integer, integer, integer, integer) to authenticated;

-- ----------------------------------------------------------- admin actions ---

create or replace function public.admin_failover_overview(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app_private.require_support();
  select jsonb_build_object(
    'booking_id', b.id, 'status', b.status, 'backup_state', b.backup_state,
    'starts_at', b.starts_at, 'duration_minutes', b.duration_minutes,
    'confirmation_deadline_at', b.confirmation_deadline_at,
    'backup_search_started_at', b.backup_search_started_at, 'cover_required_at', b.cover_required_at,
    'reassigned_at', b.reassigned_at,
    'primary_companion', (select jsonb_build_object('profile_id', p.id, 'first_name', p.first_name, 'last_name', p.last_name)
                          from public.profiles p where p.id = coalesce(b.original_companion_profile_id, b.companion_profile_id)),
    'current_companion', (select jsonb_build_object('profile_id', p.id, 'first_name', p.first_name, 'last_name', p.last_name)
                          from public.profiles p where p.id = b.companion_profile_id),
    'primary_accepted', (b.status = 'companion_confirmed' and b.reassigned_at is null),
    'offers', coalesce((select jsonb_agg(jsonb_build_object(
        'id', o.id, 'status', o.status, 'batch', o.batch, 'priority', o.priority,
        'companion', (select jsonb_build_object('first_name', pp.first_name, 'last_name', pp.last_name)
                      from public.profiles pp where pp.id = o.companion_profile_id),
        'offered_at', o.offered_at, 'responded_at', o.responded_at,
        'twilio_status', o.twilio_status) order by o.priority nulls last, o.offered_at)
      from public.backup_offers o where o.booking_id = b.id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('event', e.event, 'detail', e.detail, 'created_at', e.created_at)
      order by e.created_at desc) from public.backup_failover_events e where e.booking_id = b.id), '[]'::jsonb)
  ) into v from public.bookings b where b.id = p_booking;
  return v;
end;
$$;
revoke all on function public.admin_failover_overview(uuid) from public, anon;
grant execute on function public.admin_failover_overview(uuid) to authenticated;

-- Calls currently in a backup/cover state (for the admin console list).
create or replace function public.admin_failover_active()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app_private.require_support();
  select coalesce(jsonb_agg(to_jsonb(x) order by x.starts_at), '[]'::jsonb) into v from (
    select b.id as booking_id, b.starts_at, b.duration_minutes, b.backup_state, b.status,
           m.first_name as member_first,
           c.first_name as companion_first, c.last_name as companion_last,
           (select count(*) from public.backup_offers o where o.booking_id = b.id and o.status = 'offered')   as offers_out,
           (select count(*) from public.backup_offers o where o.booking_id = b.id and o.status = 'available') as available_count
    from public.bookings b
    join public.profiles m on m.id = b.member_profile_id
    join public.profiles c on c.id = b.companion_profile_id
    where b.offer_id is null and b.status = 'booked' and b.starts_at > now()
      and b.backup_state is not null
  ) x;
  return v;
end;
$$;
revoke all on function public.admin_failover_active() from public, anon;
grant execute on function public.admin_failover_active() to authenticated;

-- Admin: assign a specific companion now (atomic; used for "assign backup" and
-- "switch companion now"). Bypasses the standby vote but keeps every safety check.
create or replace function public.admin_assign_companion(p_booking uuid, p_companion uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b record; v_orig uuid; v_orig_account uuid;
begin
  perform app_private.require_support();
  select * into b from public.bookings where id = p_booking for update;
  if not found or b.offer_id is not null then return jsonb_build_object('outcome','not_credit'); end if;
  if b.status not in ('booked','companion_confirmed') then return jsonb_build_object('outcome', b.status); end if;
  if b.starts_at <= now() then return jsonb_build_object('outcome','too_late'); end if;
  if not app_private.companion_free_at(p_companion, b.starts_at, b.ends_at, p_booking) then
    return jsonb_build_object('outcome','companion_unavailable');
  end if;
  v_orig := b.companion_profile_id;
  v_orig_account := app_private.profile_owner_account(v_orig);
  update public.bookings set
    original_companion_profile_id = coalesce(original_companion_profile_id, companion_profile_id),
    companion_profile_id = p_companion, status = 'companion_confirmed',
    companion_confirmed_at = now(), reassigned_at = now(), backup_state = null, updated_at = now()
  where id = p_booking;
  update public.backup_offers set status = case when companion_profile_id = p_companion then 'selected' else 'released' end,
         updated_at = now()
   where booking_id = p_booking and status in ('offered','available');
  perform app_private.log_failover(p_booking, 'ADMIN_OVERRIDE',
          jsonb_build_object('assigned_profile', p_companion), auth.uid(), p_companion);
  if v_orig <> p_companion then
    perform app_private.enqueue_reassignment_notices(p_booking, p_companion,
      app_private.profile_owner_account(p_companion), v_orig, v_orig_account,
      b.booked_by_account_id, b.starts_at, b.duration_minutes, b.timezone);
  end if;
  return jsonb_build_object('outcome','assigned','companion', p_companion);
end;
$$;
revoke all on function public.admin_assign_companion(uuid, uuid) from public, anon;
grant execute on function public.admin_assign_companion(uuid, uuid) to authenticated;

-- Admin: keep the original companion (cancel backup search, release offers).
create or replace function public.admin_keep_primary(p_booking uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_support();
  perform public.release_backup_offers(p_booking, 'admin_keep_primary');
  perform app_private.log_failover(p_booking, 'ADMIN_OVERRIDE', jsonb_build_object('action','keep_primary'), auth.uid());
end;
$$;
revoke all on function public.admin_keep_primary(uuid) from public, anon;
grant execute on function public.admin_keep_primary(uuid) to authenticated;

-- Admin: start the backup search now, or force the failover now.
create or replace function public.admin_start_backup_search(p_booking uuid, p_emergency boolean default false)
returns integer language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_support();
  return public.start_backup_search(p_booking, p_emergency);
end;
$$;
revoke all on function public.admin_start_backup_search(uuid, boolean) from public, anon;
grant execute on function public.admin_start_backup_search(uuid, boolean) to authenticated;

create or replace function public.admin_switch_now(p_booking uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare res jsonb;
begin
  perform app_private.require_support();
  res := public.execute_call_failover(p_booking);
  if res->>'outcome' = 'reassigned' then
    perform app_private.enqueue_reassignment_notices(
      (res->>'booking_id')::uuid,
      (res->>'new_companion_profile')::uuid, (res->>'new_companion_account')::uuid,
      (res->>'original_companion_profile')::uuid, (res->>'original_companion_account')::uuid,
      (res->>'member_account')::uuid, (res->>'starts_at')::timestamptz,
      (res->>'duration_minutes')::integer, res->>'timezone');
  end if;
  return res;
end;
$$;
revoke all on function public.admin_switch_now(uuid) from public, anon;
grant execute on function public.admin_switch_now(uuid) to authenticated;

-- ------------------------------------------------------------- pg_cron -------
-- Server-side scheduling (no browser needed). The tick is a no-op while
-- failover_enabled = false, so scheduling it now is safe. Guarded + idempotent;
-- environments without pg_cron (local/CI) simply skip and can invoke it manually.
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — schedule select public.process_failover_tick() every minute yourself.';
    return;
  end if;
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'process-failover-tick';
  perform cron.schedule('process-failover-tick', '* * * * *',
    $cron$select public.process_failover_tick();$cron$);
  raise notice 'Scheduled process-failover-tick every minute.';
exception when others then
  raise notice 'process-failover-tick scheduling skipped (%).', sqlerrm;
end $$;

select pg_notify('pgrst', 'reload schema');
