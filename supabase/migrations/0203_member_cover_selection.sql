-- ===========================================================================
-- 0203_member_cover_selection.sql
--
-- Member-choice cover flow. Existing pieces stay: the admin invites backup
-- companions (admin_offer_backup) and they accept via their link (backup_offers
-- status -> 'available'). NEW:
--   * admin_notify_member_of_cover(booking) — a MANUAL admin action that texts +
--     in-app notifies the member: "[orig] is unable to take your call, but A, B
--     and others are available instead. View here."  (link -> /cover/<booking>)
--   * my_cover_options(booking)  — the member's view: the accepted companions,
--     shown ALPHABETICALLY with no ranking exposed, plus the call details.
--   * member_select_cover(booking, offer) — the member picks one; the call
--     transfers to that companion (same effect as an admin transfer).
--   * sweep_cover_auto_assign() — if the member hasn't picked, 5 hours before the
--     start the call auto-assigns to the TOP-ranked accepted companion (invite
--     order = earliest offered_at). Ranking is internal only; never shown.
--
-- The transfer itself reuses the exact 0188 logic via a shared internal function
-- so member-pick, admin transfer and the auto-assign all behave identically.
-- ===========================================================================

set search_path = '';

-- Shared transfer: reassign a booking to a companion (no support gate). Mirrors
-- admin_assign_companion (0188) but callable by the member and the sweep. Returns
-- an outcome code. Side-effect notices are best-effort so a system actor can't
-- fail the transfer on a null auth.uid().
create or replace function app_private.reassign_to_companion(p_booking uuid, p_companion uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b record; v_orig uuid; v_orig_account uuid; v_new_status text;
begin
  select * into b from public.bookings where id = p_booking for update;
  if not found then return jsonb_build_object('outcome','not_found'); end if;
  if b.status not in ('booked','companion_confirmed','requested','confirmed','change_proposed','admin_fallback') then
    return jsonb_build_object('outcome', b.status);
  end if;
  if b.starts_at <= now() then return jsonb_build_object('outcome','too_late'); end if;

  if not app_private.companion_is_approved(p_companion) then return jsonb_build_object('outcome','not_approved'); end if;
  if not app_private.has_current_consent(p_companion, 'companion_pilot') then return jsonb_build_object('outcome','no_consent'); end if;
  if app_private.companion_is_suspended(p_companion) then return jsonb_build_object('outcome','suspended'); end if;
  if app_private.active_block_between(b.member_profile_id, p_companion) then return jsonb_build_object('outcome','blocked_with_member'); end if;
  if exists (
    select 1 from public.bookings x
    where x.companion_profile_id = p_companion
      and x.status in ('requested','confirmed','change_proposed','booked','companion_confirmed','admin_fallback')
      and x.starts_at < b.ends_at and x.ends_at > b.starts_at and x.id <> p_booking
  ) then return jsonb_build_object('outcome','conflict'); end if;

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

  -- Best-effort audit/notices — never block the transfer.
  begin
    if b.status is distinct from v_new_status then
      perform app_private.record_transition(p_booking, b.status, v_new_status, 'member/auto backup selection');
    end if;
  exception when others then null; end;
  begin
    perform app_private.log_failover(p_booking, 'MEMBER_SELECT',
      jsonb_build_object('assigned_profile', p_companion, 'from_profile', v_orig), auth.uid(), p_companion);
  exception when others then null; end;
  begin
    if v_orig is distinct from p_companion then
      perform app_private.enqueue_reassignment_notices(p_booking, p_companion,
        app_private.profile_owner_account(p_companion), v_orig, v_orig_account,
        b.booked_by_account_id, b.starts_at, b.duration_minutes, b.timezone);
    end if;
  exception when others then null; end;

  return jsonb_build_object('outcome','assigned','companion', p_companion, 'status', v_new_status);
end;
$$;
revoke all on function app_private.reassign_to_companion(uuid, uuid) from public, anon, authenticated;
grant execute on function app_private.reassign_to_companion(uuid, uuid) to service_role;

-- ---- Admin: manually notify the member of the accepted cover options ----
create or replace function public.admin_notify_member_of_cover(p_booking uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  b record; v_member_account uuid; v_orig_name text; v_names text[]; v_n int;
  v_link text; v_list text; v_body text; v_stamp text := extract(epoch from now())::bigint::text;
begin
  perform app_private.require_support();
  select * into b from public.bookings where id = p_booking;
  if not found then raise exception 'not_found'; end if;

  select array_agg(p.first_name order by p.first_name)
    into v_names
    from public.backup_offers o
    join public.profiles p on p.id = o.companion_profile_id
   where o.booking_id = p_booking and o.status = 'available';
  v_n := coalesce(array_length(v_names, 1), 0);
  if v_n = 0 then return jsonb_build_object('ok', false, 'reason', 'no_accepted'); end if;

  select first_name into v_orig_name from public.profiles where id = b.companion_profile_id;
  v_member_account := coalesce(app_private.profile_owner_account(b.member_profile_id), b.booked_by_account_id);

  -- "A", "A and B", or "A, B and others"
  if v_n = 1 then v_list := v_names[1] || ' is available instead';
  elsif v_n = 2 then v_list := v_names[1] || ' and ' || v_names[2] || ' are available instead';
  else v_list := v_names[1] || ', ' || v_names[2] || ' and others are available instead';
  end if;

  v_link := 'https://apricoti.co.uk/#/cover/' || p_booking::text;
  v_body := coalesce(v_orig_name, 'Your companion') || ' is unable to take your call, but ' || v_list || '. View here: ' || v_link;

  update public.bookings set backup_state = 'available', updated_at = now() where id = p_booking;

  perform app_private.notify_account(v_member_account, 'cover_options',
    'Choose a replacement companion',
    coalesce(v_orig_name, 'Your companion') || ' can no longer take your call. Tap to pick from the companions available instead.',
    p_booking, 'cover_options:' || p_booking::text || ':' || v_stamp);

  if v_member_account is not null then
    perform app_private.queue_failover_sms(p_booking, v_member_account, 'cover_options', v_body,
      'cover_options:' || p_booking::text || ':' || v_stamp);
  end if;

  return jsonb_build_object('ok', true, 'accepted', v_n);
end;
$$;
revoke all on function public.admin_notify_member_of_cover(uuid) from public, anon;
grant execute on function public.admin_notify_member_of_cover(uuid) to authenticated;

-- ---- Member: view the accepted cover options (alphabetical, no rank) ----
create or replace function public.my_cover_options(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare b record; v_options jsonb;
begin
  if auth.uid() is null then raise exception 'unauthorised'; end if;
  select * into b from public.bookings where id = p_booking;
  if not found then raise exception 'not_found'; end if;
  if not app_private.can_act_for_member(b.member_profile_id) then raise exception 'not_found'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'offer_id', o.id,
           'companion_profile_id', o.companion_profile_id,
           'first_name', p.first_name,
           'last_name', p.last_name,
           'photo_url', p.photo_url,
           'bio', p.bio
         ) order by lower(coalesce(p.first_name, '')), lower(coalesce(p.last_name, ''))), '[]'::jsonb)
    into v_options
    from public.backup_offers o
    join public.profiles p on p.id = o.companion_profile_id
   where o.booking_id = p_booking and o.status = 'available';

  return jsonb_build_object(
    'booking_id', p_booking,
    'starts_at', b.starts_at,
    'ends_at', b.ends_at,
    'timezone', b.timezone,
    'status', b.status,
    'backup_state', b.backup_state,
    'original_companion', (select first_name from public.profiles where id = b.companion_profile_id),
    'options', v_options);
end;
$$;
revoke all on function public.my_cover_options(uuid) from public, anon;
grant execute on function public.my_cover_options(uuid) to authenticated;

-- ---- Member: pick a cover companion (transfers the call) ----
create or replace function public.member_select_cover(p_booking uuid, p_offer uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b record; o record; v_res jsonb;
begin
  if auth.uid() is null then raise exception 'unauthorised'; end if;
  select * into b from public.bookings where id = p_booking;
  if not found then raise exception 'not_found'; end if;
  if not app_private.can_act_for_member(b.member_profile_id) then raise exception 'not_found'; end if;

  select * into o from public.backup_offers where id = p_offer and booking_id = p_booking and status = 'available';
  if not found then return jsonb_build_object('ok', false, 'reason', 'offer_unavailable'); end if;

  v_res := app_private.reassign_to_companion(p_booking, o.companion_profile_id);
  return jsonb_build_object('ok', (v_res->>'outcome') = 'assigned', 'outcome', v_res->>'outcome');
end;
$$;
revoke all on function public.member_select_cover(uuid, uuid) from public, anon;
grant execute on function public.member_select_cover(uuid, uuid) to authenticated;

-- ---- Sweep: auto-assign the top-ranked accepted companion 5h before start ----
create or replace function public.sweep_cover_auto_assign()
returns integer language plpgsql security definer set search_path = '' as $$
declare r record; v_offer record; n integer := 0;
begin
  for r in
    select id, starts_at from public.bookings
     where backup_state = 'available'
       and status in ('booked','companion_confirmed','admin_fallback','confirmed','requested','change_proposed')
       and starts_at > now()
       and starts_at <= now() + interval '5 hours'
  loop
    -- top rank = earliest invited (offered_at) that accepted
    select * into v_offer from public.backup_offers
      where booking_id = r.id and status = 'available'
      order by offered_at asc limit 1;
    if found then
      perform app_private.reassign_to_companion(r.id, v_offer.companion_profile_id);
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;
revoke all on function public.sweep_cover_auto_assign() from public, anon, authenticated;
grant execute on function public.sweep_cover_auto_assign() to service_role;

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — schedule select public.sweep_cover_auto_assign() every 15 minutes yourself.';
    return;
  end if;
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'sweep-cover-auto-assign';
  perform cron.schedule('sweep-cover-auto-assign', '*/15 * * * *',
    $cron$select public.sweep_cover_auto_assign();$cron$);
exception when others then
  raise notice 'sweep-cover-auto-assign scheduling skipped (%).', sqlerrm;
end $$;

select pg_notify('pgrst', 'reload schema');
