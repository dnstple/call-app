-- ===========================================================================
-- 0184_admin_message_member.sql
--
-- Let a support admin send a custom message to the member who booked a call,
-- as part of the backup/failover flow (e.g. "we're arranging cover for your
-- call, it'll still go ahead"). Delivers BOTH an in-app notification and a
-- queued SMS (sent by the same call-failover transport worker). Reuses the
-- existing notify_account + queue_failover_sms helpers. Support-admin only.
-- ===========================================================================

set search_path = '';

create or replace function public.admin_message_member(p_booking uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b record; v_member uuid; v_phone text; v_dedupe text; v_msg text;
begin
  perform app_private.require_support();
  v_msg := btrim(coalesce(p_body, ''));
  if v_msg = '' then
    raise exception 'empty_message' using errcode = 'P0001';
  end if;
  v_msg := left(v_msg, 500);

  select * into b from public.bookings where id = p_booking;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  v_member := b.booked_by_account_id;
  if v_member is null then return jsonb_build_object('ok', false, 'error', 'no_member'); end if;

  -- Unique per send so multiple messages are allowed (not deduped away).
  v_dedupe := 'member_custom:' || p_booking::text || ':' || replace(gen_random_uuid()::text, '-', '');

  -- In-app notification (always).
  perform app_private.notify_account(v_member, 'call_message',
    'A message about your call', v_msg, p_booking, v_dedupe);

  -- SMS (queued; the call-failover transport sends it, prefixed for clarity).
  perform app_private.queue_failover_sms(p_booking, v_member, 'member_custom',
    'Apricoti: ' || left(v_msg, 400), v_dedupe);

  perform app_private.log_failover(p_booking, 'ADMIN_MEMBER_MESSAGE',
    jsonb_build_object('length', char_length(v_msg)), auth.uid());

  select phone_e164 into v_phone from public.accounts where id = v_member and phone_verified;
  return jsonb_build_object('ok', true, 'has_phone', v_phone is not null);
end;
$$;
revoke all on function public.admin_message_member(uuid, text) from public, anon;
grant execute on function public.admin_message_member(uuid, text) to authenticated;

select pg_notify('pgrst', 'reload schema');
