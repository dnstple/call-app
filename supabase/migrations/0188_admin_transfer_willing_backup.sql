-- ===========================================================================
-- 0188_admin_transfer_willing_backup.sql
--
-- Make the internal "Transfer call to them" action work for a WILLING backup
-- companion the admin has chosen — the exact logic used to rescue a live call by
-- hand. Previously admin_assign_companion required companion_free_at(), which
-- includes the companion's weekly availability RULES. A backup who agreed to
-- cover often doesn't have that exact slot in their set hours, so the transfer
-- was refused ('companion_unavailable') even though nothing actually blocked it.
--
-- The call-join gate never checks availability rules — only approval, consent,
-- suspension, blocks and no double-booking. So this redefinition enforces
-- exactly those (the things that really stop a call), and drops the
-- availability-rule requirement. Offer/trial calls get 'confirmed', credit calls
-- 'companion_confirmed'. Notifies everyone and records the transition. Support
-- admin only. Supersedes the 0180 definition.
-- ===========================================================================

set search_path = '';

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

  -- The checks that actually gate a call working (NOT the availability rules).
  if not app_private.companion_is_approved(p_companion) then
    return jsonb_build_object('outcome','not_approved');
  end if;
  if not app_private.has_current_consent(p_companion, 'companion_pilot') then
    return jsonb_build_object('outcome','no_consent');   -- they couldn't join
  end if;
  if app_private.companion_is_suspended(p_companion) then
    return jsonb_build_object('outcome','suspended');
  end if;
  if app_private.active_block_between(b.member_profile_id, p_companion) then
    return jsonb_build_object('outcome','blocked_with_member');
  end if;
  -- No double-booking: they must not already have a call overlapping this slot.
  if exists (
    select 1 from public.bookings x
    where x.companion_profile_id = p_companion
      and x.status in ('requested','confirmed','change_proposed','booked','companion_confirmed','admin_fallback')
      and x.starts_at < b.ends_at and x.ends_at > b.starts_at
      and x.id <> p_booking
  ) then
    return jsonb_build_object('outcome','conflict');
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
    perform app_private.record_transition(p_booking, b.status, v_new_status, 'admin transfer to chosen backup');
  end if;
  perform app_private.log_failover(p_booking, 'ADMIN_OVERRIDE',
          jsonb_build_object('assigned_profile', p_companion, 'from_profile', v_orig), auth.uid(), p_companion);

  if v_orig <> p_companion then
    perform app_private.enqueue_reassignment_notices(p_booking, p_companion,
      app_private.profile_owner_account(p_companion), v_orig, v_orig_account,
      b.booked_by_account_id, b.starts_at, b.duration_minutes, b.timezone);
  end if;
  return jsonb_build_object('outcome','assigned','companion', p_companion, 'status', v_new_status);
end;
$$;
revoke all on function public.admin_assign_companion(uuid, uuid) from public, anon;
grant execute on function public.admin_assign_companion(uuid, uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
