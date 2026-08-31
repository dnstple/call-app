-- ===========================================================================
-- 0183_cover_page_offer_bookings.sql
--
-- Fix: the companion cover page treated a call as "open" only when its status
-- was 'booked' (credit calls), so a manual backup offer on an offer/trial/paid
-- booking ('requested'/'confirmed'/'change_proposed') showed "no longer open for
-- cover" and couldn't be accepted. Widen get_backup_offer.is_open and the
-- respond_backup_offer guard to the same active pre-call set the manual flow
-- supports, and make the emergency-claim path set the correct confirmed status
-- per booking type. Mirrors 0178 otherwise.
-- ===========================================================================

set search_path = '';

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
    'call_status', b.status,
    'is_open', (b.status in ('booked','requested','confirmed','change_proposed') and b.starts_at > now()));
end;
$$;
revoke all on function public.get_backup_offer(uuid, uuid) from public;
grant execute on function public.get_backup_offer(uuid, uuid) to anon, authenticated;

create or replace function public.respond_backup_offer(
  p_offer uuid, p_token uuid, p_available boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o record; b record; v_prio integer; v_orig_profile uuid; v_orig_account uuid; v_confirmed_status text;
begin
  select * into o from public.backup_offers where id = p_offer for update;
  if not found then return jsonb_build_object('ok', false, 'state', 'not_found'); end if;
  if not (o.response_token = p_token
          or (auth.uid() is not null and o.companion_account_id = auth.uid())) then
    return jsonb_build_object('ok', false, 'state', 'forbidden');
  end if;

  select * into b from public.bookings where id = o.booking_id for update;
  if b.status not in ('booked','requested','confirmed','change_proposed') or b.starts_at <= now() then
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

  -- p_available = true. Emergency batch (automatic cover_required): claim now.
  if o.batch = 'emergency' and b.backup_state = 'cover_required' then
    if not app_private.companion_free_at(o.companion_profile_id, b.starts_at, b.ends_at, o.booking_id) then
      update public.backup_offers set status = 'expired', updated_at = now() where id = p_offer;
      return jsonb_build_object('ok', false, 'state', 'no_longer_free');
    end if;
    v_orig_profile := b.companion_profile_id;
    v_confirmed_status := case when b.offer_id is null then 'companion_confirmed' else 'confirmed' end;
    update public.bookings set
      original_companion_profile_id = coalesce(original_companion_profile_id, companion_profile_id),
      companion_profile_id = o.companion_profile_id,
      status = v_confirmed_status,
      companion_confirmed_at = case when b.offer_id is null then now() else companion_confirmed_at end,
      reassigned_at = now(), backup_state = null, updated_at = now()
    where id = o.booking_id and status = b.status;
    if not found then return jsonb_build_object('ok', false, 'state', 'already_taken'); end if;
    update public.backup_offers set status = 'selected', priority = 1, responded_at = now(), updated_at = now() where id = p_offer;
    update public.backup_offers set status = 'released', updated_at = now()
      where booking_id = o.booking_id and id <> p_offer and status in ('offered','available');
    v_orig_account := app_private.profile_owner_account(v_orig_profile);
    perform app_private.log_failover(o.booking_id, 'BACKUP_SELECTED',
            jsonb_build_object('offer', p_offer, 'emergency', true), o.companion_account_id, o.companion_profile_id);
    perform app_private.log_failover(o.booking_id, 'PRIMARY_REPLACED',
            jsonb_build_object('original_profile', v_orig_profile), null, v_orig_profile);
    perform app_private.enqueue_reassignment_notices(
      o.booking_id, o.companion_profile_id, o.companion_account_id, v_orig_profile, v_orig_account,
      b.booked_by_account_id, b.starts_at, b.duration_minutes, b.timezone);
    return jsonb_build_object('ok', true, 'state', 'selected');
  end if;

  -- Standby (initial batch, incl. manual invites): record availability only.
  if o.status = 'available' then return jsonb_build_object('ok', true, 'state', 'available'); end if;
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

select pg_notify('pgrst', 'reload schema');
