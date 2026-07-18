-- ============================================================
-- Stage 2F2C — trusted system messages, in-app notifications and the
-- one-call inbox read.
--
-- 1. messages.event_key + a unique partial index make every lifecycle
--    event idempotent: retries and concurrent transitions collapse into
--    ONE system message. post_system_message stays private (no client
--    role can execute it) and is now conflict-safe.
-- 2. Narrow AFTER triggers on bookings and conversation_plans emit the
--    canonical events. Only genuine transitions qualify; requested or
--    declined things emit nothing; plan-generated occurrences do NOT
--    spam the thread (the plan-level events cover them — documented
--    decision). Payloads carry only safe rendering data.
-- 3. notifications: smallest secure model. Recipients read and mark
--    ONLY their own; no client write path exists; trusted triggers
--    create them, skipping the acting account; coordinator recipients
--    require live consent + can_message. No email/push/SMS anywhere.
-- 4. list_conversations now returns the last-message preview inline —
--    the inbox needs exactly one server call.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Idempotent system messages
-- ------------------------------------------------------------
alter table public.messages add column if not exists event_key text;

create unique index if not exists messages_event_key_unique
  on public.messages (conversation_id, event_key)
  where event_key is not null;

drop function if exists app_private.post_system_message(uuid, text, jsonb);

create or replace function app_private.post_system_message(
  p_conversation uuid,
  p_event text,
  p_payload jsonb default null,
  p_event_key text default null
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare v_created timestamptz;
begin
  if nullif(trim(coalesce(p_event, '')), '') is null then
    raise exception 'system_event_required';
  end if;
  insert into public.messages (conversation_id, sender_account_id, kind, system_event, system_payload, event_key)
  values (p_conversation, null, 'system', p_event, p_payload, p_event_key)
  on conflict (conversation_id, event_key) where event_key is not null do nothing
  returning created_at into v_created;
  if v_created is not null then
    update public.conversations set last_message_at = v_created where id = p_conversation;
  end if;
end;
$$;
revoke all on function app_private.post_system_message(uuid, text, jsonb, text)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Notifications — RECONCILED with the dormant Stage-1 table.
--
-- 0001 already created public.notifications (user_id → profiles, type,
-- title, body, related_booking_id, read boolean, created_at) with RLS
-- enabled and NO policies — unreadable and never written since. This
-- migration upgrades it additively and preserves every existing row:
--   * user_id STAYS the recipient column, re-pointed to accounts(id)
--     (inspection: the 0001 FK targeted profiles — a Stage-1 artefact;
--     recipients are auth accounts. NOT VALID keeps any legacy rows);
--   * `type` serves as the notification kind (no duplicate column);
--   * related_booking_id serves as the booking link;
--   * conversation_id, plan_id, dedupe_key, read_at are added;
--   * read_at is backfilled from the legacy read flag.
-- Every statement here is safe to rerun.
-- ------------------------------------------------------------
alter table public.notifications
  add column if not exists conversation_id uuid references public.conversations(id) on delete cascade;
alter table public.notifications
  add column if not exists plan_id uuid references public.conversation_plans(id) on delete set null;
alter table public.notifications
  add column if not exists dedupe_key text;
alter table public.notifications
  add column if not exists read_at timestamptz;

-- Preserve historical read state in the new canonical column.
update public.notifications set read_at = created_at where read = true and read_at is null;

-- Recipient = ACCOUNT. Re-point the Stage-1 profiles FK; NOT VALID so any
-- legacy rows survive untouched.
do $$
begin
  alter table public.notifications drop constraint if exists notifications_user_id_fkey;
  begin
    alter table public.notifications
      add constraint notifications_user_id_fkey
      foreign key (user_id) references public.accounts(id) on delete cascade not valid;
  exception when duplicate_object then null;
  end;
end $$;

create unique index if not exists notifications_dedupe_unique
  on public.notifications (user_id, dedupe_key)
  where dedupe_key is not null;
-- notifications_user_created (user_id, created_at desc) already exists from 0001.

alter table public.notifications enable row level security; -- already on; harmless
drop policy if exists "notifications: own rows only" on public.notifications;
create policy "notifications: own rows only" on public.notifications
  for select to authenticated
  using (user_id = auth.uid());
-- No insert/update/delete policies: writes happen ONLY through trusted
-- server code and the two mark-read RPCs below.

create or replace function public.mark_notification_read(p_notification uuid)
returns public.notifications
language plpgsql security definer
set search_path = ''
as $$
declare v public.notifications;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  update public.notifications
     set read_at = coalesce(read_at, now()), read = true
   where id = p_notification and user_id = auth.uid()
  returning * into v;
  if v.id is null then raise exception 'not_found: notification'; end if;
  return v;
end;
$$;
revoke all on function public.mark_notification_read(uuid) from public, anon;
grant execute on function public.mark_notification_read(uuid) to authenticated;

create or replace function public.mark_all_notifications_read()
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare v_count integer;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  update public.notifications
     set read_at = now(), read = true
   where user_id = auth.uid() and read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.mark_all_notifications_read() from public, anon;
grant execute on function public.mark_all_notifications_read() to authenticated;

-- Trusted fan-out: every account on both sides of a conversation except
-- the actor. Coordinators only with live consent AND can_message.
create or replace function app_private.notify_conversation_participants(
  p_conversation uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_booking uuid,
  p_plan uuid,
  p_dedupe_suffix text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare v_c public.conversations; v_account uuid;
begin
  select * into v_c from public.conversations where id = p_conversation;
  if v_c.id is null then return; end if;
  for v_account in
    select distinct pa.account_id
    from public.profile_access pa
    where (
        (pa.profile_id = v_c.companion_profile_id and pa.access_role = 'owner')
        or (pa.profile_id = v_c.member_profile_id and pa.access_role = 'owner')
        or (pa.profile_id = v_c.member_profile_id
            and pa.access_role = 'coordinator'
            and pa.can_message
            and pa.consent_status <> 'withdrawn')
      )
      and pa.account_id is distinct from auth.uid()  -- never notify the actor
  loop
    insert into public.notifications
      (user_id, type, title, body, conversation_id, related_booking_id, plan_id, dedupe_key)
    values
      (v_account, p_kind, p_title, coalesce(p_body, ''), p_conversation, p_booking, p_plan,
       p_kind || ':' || p_dedupe_suffix)
    on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
  end loop;
end;
$$;
revoke all on function app_private.notify_conversation_participants(uuid, text, text, text, uuid, uuid, text)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Lifecycle triggers
-- ------------------------------------------------------------
create or replace function app_private.emit_booking_events()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_conv uuid;
  v_when text;
  v_payload jsonb;
begin
  -- Plan-generated occurrences are covered by plan-level events; emitting
  -- one per weekly occurrence would flood the thread (decision, 2F2C).
  if new.plan_id is not null then return new; end if;

  select id into v_conv from public.conversations
   where member_profile_id = new.member_profile_id
     and companion_profile_id = new.companion_profile_id;
  if v_conv is null then return new; end if;

  v_when := to_char(new.starts_at at time zone new.timezone, 'FMDay DD FMMonth at HH24:MI');
  v_payload := jsonb_build_object(
    'booking_id', new.id,
    'starts_at', new.starts_at,
    'duration_minutes', new.duration_minutes,
    'status', new.status
  );

  if new.status = 'confirmed' and (tg_op = 'INSERT' or old.status in ('requested', 'change_proposed')) then
    if tg_op = 'UPDATE' and old.status = 'change_proposed' and old.starts_at <> new.starts_at then
      perform app_private.post_system_message(v_conv, 'booking_rescheduled', v_payload,
        'booking_rescheduled:' || new.id || ':' || new.starts_at::text);
      perform app_private.notify_conversation_participants(v_conv, 'booking_rescheduled',
        'Conversation moved', 'Now ' || v_when, new.id, null,
        new.id::text || ':' || new.starts_at::text);
    else
      perform app_private.post_system_message(v_conv, 'booking_confirmed', v_payload,
        'booking_confirmed:' || new.id);
      perform app_private.notify_conversation_participants(v_conv, 'booking_confirmed',
        'Conversation confirmed', v_when, new.id, null, new.id::text);
    end if;
  elsif tg_op = 'UPDATE' and new.status = 'cancelled'
        and old.status in ('confirmed', 'change_proposed') then
    -- Cancellation reasons stay private — never in the thread or payload.
    perform app_private.post_system_message(v_conv, 'booking_cancelled', v_payload,
      'booking_cancelled:' || new.id);
    perform app_private.notify_conversation_participants(v_conv, 'booking_cancelled',
      'Conversation cancelled', 'Was ' || v_when, new.id, null, new.id::text);
  elsif tg_op = 'UPDATE' and new.status = 'completed' and old.status <> 'completed' then
    perform app_private.post_system_message(v_conv, 'booking_completed', v_payload,
      'booking_completed:' || new.id);
  end if;
  return new;
end;
$$;
revoke all on function app_private.emit_booking_events() from public, anon, authenticated;

-- Name sorts AFTER bookings_materialise_conversation (0021), so the
-- thread exists before events are written.
drop trigger if exists bookings_zz_system_events on public.bookings;
create trigger bookings_zz_system_events
  after insert or update of status, starts_at on public.bookings
  for each row execute function app_private.emit_booking_events();

create or replace function app_private.emit_plan_events()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_conv uuid;
  v_payload jsonb;
  v_terms text;
begin
  select id into v_conv from public.conversations
   where member_profile_id = new.member_profile_id
     and companion_profile_id = new.companion_profile_id;
  if v_conv is null then return new; end if;

  v_payload := jsonb_build_object(
    'plan_id', new.id,
    'frequency_per_week', new.frequency_per_week,
    'duration_minutes', new.duration_minutes,
    'status', new.status
  );
  v_terms := new.frequency_per_week || 'x' || new.duration_minutes || '@' || new.weekly_price_minor;

  if old.status = 'requested' and new.status = 'active' then
    perform app_private.post_system_message(v_conv, 'plan_accepted', v_payload,
      'plan_accepted:' || new.id);
    perform app_private.notify_conversation_participants(v_conv, 'plan_accepted',
      'Weekly plan active', new.frequency_per_week || ' conversations per week', null, new.id, new.id::text);
  elsif old.status = 'active' and new.status = 'paused' then
    perform app_private.post_system_message(v_conv, 'plan_paused', v_payload,
      'plan_paused:' || new.id || ':' || coalesce(new.paused_at::text, ''));
    perform app_private.notify_conversation_participants(v_conv, 'plan_paused',
      'Plan paused', null, null, new.id, new.id::text || ':' || coalesce(new.paused_at::text, ''));
  elsif old.status = 'paused' and new.status = 'active' then
    perform app_private.post_system_message(v_conv, 'plan_resumed', v_payload,
      'plan_resumed:' || new.id || ':' || now()::text);
    perform app_private.notify_conversation_participants(v_conv, 'plan_resumed',
      'Plan resumed', null, null, new.id, new.id::text || ':resumed:' || now()::text);
  elsif new.status = 'ended' and old.status <> 'ended' then
    perform app_private.post_system_message(v_conv, 'plan_ended', v_payload,
      'plan_ended:' || new.id);
    perform app_private.notify_conversation_participants(v_conv, 'plan_ended',
      'Plan ended', null, null, new.id, new.id::text);
  elsif old.status = 'active' and new.status = 'active'
        and (old.frequency_per_week <> new.frequency_per_week
             or old.duration_minutes <> new.duration_minutes
             or old.weekly_price_minor <> new.weekly_price_minor) then
    -- Same terms retried → same key → one event.
    perform app_private.post_system_message(v_conv, 'plan_schedule_changed', v_payload,
      'plan_schedule_changed:' || new.id || ':' || v_terms);
    perform app_private.notify_conversation_participants(v_conv, 'plan_schedule_changed',
      'Plan schedule changed', new.frequency_per_week || ' conversations per week', null, new.id,
      new.id::text || ':' || v_terms);
  end if;
  return new;
end;
$$;
revoke all on function app_private.emit_plan_events() from public, anon, authenticated;

drop trigger if exists plans_zz_system_events on public.conversation_plans;
create trigger plans_zz_system_events
  after update of status, frequency_per_week, duration_minutes, weekly_price_minor
  on public.conversation_plans
  for each row execute function app_private.emit_plan_events();

-- ------------------------------------------------------------
-- 4. One-call inbox: last-message preview inline.
-- ------------------------------------------------------------
create or replace function public.list_conversations()
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'member_profile_id', c.member_profile_id,
    'companion_profile_id', c.companion_profile_id,
    'member_name', mp.first_name || case when mp.last_name <> '' then ' ' || left(mp.last_name, 1) || '.' else '' end,
    'companion_name', cp.first_name || case when cp.last_name <> '' then ' ' || left(cp.last_name, 1) || '.' else '' end,
    'created_at', c.created_at,
    'last_message_at', c.last_message_at,
    'unread_count', (
      select count(*)
      from public.messages m
      where m.conversation_id = c.id
        and m.deleted_at is null
        and m.created_at > coalesce(
          (select rs.last_read_at from public.conversation_read_state rs
           where rs.conversation_id = c.id and rs.account_id = auth.uid()),
          'epoch'::timestamptz)
        and (m.sender_account_id is distinct from auth.uid())
    ),
    'last_message', (
      select jsonb_build_object(
        'kind', m.kind,
        'body', left(m.body, 140),
        'system_event', m.system_event,
        'created_at', m.created_at,
        'mine', m.sender_account_id = auth.uid()
      )
      from public.messages m
      where m.conversation_id = c.id and m.deleted_at is null
      order by m.created_at desc, m.id desc
      limit 1
    )
  ) order by c.last_message_at desc nulls last, c.created_at desc), '[]'::jsonb)
  from public.conversations c
  join public.profiles mp on mp.id = c.member_profile_id
  join public.profiles cp on cp.id = c.companion_profile_id
  where app_private.can_access_conversation(c.id);
$$;
revoke all on function public.list_conversations() from public, anon;
grant execute on function public.list_conversations() to authenticated;
