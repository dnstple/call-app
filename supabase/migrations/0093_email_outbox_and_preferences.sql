-- ============================================================================
-- 0093 — Block 3 (Communications): notification preferences + durable email
--        outbox. DESIGN + ENQUEUE ONLY — no production email is ever sent from
--        here; a deterministic adapter (src/email) drives dispatch in tests.
-- ============================================================================
-- In-app notifications already exist (0023/0032/0087/0089). This migration adds
-- the second channel's DURABLE spine so email can be turned on later without
-- schema change:
--   * notification_preferences: per-account, per-category email opt-in.
--   * email_outbox: one durable, deduplicated row per email-eligible
--     notification, snapshotting the recipient address + rendered subject/body,
--     with an idempotent status lifecycle (pending → sent | failed | suppressed).
--   * an AFTER INSERT trigger on notifications enqueues an outbox row for
--     email-eligible types, honouring preferences (opted-out → 'suppressed', an
--     auditable no-send) and deduplicating on the notification's dedupe key.
--   * service-role claim/mark RPCs are the seam a future provider dispatcher
--     (or the deterministic test adapter) calls — this migration never contacts
--     a provider and stores no credentials.
--
-- Additive only; no payment/booking/earning/transfer object is touched. Email
-- rows carry NO sensitive financial detail beyond the same neutral title/body
-- already shown in-app.
-- ----------------------------------------------------------------------------

-- ---------- per-account preferences ----------
create table if not exists public.notification_preferences (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  email_enabled boolean not null default true,          -- master email switch
  email_messages boolean not null default true,
  email_bookings boolean not null default true,
  email_billing boolean not null default true,
  email_safety boolean not null default true,           -- safety strongly recommended on
  updated_at timestamptz not null default now()
);
alter table public.notification_preferences enable row level security;
drop policy if exists "prefs: own read" on public.notification_preferences;
create policy "prefs: own read" on public.notification_preferences
  for select to authenticated using (account_id = auth.uid());
-- Writes go through the definer RPC (keeps the row shape controlled).

-- ---------- durable outbox ----------
create table if not exists public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  to_email text not null,
  category text not null check (category in ('messages', 'bookings', 'billing', 'safety', 'system')),
  template_key text not null,
  subject text not null,
  body_text text not null,
  notification_id uuid references public.notifications(id) on delete set null,
  dedupe_key text,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'suppressed')),
  attempts integer not null default 0,
  last_error text,
  provider_message_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create unique index if not exists email_outbox_dedupe
  on public.email_outbox (dedupe_key) where dedupe_key is not null;
create index if not exists email_outbox_status_idx on public.email_outbox (status, created_at)
  where status = 'pending';
alter table public.email_outbox enable row level security;
-- No client policy: the outbox is service/support only (via definer RPCs).

-- ---------- helpers ----------
-- Map an in-app notification type to an email category (null = in-app only).
create or replace function app_private.email_category_for_type(p_type text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_type = 'message_received' then 'messages'
    when p_type like 'booking_%' or p_type = 'attendance_reminder' or p_type like 'plan_%' then 'bookings'
    when p_type like 'payment_%' or p_type like 'billing_%' or p_type like 'refund_%' then 'billing'
    when p_type like 'concern_%' or p_type like 'issue_%' or p_type like 'dispute_%' then 'safety'
    else null
  end;
$$;
revoke all on function app_private.email_category_for_type(text) from public, anon, authenticated;

-- Does this account want email for this category? Defaults to opted-IN when no
-- preference row exists (parallels the table defaults).
create or replace function app_private.email_opted_in(p_account uuid, p_category text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select p.email_enabled and case p_category
      when 'messages' then p.email_messages
      when 'bookings' then p.email_bookings
      when 'billing' then p.email_billing
      when 'safety' then p.email_safety
      else true end
    from public.notification_preferences p where p.account_id = p_account
  ), true);
$$;
revoke all on function app_private.email_opted_in(uuid, text) from public, anon, authenticated;

-- Best-effort recipient address: the account's owned profile email.
create or replace function app_private.account_email(p_account uuid)
returns text language sql stable security definer set search_path = '' as $$
  select p.email
  from public.profile_access pa
  join public.profiles p on p.id = pa.profile_id
  where pa.account_id = p_account and pa.access_role = 'owner'
    and coalesce(p.email, '') <> ''
  order by pa.created_at
  limit 1;
$$;
revoke all on function app_private.account_email(uuid) from public, anon, authenticated;

-- ---------- enqueue trigger: mirror email-eligible notifications ----------
create or replace function app_private.enqueue_notification_email()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_cat text;
  v_email text;
  v_dedupe text;
  v_status text;
begin
  v_cat := app_private.email_category_for_type(new.type);
  if v_cat is null then return new; end if;               -- in-app only

  v_email := app_private.account_email(new.user_id);
  if v_email is null then return new; end if;             -- nobody to email

  v_dedupe := 'email:' || coalesce(new.dedupe_key, new.id::text);
  -- Preference honoured but still recorded (suppressed = auditable no-send).
  v_status := case when app_private.email_opted_in(new.user_id, v_cat) then 'pending' else 'suppressed' end;

  insert into public.email_outbox
    (account_id, to_email, category, template_key, subject, body_text, notification_id, dedupe_key, status)
  values (new.user_id, v_email, v_cat, 'notification:' || new.type,
          new.title, new.body, new.id, v_dedupe, v_status)
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
  return new;
end;
$$;
revoke all on function app_private.enqueue_notification_email() from public, anon, authenticated;
drop trigger if exists notifications_enqueue_email on public.notifications;
create trigger notifications_enqueue_email
  after insert on public.notifications
  for each row execute function app_private.enqueue_notification_email();

-- ---------- preference RPCs (owner) ----------
create or replace function public.get_my_notification_preferences()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v public.notification_preferences;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  select * into v from public.notification_preferences where account_id = auth.uid();
  return jsonb_build_object(
    'email_enabled', coalesce(v.email_enabled, true),
    'email_messages', coalesce(v.email_messages, true),
    'email_bookings', coalesce(v.email_bookings, true),
    'email_billing', coalesce(v.email_billing, true),
    'email_safety', coalesce(v.email_safety, true));
end;
$$;
revoke all on function public.get_my_notification_preferences() from public, anon;
grant execute on function public.get_my_notification_preferences() to authenticated;

create or replace function public.set_my_notification_preferences(
  p_email_enabled boolean, p_messages boolean, p_bookings boolean, p_billing boolean, p_safety boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  insert into public.notification_preferences
    (account_id, email_enabled, email_messages, email_bookings, email_billing, email_safety, updated_at)
  values (auth.uid(), p_email_enabled, p_messages, p_bookings, p_billing, p_safety, now())
  on conflict (account_id) do update set
    email_enabled = excluded.email_enabled,
    email_messages = excluded.email_messages,
    email_bookings = excluded.email_bookings,
    email_billing = excluded.email_billing,
    email_safety = excluded.email_safety,
    updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.set_my_notification_preferences(boolean, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.set_my_notification_preferences(boolean, boolean, boolean, boolean, boolean) to authenticated;

-- ---------- dispatcher seam (service role only) ----------
-- A future provider dispatcher (or the deterministic test adapter) claims a
-- batch, sends, then marks each row. Idempotent transitions; never re-sends a
-- row already 'sent'. No provider call happens in SQL.
create or replace function public.claim_email_batch(p_limit integer default 50)
returns setof public.email_outbox language plpgsql security definer set search_path = '' as $$
begin
  return query
  update public.email_outbox o
     set attempts = o.attempts + 1
   where o.id in (
     select id from public.email_outbox
      where status = 'pending'
      order by created_at
      for update skip locked
      limit greatest(1, least(p_limit, 200))
   )
  returning o.*;
end;
$$;
revoke all on function public.claim_email_batch(integer) from public, anon, authenticated;
grant execute on function public.claim_email_batch(integer) to service_role;

create or replace function public.mark_email_sent(p_id uuid, p_provider_message_id text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.email_outbox
     set status = 'sent', sent_at = now(), provider_message_id = p_provider_message_id, last_error = null
   where id = p_id and status <> 'sent';   -- never re-send an already-sent row
end;
$$;
revoke all on function public.mark_email_sent(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_email_sent(uuid, text) to service_role;

create or replace function public.mark_email_failed(p_id uuid, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.email_outbox
     set status = 'failed', last_error = left(coalesce(p_error, ''), 500)
   where id = p_id and status = 'pending';
end;
$$;
revoke all on function public.mark_email_failed(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_email_failed(uuid, text) to service_role;

-- ---------- support monitoring / operational health ----------
create or replace function public.support_email_outbox_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  if not app_private.is_support_admin() then raise exception 'unauthorised: support only'; end if;
  select jsonb_build_object(
    'pending', count(*) filter (where status = 'pending'),
    'sent', count(*) filter (where status = 'sent'),
    'failed', count(*) filter (where status = 'failed'),
    'suppressed', count(*) filter (where status = 'suppressed'))
    into v from public.email_outbox;
  return jsonb_build_object('ok', true, 'outbox', v);
end;
$$;
revoke all on function public.support_email_outbox_overview() from public, anon;
grant execute on function public.support_email_outbox_overview() to authenticated;

create or replace function public.support_system_health()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not app_private.is_support_admin() then raise exception 'unauthorised: support only'; end if;
  return jsonb_build_object('ok', true,
    'email_pending', (select count(*) from public.email_outbox where status = 'pending'),
    'email_failed', (select count(*) from public.email_outbox where status = 'failed'),
    'open_concerns', (select count(*) from public.conversation_concerns where state <> 'resolved'),
    'companions_pending_moderation', (select count(*) from public.companion_profiles where moderation_status = 'pending'),
    'earnings_held', (select count(*) from public.companion_earnings where state = 'held_for_issue'),
    'active_blocks', (select count(*) from public.user_blocks where removed_at is null));
end;
$$;
revoke all on function public.support_system_health() from public, anon;
grant execute on function public.support_system_health() to authenticated;

select pg_notify('pgrst', 'reload schema');
