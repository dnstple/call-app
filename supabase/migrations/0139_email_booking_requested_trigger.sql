-- 0139 — Fire the "new booking request → notify Companion" email server-side.
--
-- Bookings are created server-side (on payment success / credit), not by a
-- frontend call that knows the booking id, so the correct trigger point is the
-- booking row itself. On INSERT of a 'requested' booking we asynchronously
-- (pg_net, non-blocking, post-commit) ask the email-dispatch Edge Function to
-- send the Companion notification. Email is ADDITIVE — the in-app notification
-- path is untouched, and a mail failure never affects the booking.
--
-- Auth: the call carries the internal shared secret (Vault billing_cron_secret,
-- which email-dispatch also reads as its internal secret). No user JWT involved.
-- Secrets are read only from Vault and never logged.

set search_path = '';
create extension if not exists pg_net;

create or replace function app_private.invoke_email_dispatch(p_booking uuid, p_event text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text; v_req bigint;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'billing_project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'billing_cron_secret';
  if v_url is null or v_secret is null then
    raise notice 'email-dispatch skipped: Vault billing_project_url/billing_cron_secret absent.';
    return;
  end if;
  select net.http_post(
    url := v_url || '/functions/v1/email-dispatch',
    body := jsonb_build_object('event', p_event, 'bookingId', p_booking),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-email-dispatch-secret', v_secret
    ),
    timeout_milliseconds := 8000
  ) into v_req;
end;
$$;
revoke all on function app_private.invoke_email_dispatch(uuid, text) from public, anon, authenticated;

create or replace function app_private.trg_email_booking_requested()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.invoke_email_dispatch(new.id, 'booking_requested');
  return new;
end;
$$;
revoke all on function app_private.trg_email_booking_requested() from public, anon, authenticated;

drop trigger if exists email_booking_requested on public.bookings;
create trigger email_booking_requested
  after insert on public.bookings
  for each row when (new.status = 'requested')
  execute function app_private.trg_email_booking_requested();

select pg_notify('pgrst', 'reload schema');
