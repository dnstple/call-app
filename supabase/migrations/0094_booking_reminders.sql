-- ============================================================================
-- 0094 — Block 3 (Communications): pre-conversation booking reminders.
-- ============================================================================
-- 0037 added a 2-hour POST-start Companion attendance reminder. This adds
-- PRE-conversation reminders for BOTH parties (member owner + companion owner):
--   * a 24-hour reminder and a 1-hour reminder per confirmed future booking;
--   * deterministic, deduplicated (one row per booking per window per recipient
--     via the notifications dedupe key), so re-runs never duplicate;
--   * inserted as ordinary notifications, so the 0093 trigger mirrors them to
--     the email outbox automatically (honouring preferences).
-- Service-role only; no money, completion or booking-state change. A guarded
-- pg_cron schedule is registered when the extension is present (mirrors 0044);
-- on environments without pg_cron the function is simply callable on demand.
-- ----------------------------------------------------------------------------

create or replace function public.create_booking_reminders()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_row record;
  v_member_acc uuid;
  v_companion_acc uuid;
  v_count integer := 0;
  v_now timestamptz := now();
begin
  for v_row in
    select b.id, b.member_profile_id, b.companion_profile_id, b.starts_at,
           case
             when b.starts_at > v_now and b.starts_at <= v_now + interval '1 hour' then '1h'
             when b.starts_at > v_now + interval '1 hour' and b.starts_at <= v_now + interval '24 hours' then '24h'
             else null
           end as window
    from public.bookings b
    where b.status = 'confirmed'
      and b.starts_at > v_now
      and b.starts_at <= v_now + interval '24 hours'
  loop
    if v_row.window is null then continue; end if;
    v_member_acc := app_private.profile_owner_account(v_row.member_profile_id);
    v_companion_acc := app_private.profile_owner_account(v_row.companion_profile_id);

    -- Member owner reminder (skip managed Members with no owner account).
    if v_member_acc is not null then
      insert into public.notifications
        (user_id, type, title, body, related_booking_id, dedupe_key)
      values (v_member_acc, 'booking_reminder',
              case v_row.window when '1h' then 'Your conversation is soon'
                                else 'Your conversation is tomorrow' end,
              'A reminder about your upcoming conversation.',
              v_row.id, 'booking-reminder-' || v_row.window || ':' || v_row.id::text)
      on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
      if found then v_count := v_count + 1; end if;
    end if;

    -- Companion owner reminder.
    if v_companion_acc is not null then
      insert into public.notifications
        (user_id, type, title, body, related_booking_id, dedupe_key)
      values (v_companion_acc, 'booking_reminder',
              case v_row.window when '1h' then 'Your conversation is soon'
                                else 'Your conversation is tomorrow' end,
              'A reminder about your upcoming conversation.',
              v_row.id, 'booking-reminder-' || v_row.window || ':' || v_row.id::text)
      on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
      if found then v_count := v_count + 1; end if;
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.create_booking_reminders() from public, anon, authenticated;
grant execute on function public.create_booking_reminders() to service_role;

-- Guarded scheduling: hourly, only if pg_cron is installed. Safe/no-op otherwise.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('booking-reminders-hourly', '5 * * * *',
      $cron$ select public.create_booking_reminders(); $cron$);
  end if;
exception when others then
  -- Never fail the migration on scheduling; the function remains callable.
  null;
end $$;

-- 'booking_reminder' maps to the 'bookings' email category via 0093's
-- email_category_for_type (booking_% prefix), so reminders reach email too.

select pg_notify('pgrst', 'reload schema');
