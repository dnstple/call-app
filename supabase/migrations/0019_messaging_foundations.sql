-- ============================================================
-- Stage 2F2A — in-app messaging: database, security, no UI yet.
--
-- One permanent thread per Member–Companion pair, creatable only when a
-- legitimate relationship exists (a confirmed/completed booking — test
-- calls included — or an accepted plan: active/paused/ended). Once
-- created it survives the end of the booking or plan.
--
-- Access: the Member-profile OWNER and the Companion-profile editor.
-- Coordinators need approved profile access AND the new, explicit
-- can_message permission (default FALSE — knowing a profile id grants
-- nothing). Unrelated and anonymous accounts cannot even learn that a
-- conversation exists.
--
-- Clients never write these tables directly: every mutation goes through
-- narrow SECURITY DEFINER RPCs (pinned empty search_path, qualified
-- relations, actor from auth.uid()). User messages are append-only;
-- system messages can only be inserted by a private function no client
-- role can execute.
-- ============================================================

-- ------------------------------------------------------------
-- 0. Explicit Coordinator messaging permission (default false).
-- ------------------------------------------------------------
alter table public.profile_access
  add column can_message boolean not null default false;

comment on column public.profile_access.can_message is
  '2F2A: explicit messaging permission for non-owner access (Coordinators). Never implied.';

-- Grantable by the profile OWNER; for coordinator-created Members that
-- have no owner account yet, the coordinator may set their OWN permission
-- only while their consent is confirmed (mirrors how can_book was granted
-- through the consent flow). Still an explicit, audited action.
create or replace function public.set_messaging_permission(
  p_profile uuid,
  p_account uuid,
  p_allowed boolean
)
returns public.profile_access
language plpgsql security definer
set search_path = ''
as $$
declare
  v_target public.profile_access;
  v_is_owner boolean;
  v_profile_has_owner boolean;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  select * into v_target from public.profile_access
   where profile_id = p_profile and account_id = p_account
   for update;
  if v_target.id is null then raise exception 'Access not found'; end if;
  if v_target.access_role = 'owner' then
    raise exception 'Owners always have access — nothing to grant';
  end if;

  v_is_owner := exists (
    select 1 from public.profile_access pa
    where pa.profile_id = p_profile and pa.account_id = auth.uid()
      and pa.access_role = 'owner'
  );
  v_profile_has_owner := exists (
    select 1 from public.profile_access pa
    where pa.profile_id = p_profile and pa.access_role = 'owner'
  );

  if not (
    v_is_owner
    or (not v_profile_has_owner
        and p_account = auth.uid()
        and v_target.access_role = 'coordinator'
        and v_target.consent_status = 'confirmed')
  ) then
    raise exception 'You cannot change messaging permission for this profile';
  end if;

  update public.profile_access
     set can_message = coalesce(p_allowed, false), updated_at = now()
   where id = v_target.id
  returning * into v_target;
  return v_target;
end;
$$;
revoke all on function public.set_messaging_permission(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_messaging_permission(uuid, uuid, boolean) to authenticated;

-- ------------------------------------------------------------
-- 1. Tables
-- ------------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  member_profile_id uuid not null references public.profiles(id) on delete cascade,
  companion_profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_message_at timestamptz,
  unique (member_profile_id, companion_profile_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  -- null sender = system. ON DELETE SET NULL: an account deletion never
  -- deletes the other participant's history.
  sender_account_id uuid references public.accounts(id) on delete set null,
  kind text not null check (kind in ('user', 'system')),
  body text check (char_length(body) <= 2000),
  system_event text,
  system_payload jsonb,
  -- Future moderation only; ordinary users can never set or clear this.
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  -- user messages carry a body; system messages carry an event and no
  -- forged human sender.
  check (
    (kind = 'user' and body is not null and system_event is null)
    or (kind = 'system' and sender_account_id is null and system_event is not null)
  )
);
-- Chronological cursor pagination: (created_at, id) descending.
create index messages_conversation_time_idx
  on public.messages (conversation_id, created_at desc, id desc);
create index messages_sender_recent_idx
  on public.messages (sender_account_id, created_at desc)
  where kind = 'user';

create table public.conversation_read_state (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  last_read_at timestamptz not null default 'epoch',
  updated_at timestamptz not null default now(),
  primary key (conversation_id, account_id)
);

-- ------------------------------------------------------------
-- 2. Access + eligibility helpers
-- ------------------------------------------------------------
create or replace function app_private.can_access_conversation(p_conversation uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversations c
    where c.id = p_conversation
      and (
        exists (                                                       -- Companion OWNER (never mere editors)
          select 1 from public.profile_access pa
          where pa.account_id = auth.uid()
            and pa.profile_id = c.companion_profile_id
            and pa.access_role = 'owner'
        )
        or exists (                                                    -- Member owner
          select 1 from public.profile_access pa
          where pa.account_id = auth.uid()
            and pa.profile_id = c.member_profile_id
            and pa.access_role = 'owner'
        )
        or exists (                                                    -- Coordinator: EXPLICIT permission, consent live
          select 1 from public.profile_access pa
          where pa.account_id = auth.uid()
            and pa.profile_id = c.member_profile_id
            and pa.access_role = 'coordinator'
            and pa.can_message
            and pa.consent_status <> 'withdrawn'
        )
      )
  );
$$;
revoke all on function app_private.can_access_conversation(uuid) from public, anon;
grant execute on function app_private.can_access_conversation(uuid) to authenticated;

-- A pair qualifies through a real relationship, and keeps the thread
-- forever once it exists: confirmed/completed booking (test calls count)
-- or an accepted plan (active/paused/ended — never merely requested).
create or replace function app_private.messaging_pair_eligible(p_member uuid, p_companion uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.bookings b
    where b.member_profile_id = p_member
      and b.companion_profile_id = p_companion
      and b.status in ('confirmed', 'completed')
  )
  or exists (
    select 1 from public.conversation_plans p
    where p.member_profile_id = p_member
      and p.companion_profile_id = p_companion
      and p.status in ('active', 'paused', 'ended')
  );
$$;
revoke all on function app_private.messaging_pair_eligible(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. RLS — reads for participants only; NO direct write policies at all.
--    Every insert/update/delete path is a SECURITY DEFINER function.
-- ------------------------------------------------------------
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.conversation_read_state enable row level security;

create policy "conversations: participants read" on public.conversations
  for select to authenticated
  using (app_private.can_access_conversation(id));

create policy "messages: participants read, moderation-hidden excluded" on public.messages
  for select to authenticated
  using (deleted_at is null and app_private.can_access_conversation(conversation_id));

create policy "read state: own rows in own conversations" on public.conversation_read_state
  for select to authenticated
  using (account_id = auth.uid() and app_private.can_access_conversation(conversation_id));

-- ------------------------------------------------------------
-- 4. RPCs
-- ------------------------------------------------------------
create or replace function public.get_or_create_conversation(
  p_member uuid,
  p_companion uuid
)
returns public.conversations
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.conversations;
  v_caller_is_member_side boolean;
  v_caller_is_companion_side boolean;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  -- The caller must BE one of the sides — the Companion-profile OWNER, the
  -- Member-profile owner, or a consent-live Coordinator with the explicit
  -- can_message permission. Participant identities are never browser-chosen
  -- and the caller is never recorded as the Member or Companion.
  v_caller_is_companion_side := exists (
    select 1 from public.profile_access pa
    where pa.account_id = auth.uid()
      and pa.profile_id = p_companion
      and pa.access_role = 'owner'
  );
  v_caller_is_member_side := exists (
    select 1 from public.profile_access pa
    where pa.account_id = auth.uid()
      and pa.profile_id = p_member
      and (pa.access_role = 'owner'
           or (pa.access_role = 'coordinator'
               and pa.can_message
               and pa.consent_status <> 'withdrawn'))
  );
  if not (v_caller_is_member_side or v_caller_is_companion_side) then
    raise exception 'Conversation not found';
  end if;

  select * into v from public.conversations
   where member_profile_id = p_member and companion_profile_id = p_companion;
  if v.id is not null then return v; end if;

  if not app_private.messaging_pair_eligible(p_member, p_companion) then
    raise exception 'not_eligible: messaging opens after a confirmed conversation or an accepted plan';
  end if;

  -- Concurrency-safe: the unique pair constraint arbitrates races.
  insert into public.conversations (member_profile_id, companion_profile_id)
  values (p_member, p_companion)
  on conflict (member_profile_id, companion_profile_id) do nothing;

  select * into v from public.conversations
   where member_profile_id = p_member and companion_profile_id = p_companion;
  return v;
end;
$$;
revoke all on function public.get_or_create_conversation(uuid, uuid) from public, anon;
grant execute on function public.get_or_create_conversation(uuid, uuid) to authenticated;

create or replace function public.send_message(
  p_conversation uuid,
  p_body text
)
returns public.messages
language plpgsql security definer
set search_path = ''
as $$
declare
  v_body text;
  v_recent integer;
  v_msg public.messages;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not app_private.can_access_conversation(p_conversation) then
    raise exception 'Conversation not found';
  end if;

  v_body := trim(coalesce(p_body, ''));
  if v_body = '' then
    raise exception 'empty_message: write something first';
  end if;
  if char_length(v_body) > 2000 then
    raise exception 'message_too_long: keep messages under 2000 characters';
  end if;

  -- Database-enforced rate limit: ≤30 user messages per account per
  -- rolling minute, across all conversations. The definer function is
  -- the only write path, so this cannot be bypassed client-side.
  select count(*) into v_recent
  from public.messages
  where sender_account_id = auth.uid()
    and kind = 'user'
    and created_at > now() - interval '1 minute';
  if v_recent >= 30 then
    raise exception 'rate_limited: you are sending messages too quickly — wait a moment';
  end if;

  -- Sender, kind, id and timestamp are all server-controlled.
  insert into public.messages (conversation_id, sender_account_id, kind, body)
  values (p_conversation, auth.uid(), 'user', v_body)
  returning * into v_msg;

  update public.conversations
     set last_message_at = v_msg.created_at
   where id = p_conversation;

  return v_msg;
end;
$$;
revoke all on function public.send_message(uuid, text) from public, anon;
grant execute on function public.send_message(uuid, text) to authenticated;

create or replace function public.mark_conversation_read(
  p_conversation uuid,
  p_up_to timestamptz default now()
)
returns public.conversation_read_state
language plpgsql security definer
set search_path = ''
as $$
declare v public.conversation_read_state;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not app_private.can_access_conversation(p_conversation) then
    raise exception 'Conversation not found';
  end if;
  -- Own row only, capped at the server clock; monotonic (never rewinds).
  insert into public.conversation_read_state (conversation_id, account_id, last_read_at, updated_at)
  values (p_conversation, auth.uid(), least(coalesce(p_up_to, now()), now()), now())
  on conflict (conversation_id, account_id) do update
    set last_read_at = greatest(public.conversation_read_state.last_read_at,
                                least(coalesce(p_up_to, now()), now())),
        updated_at = now()
  returning * into v;
  return v;
end;
$$;
revoke all on function public.mark_conversation_read(uuid, timestamptz) from public, anon;
grant execute on function public.mark_conversation_read(uuid, timestamptz) to authenticated;

-- Conversation list with safe names and derived unread counts.
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
    )
  ) order by c.last_message_at desc nulls last, c.created_at desc), '[]'::jsonb)
  from public.conversations c
  join public.profiles mp on mp.id = c.member_profile_id
  join public.profiles cp on cp.id = c.companion_profile_id
  where app_private.can_access_conversation(c.id);
$$;
revoke all on function public.list_conversations() from public, anon;
grant execute on function public.list_conversations() to authenticated;

-- ------------------------------------------------------------
-- 5. System messages: a private mechanism NO client role can call.
--    2F2B will invoke it from trusted booking/plan functions; browsers
--    cannot reach it and the messages table forbids user-kind forgery.
-- ------------------------------------------------------------
create or replace function app_private.post_system_message(
  p_conversation uuid,
  p_event text,
  p_payload jsonb default null
)
returns public.messages
language plpgsql security definer
set search_path = ''
as $$
declare v_msg public.messages;
begin
  if nullif(trim(coalesce(p_event, '')), '') is null then
    raise exception 'system_event_required';
  end if;
  insert into public.messages (conversation_id, sender_account_id, kind, system_event, system_payload)
  values (p_conversation, null, 'system', p_event, p_payload)
  returning * into v_msg;
  update public.conversations set last_message_at = v_msg.created_at where id = p_conversation;
  return v_msg;
end;
$$;
revoke all on function app_private.post_system_message(uuid, text, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 6. Realtime: new messages stream over Supabase Realtime. RLS remains
--    the security boundary — subscribers only ever receive rows their
--    policies let them SELECT.
-- ------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception
  when undefined_object then null;   -- publication absent (bare Postgres)
  when duplicate_object then null;   -- already added
end $$;
