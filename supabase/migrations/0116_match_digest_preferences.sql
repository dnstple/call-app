-- 0116 — Communications: match/introduction digest opt-in + quiet hours.
--
-- Extends the Block-3 preference/outbox spine (0093) with a fourth, deliberately
-- QUIET channel: a periodic match + introduction digest. Matches are already
-- shown live on Home; email exists only to bring people back, so it is:
--   * opt-in per account (email_matches, default on, but NEVER sent per event);
--   * quiet-hours aware (no delivery inside a per-account local window);
--   * a NEW durable outbox category 'matches', so it obeys the same deduped,
--     preference-honouring lifecycle (pending -> sent | suppressed) as every
--     other email — no new dispatch path, no provider contact here.
--
-- Additive and non-breaking: the existing 5-boolean setter is untouched;
-- get_my_notification_preferences gains keys additively; a NEW communication
-- setter carries the digest + quiet-hours fields. Apply after 0115.

set search_path = '';

-- ---------- preference columns (safe defaults preserve current behaviour) ----------
alter table public.notification_preferences
  add column if not exists email_matches boolean not null default true;
alter table public.notification_preferences
  add column if not exists quiet_hours_start smallint;    -- 0..23 local hour, null = off
alter table public.notification_preferences
  add column if not exists quiet_hours_end   smallint;    -- 0..23 local hour, null = off
alter table public.notification_preferences
  add column if not exists time_zone text not null default 'Europe/London';

do $$ begin
  alter table public.notification_preferences
    add constraint notification_preferences_quiet_hours_chk
    check ((quiet_hours_start is null or quiet_hours_start between 0 and 23)
       and (quiet_hours_end   is null or quiet_hours_end   between 0 and 23));
exception when duplicate_object then null; end $$;

-- ---------- allow the new email category on the durable outbox ----------
alter table public.email_outbox drop constraint if exists email_outbox_category_check;
alter table public.email_outbox
  add constraint email_outbox_category_check
  check (category in ('messages', 'bookings', 'billing', 'safety', 'system', 'matches'));

-- ---------- preference honoured for the new category ----------
create or replace function app_private.email_opted_in(p_account uuid, p_category text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select p.email_enabled and case p_category
      when 'messages' then p.email_messages
      when 'bookings' then p.email_bookings
      when 'billing' then p.email_billing
      when 'safety' then p.email_safety
      when 'matches' then p.email_matches
      else true end
    from public.notification_preferences p where p.account_id = p_account
  ), true);
$$;
revoke all on function app_private.email_opted_in(uuid, text) from public, anon, authenticated;

-- ---------- quiet-hours evaluation (per-account local window) ----------
-- True when p_at falls inside the account's quiet window, expressed in the
-- account's own time zone. A null/zero-length window is "never quiet". An
-- invalid stored time zone fails safe to "not quiet" (never blocks delivery).
create or replace function app_private.within_quiet_hours(p_account uuid, p_at timestamptz default now())
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v public.notification_preferences;
  v_hr int;
begin
  select * into v from public.notification_preferences where account_id = p_account;
  if not found or v.quiet_hours_start is null or v.quiet_hours_end is null
     or v.quiet_hours_start = v.quiet_hours_end then
    return false;
  end if;
  begin
    v_hr := extract(hour from (p_at at time zone coalesce(v.time_zone, 'Europe/London')))::int;
  exception when others then
    return false;  -- unknown time zone: never withhold delivery on this account
  end;
  if v.quiet_hours_start < v.quiet_hours_end then
    return v_hr >= v.quiet_hours_start and v_hr < v.quiet_hours_end;
  else
    return v_hr >= v.quiet_hours_start or v_hr < v.quiet_hours_end;  -- window crosses midnight
  end if;
end;
$$;
revoke all on function app_private.within_quiet_hours(uuid, timestamptz) from public, anon, authenticated;

-- ---------- read: additive keys on the existing preferences getter ----------
create or replace function public.get_my_notification_preferences()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v public.notification_preferences;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  select * into v from public.notification_preferences where account_id = auth.uid();
  return jsonb_build_object(
    'email_enabled',  coalesce(v.email_enabled, true),
    'email_messages', coalesce(v.email_messages, true),
    'email_bookings', coalesce(v.email_bookings, true),
    'email_billing',  coalesce(v.email_billing, true),
    'email_safety',   coalesce(v.email_safety, true),
    'email_matches',  coalesce(v.email_matches, true),
    'quiet_hours_start', v.quiet_hours_start,
    'quiet_hours_end',   v.quiet_hours_end,
    'time_zone',      coalesce(v.time_zone, 'Europe/London'));
end;
$$;
revoke all on function public.get_my_notification_preferences() from public, anon;
grant execute on function public.get_my_notification_preferences() to authenticated;

-- ---------- write: new communication-preferences setter (owner) ----------
-- Separate from the 5-boolean email setter so neither signature disturbs the
-- other; each updates only its own columns via upsert.
create or replace function public.set_my_communication_preferences(
  p_email_matches boolean,
  p_quiet_start smallint default null,
  p_quiet_end smallint default null,
  p_time_zone text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  if p_quiet_start is not null and (p_quiet_start < 0 or p_quiet_start > 23) then
    raise exception 'quiet_hours_out_of_range' using errcode = 'P0001'; end if;
  if p_quiet_end is not null and (p_quiet_end < 0 or p_quiet_end > 23) then
    raise exception 'quiet_hours_out_of_range' using errcode = 'P0001'; end if;
  insert into public.notification_preferences
    (account_id, email_matches, quiet_hours_start, quiet_hours_end, time_zone, updated_at)
  values (auth.uid(), coalesce(p_email_matches, true), p_quiet_start, p_quiet_end,
          coalesce(nullif(btrim(p_time_zone), ''), 'Europe/London'), now())
  on conflict (account_id) do update set
    email_matches     = excluded.email_matches,
    quiet_hours_start = excluded.quiet_hours_start,
    quiet_hours_end   = excluded.quiet_hours_end,
    time_zone         = excluded.time_zone,
    updated_at        = now();
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.set_my_communication_preferences(boolean, smallint, smallint, text) from public, anon;
grant execute on function public.set_my_communication_preferences(boolean, smallint, smallint, text) to authenticated;

select pg_notify('pgrst', 'reload schema');
