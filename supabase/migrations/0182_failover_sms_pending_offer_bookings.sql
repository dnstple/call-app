-- ===========================================================================
-- 0182_failover_sms_pending_offer_bookings.sql
--
-- Fix: failover_sms_pending() only queued SMS for credit calls (b.status =
-- 'booked'), so manual backup offers on offer/trial/paid bookings (status
-- 'requested'/'confirmed'/'change_proposed') were never texted — the transport
-- reported "Sent 0". Widen the booking-status filter to the same active pre-call
-- set the manual flow supports. Mirrors 0178 otherwise.
-- ===========================================================================

set search_path = '';

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
        and b.status in ('booked','requested','confirmed','change_proposed')
        and b.starts_at > now()
      limit 200), '[]'::jsonb));
$$;
revoke all on function public.failover_sms_pending() from public, anon, authenticated;
grant execute on function public.failover_sms_pending() to service_role;

select pg_notify('pgrst', 'reload schema');
