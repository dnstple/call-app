-- ===========================================================================
-- 0189_call_feedback.sql
--
-- Post-call feedback loop. After a call completes, BOTH participants (member/
-- booker and companion) get an in-app note + an SMS with a link to a simple
-- feedback page (1–5 stars + notes). If they haven't submitted within 30 minutes
-- of completion, a single SMS reminder goes out. Reuses the existing outbox +
-- call-failover transport for SMS, and app_private.notify_account for in-app.
-- ===========================================================================

set search_path = '';

-- ------------------------------------------------------------ call_feedback --
create table if not exists public.call_feedback (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references public.bookings(id) on delete cascade,
  account_id  uuid not null references public.accounts(id) on delete cascade,
  stars       integer not null check (stars between 1 and 5),
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (booking_id, account_id)
);
create index if not exists call_feedback_booking_idx on public.call_feedback (booking_id);

alter table public.call_feedback enable row level security;
drop policy if exists "call_feedback: read own" on public.call_feedback;
create policy "call_feedback: read own" on public.call_feedback
  for select to authenticated using (account_id = auth.uid() or app_private.is_support_admin());

-- Who counts as a participant able to give feedback on a booking.
create or replace function app_private.is_call_participant(p_booking uuid, p_account uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.bookings b
    where b.id = p_booking
      and (p_account = b.booked_by_account_id
        or p_account = app_private.profile_owner_account(b.member_profile_id)
        or p_account = app_private.profile_owner_account(b.companion_profile_id))
  );
$$;

-- ------------------------------------------------------------- submit / read
create or replace function public.submit_call_feedback(p_booking uuid, p_stars integer, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_acct uuid := auth.uid();
begin
  if v_acct is null then raise exception 'unauthorised' using errcode = '42501'; end if;
  if p_stars is null or p_stars < 1 or p_stars > 5 then raise exception 'invalid_stars' using errcode = 'P0001'; end if;
  if not app_private.is_call_participant(p_booking, v_acct) then
    return jsonb_build_object('ok', false, 'error', 'not_participant');
  end if;
  insert into public.call_feedback (booking_id, account_id, stars, notes)
  values (p_booking, v_acct, p_stars, left(coalesce(p_notes, ''), 2000))
  on conflict (booking_id, account_id) do update
    set stars = excluded.stars, notes = excluded.notes, updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.submit_call_feedback(uuid, integer, text) from public, anon;
grant execute on function public.submit_call_feedback(uuid, integer, text) to authenticated;

-- Context for the feedback page (participant only; no member PII beyond a name).
create or replace function public.get_call_feedback_context(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare b record; v_acct uuid := auth.uid(); v_counterpart text; v_role text; v_done boolean;
begin
  if v_acct is null then return jsonb_build_object('ok', false, 'error', 'unauthorised'); end if;
  select * into b from public.bookings where id = p_booking;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not app_private.is_call_participant(p_booking, v_acct) then
    return jsonb_build_object('ok', false, 'error', 'not_participant');
  end if;
  if v_acct = app_private.profile_owner_account(b.companion_profile_id) then
    v_role := 'companion';
    select first_name into v_counterpart from public.profiles where id = b.member_profile_id;
  else
    v_role := 'member';
    select first_name into v_counterpart from public.profiles where id = b.companion_profile_id;
  end if;
  v_done := exists (select 1 from public.call_feedback where booking_id = p_booking and account_id = v_acct);
  return jsonb_build_object('ok', true, 'starts_at', b.starts_at, 'duration_minutes', b.duration_minutes,
    'counterpart', v_counterpart, 'your_role', v_role, 'already_submitted', v_done, 'status', b.status);
end;
$$;
revoke all on function public.get_call_feedback_context(uuid) from public, anon;
grant execute on function public.get_call_feedback_context(uuid) to authenticated;

-- --------------------------------------------- sweep: request feedback -------
-- After a call completes, send each participant ONE feedback request (in-app +
-- SMS). Idempotent via dedupe keys. Service role (pg_cron).
create or replace function public.sweep_call_feedback()
returns integer language plpgsql security definer set search_path = '' as $$
declare b record; n integer := 0; v_link text; v_time text; a uuid;
begin
  for b in
    select id, member_profile_id, companion_profile_id, booked_by_account_id, starts_at, timezone, completed_at
    from public.bookings
    where status = 'completed' and completed_at is not null
      and completed_at > now() - interval '6 hours'
  loop
    v_time := app_private.friendly_call_time(b.starts_at, b.timezone);
    for a in
      select x from unnest(array[
        b.booked_by_account_id,
        app_private.profile_owner_account(b.companion_profile_id)
      ]) as x
      where x is not null
    loop
      v_link := 'https://apricoti.co.uk/#/feedback/' || b.id::text;
      perform app_private.notify_account(a, 'call_feedback_request',
        'How was your call?',
        'Thanks for your call — please leave quick feedback (a rating and any notes) to help us improve Apricoti.',
        b.id, 'feedback_request:' || b.id::text || ':' || a::text);
      perform app_private.queue_failover_sms(b.id, a, 'feedback_request',
        'Apricoti: Thanks for your ' || v_time || ' call. Please leave quick feedback: ' || v_link,
        'feedback_request:' || b.id::text || ':' || a::text);
      n := n + 1;
    end loop;
  end loop;
  return n;
end;
$$;
revoke all on function public.sweep_call_feedback() from public, anon, authenticated;
grant execute on function public.sweep_call_feedback() to service_role;

-- --------------------------------------------- sweep: 30-min reminder --------
-- 30+ minutes after completion, remind (SMS only) participants who still haven't
-- left feedback. One reminder each, deduped.
create or replace function public.sweep_feedback_reminders()
returns integer language plpgsql security definer set search_path = '' as $$
declare b record; n integer := 0; v_link text; a uuid;
begin
  for b in
    select id, member_profile_id, companion_profile_id, booked_by_account_id, completed_at
    from public.bookings
    where status = 'completed' and completed_at is not null
      and completed_at <= now() - interval '30 minutes'
      and completed_at >  now() - interval '24 hours'
  loop
    for a in
      select x from unnest(array[
        b.booked_by_account_id,
        app_private.profile_owner_account(b.companion_profile_id)
      ]) as x
      where x is not null
    loop
      -- skip if they already gave feedback, or were already reminded
      if exists (select 1 from public.call_feedback f where f.booking_id = b.id and f.account_id = a) then
        continue;
      end if;
      v_link := 'https://apricoti.co.uk/#/feedback/' || b.id::text;
      perform app_private.queue_failover_sms(b.id, a, 'feedback_reminder',
        'Apricoti: We''d love your feedback on your recent call — it only takes a moment: ' || v_link,
        'feedback_reminder:' || b.id::text || ':' || a::text);
      n := n + 1;
    end loop;
  end loop;
  return n;
end;
$$;
revoke all on function public.sweep_feedback_reminders() from public, anon, authenticated;
grant execute on function public.sweep_feedback_reminders() to service_role;

-- ------------------------------------------------------------- pg_cron -------
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — schedule sweep_call_feedback() and sweep_feedback_reminders() yourself.';
    return;
  end if;
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'sweep-call-feedback';
  perform cron.unschedule(jobid) from cron.job where jobname = 'sweep-feedback-reminders';
  perform cron.schedule('sweep-call-feedback',      '*/10 * * * *', $cron$select public.sweep_call_feedback();$cron$);
  perform cron.schedule('sweep-feedback-reminders', '*/10 * * * *', $cron$select public.sweep_feedback_reminders();$cron$);
  raise notice 'Scheduled feedback sweeps every 10 minutes.';
exception when others then
  raise notice 'feedback sweep scheduling skipped (%).', sqlerrm;
end $$;

select pg_notify('pgrst', 'reload schema');
