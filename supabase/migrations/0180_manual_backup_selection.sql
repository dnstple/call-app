-- ===========================================================================
-- 0180_manual_backup_selection.sql
--
-- Manual (admin hand-picked) backup companions — a stepping stone before the
-- fully automatic engine is switched on. Reuses everything from 0177/0178:
-- backup_offers, the companion response link (/cover → respond_backup_offer),
-- the atomic transfer (admin_assign_companion) and the reassignment notices.
-- These three RPCs just let an admin drive it by hand:
--   * admin_upcoming_credit_calls()   — pick a call to manage
--   * admin_candidate_companions()    — pick companions to invite
--   * admin_offer_backup()            — invite ONE chosen companion (SMS + link)
-- Support-admin only. Works whether or not the automatic engine is enabled.
-- ===========================================================================

set search_path = '';

-- Upcoming credit calls the admin can manage (booked = primary pending;
-- companion_confirmed shown too so a confirmed call can still be switched).
create or replace function public.admin_upcoming_credit_calls()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app_private.require_support();
  -- Both credit calls (offer_id null) AND legacy offer/trial/paid bookings, so an
  -- admin can arrange a backup for any upcoming call. Only the AUTOMATIC engine
  -- stays credit-only; manual selection covers everything.
  select coalesce(jsonb_agg(to_jsonb(x) order by x.starts_at), '[]'::jsonb) into v from (
    select b.id as booking_id, b.starts_at, b.duration_minutes, b.status, b.backup_state,
           b.confirmation_deadline_at,
           case when b.offer_id is null then 'Credit' when b.is_trial then 'Trial' else 'Paid' end as kind,
           m.first_name as member_first,
           c.first_name as companion_first, c.last_name as companion_last,
           (b.status in ('confirmed','companion_confirmed') and b.reassigned_at is null) as primary_confirmed,
           (b.reassigned_at is not null) as reassigned,
           (select count(*) from public.backup_offers o where o.booking_id = b.id and o.status in ('offered','available')) as offers_live,
           (select count(*) from public.backup_offers o where o.booking_id = b.id and o.status = 'available') as available_count
    from public.bookings b
    join public.profiles m on m.id = b.member_profile_id
    join public.profiles c on c.id = b.companion_profile_id
    where b.starts_at > now()
      and b.status in ('requested','confirmed','change_proposed','booked','companion_confirmed')
    order by b.starts_at
    limit 100
  ) x;
  return v;
end;
$$;
revoke all on function public.admin_upcoming_credit_calls() from public, anon;
grant execute on function public.admin_upcoming_credit_calls() to authenticated;

-- Approved companions the admin can pick from for a given call, with helpful
-- flags (free at that time / has a textable phone / already invited).
create or replace function public.admin_candidate_companions(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare b record; v jsonb;
begin
  perform app_private.require_support();
  select * into b from public.bookings where id = p_booking;
  if not found then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by (not x.is_free), x.first_name), '[]'::jsonb) into v from (
    select p.id as profile_id, p.first_name, p.last_name,
           app_private.companion_free_at(p.id, b.starts_at, b.ends_at, p_booking) as is_free,
           coalesce(acc.phone_verified, false) and acc.phone_e164 is not null as has_phone,
           exists (select 1 from public.backup_offers o
                   where o.booking_id = p_booking and o.companion_profile_id = p.id
                     and o.status in ('offered','available','selected')) as already_invited
    from public.profiles p
    join public.companion_profiles cp on cp.profile_id = p.id
    left join public.accounts acc on acc.id = app_private.profile_owner_account(p.id)
    where p.role = 'companion' and cp.moderation_status = 'approved'
      and p.id <> b.companion_profile_id
  ) x;
  return v;
end;
$$;
revoke all on function public.admin_candidate_companions(uuid) from public, anon;
grant execute on function public.admin_candidate_companions(uuid) to authenticated;

-- Invite ONE hand-picked companion as a backup. Creates a standby offer (which
-- the transport worker then texts with the secure /cover link). Permissive by
-- design — the admin may invite someone who isn't currently free; the actual
-- transfer (admin_assign_companion) still re-checks availability so a conflict
-- can never produce a double-booking. Idempotent per booking+companion.
create or replace function public.admin_offer_backup(p_booking uuid, p_companion uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b record; v_existing uuid; v_offer uuid; v_account uuid;
begin
  perform app_private.require_support();
  select * into b from public.bookings where id = p_booking for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  -- Credit ('booked') and offer/trial/paid ('requested'/'confirmed'/'change_proposed')
  -- calls can all take a manual backup; terminal states cannot.
  if b.status not in ('booked','requested','confirmed','change_proposed') then
    return jsonb_build_object('ok', false, 'error', b.status);
  end if;
  if b.starts_at <= now() then return jsonb_build_object('ok', false, 'error', 'too_late'); end if;
  if p_companion = b.companion_profile_id then return jsonb_build_object('ok', false, 'error', 'is_primary'); end if;

  select id into v_existing from public.backup_offers
   where booking_id = p_booking and companion_profile_id = p_companion
     and status in ('offered','available','selected') limit 1;
  if v_existing is not null then return jsonb_build_object('ok', true, 'offer_id', v_existing, 'already', true); end if;

  v_account := app_private.profile_owner_account(p_companion);
  insert into public.backup_offers
    (booking_id, companion_profile_id, companion_account_id, status, batch, offered_at, expires_at)
  values (p_booking, p_companion, v_account, 'offered', 'initial', now(), b.starts_at)
  returning id into v_offer;

  update public.bookings set
    backup_state = coalesce(backup_state, 'searching'),
    backup_search_started_at = coalesce(backup_search_started_at, now()),
    updated_at = now()
  where id = p_booking;

  perform app_private.log_failover(p_booking, 'BACKUP_OFFER_SENT',
    jsonb_build_object('companion_profile', p_companion, 'manual', true), auth.uid(), p_companion);
  return jsonb_build_object('ok', true, 'offer_id', v_offer);
end;
$$;
revoke all on function public.admin_offer_backup(uuid, uuid) from public, anon;
grant execute on function public.admin_offer_backup(uuid, uuid) to authenticated;

-- Status-aware transfer (supersedes 0178's admin_assign_companion): works for
-- credit calls AND offer/trial/paid bookings. Sets the correct confirmed status
-- per booking type ('companion_confirmed' for credit, 'confirmed' for offer
-- bookings), re-checks availability so no double-booking, records the transition
-- and notifies everyone. Payout follows the booking's companion at completion
-- (0134/0163), so the backup — not the original — earns.
create or replace function public.admin_assign_companion(p_booking uuid, p_companion uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b record; v_orig uuid; v_orig_account uuid; v_new_status text;
begin
  perform app_private.require_support();
  select * into b from public.bookings where id = p_booking for update;
  if not found then return jsonb_build_object('outcome','not_found'); end if;
  if b.status not in ('booked','companion_confirmed','requested','confirmed','change_proposed') then
    return jsonb_build_object('outcome', b.status);
  end if;
  if b.starts_at <= now() then return jsonb_build_object('outcome','too_late'); end if;
  if not app_private.companion_free_at(p_companion, b.starts_at, b.ends_at, p_booking) then
    return jsonb_build_object('outcome','companion_unavailable');
  end if;

  v_orig := b.companion_profile_id;
  v_orig_account := app_private.profile_owner_account(v_orig);
  v_new_status := case when b.offer_id is null then 'companion_confirmed' else 'confirmed' end;

  update public.bookings set
    original_companion_profile_id = coalesce(original_companion_profile_id, companion_profile_id),
    companion_profile_id = p_companion,
    status = v_new_status,
    companion_confirmed_at = case when b.offer_id is null then now() else companion_confirmed_at end,
    reassigned_at = now(), backup_state = null, updated_at = now()
  where id = p_booking;

  update public.backup_offers
     set status = case when companion_profile_id = p_companion then 'selected' else 'released' end, updated_at = now()
   where booking_id = p_booking and status in ('offered','available');

  if b.status is distinct from v_new_status then
    perform app_private.record_transition(p_booking, b.status, v_new_status, 'reassigned to backup companion (admin)');
  end if;
  perform app_private.log_failover(p_booking, 'ADMIN_OVERRIDE',
          jsonb_build_object('assigned_profile', p_companion, 'from_profile', v_orig), auth.uid(), p_companion);

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

-- Add the companion profile id to each offer in the overview so the admin UI can
-- assign directly from an accepted offer. Mirrors 0178 plus 'companion_profile'.
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
        'companion_profile', o.companion_profile_id,
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

select pg_notify('pgrst', 'reload schema');
