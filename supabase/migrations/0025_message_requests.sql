-- ============================================================
-- Redesign Phase D — pre-booking message requests (migration 0025).
--
-- Model decision (documented in docs/redesign-architecture.md): the
-- conversation itself carries the request lifecycle — no separate table.
-- One long-term thread per Member–Companion pair, append-only messages,
-- existing RLS boundary unchanged.
--
--   status: request_pending | active | declined
--
-- Lifecycle:
--  * a Coordinator (or Member owner) may open a conversation with a
--    Companion BEFORE any booking: it starts request_pending and permits
--    exactly ONE requester-side message;
--  * the Companion accepts (→ active) or declines (→ declined);
--  * DECLINE IS PERMANENT FOR THE PAIR — no cooldown to game: the
--    requester cannot send again; only the Companion can reopen contact
--    by accepting the request later;
--  * a qualifying confirmed booking or active plan auto-activates the
--    thread (people who booked can obviously talk);
--  * browsers cannot forge status, sender or acceptance — every write
--    path is a SECURITY DEFINER function keyed on auth.uid().
-- ============================================================

-- ---------- schema (rerunnable) ----------
alter table public.conversations
  add column if not exists status text not null default 'active',
  add column if not exists requested_by_account_id uuid references public.accounts(id),
  add column if not exists accepted_at timestamptz,
  add column if not exists declined_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'conversations_status_check' and conrelid = 'public.conversations'::regclass
  ) then
    alter table public.conversations
      add constraint conversations_status_check
      check (status in ('request_pending', 'active', 'declined'));
  end if;
end $$;

-- Existing threads were all created through qualifying relationships.
update public.conversations set status = 'active' where status is null;

-- ---------- side helper ----------
create or replace function app_private.is_companion_side(p_conversation uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.conversations c
    join public.profile_access pa on pa.profile_id = c.companion_profile_id
    where c.id = p_conversation
      and pa.account_id = auth.uid()
      and pa.access_role = 'owner'
      and pa.consent_status <> 'withdrawn'
  );
$$;
revoke all on function app_private.is_companion_side(uuid) from public, anon, authenticated;

-- ---------- open a conversation (booking-eligible OR introduction) ----------
create or replace function public.get_or_create_conversation(
  p_member uuid,
  p_companion uuid
)
returns public.conversations
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_conv public.conversations;
  v_member_side boolean;
  v_recent_requests integer;
begin
  if v_uid is null then
    raise exception 'unauthorised: sign in required';
  end if;

  -- Both ids must be genuine profiles of the right roles.
  if not exists (select 1 from public.profiles where id = p_member and role = 'member') then
    raise exception 'not_found: conversation';
  end if;
  if not exists (select 1 from public.profiles where id = p_companion and role = 'companion') then
    raise exception 'not_found: conversation';
  end if;

  -- Existing thread → verified access → return it (whatever its status).
  select * into v_conv
  from public.conversations
  where member_profile_id = p_member and companion_profile_id = p_companion;
  if v_conv.id is not null then
    if not app_private.can_access_conversation(v_conv.id) then
      raise exception 'not_found: conversation';
    end if;
    return v_conv;
  end if;

  -- Creating: the caller must BE a side. Member side = owner, or a
  -- consent-live Coordinator with can_message. Companion side may not
  -- initiate contact with a Member they have no relationship with.
  select exists (
    select 1 from public.profile_access pa
    where pa.profile_id = p_member
      and pa.account_id = v_uid
      and pa.consent_status <> 'withdrawn'
      and (pa.access_role = 'owner'
           or (pa.access_role = 'coordinator' and pa.can_message))
  ) into v_member_side;
  if not v_member_side then
    raise exception 'not_found: conversation';
  end if;

  if app_private.messaging_pair_eligible(p_member, p_companion) then
    -- Qualifying relationship: a normal active thread.
    perform app_private.ensure_conversation(p_member, p_companion);
    select * into v_conv
    from public.conversations
    where member_profile_id = p_member and companion_profile_id = p_companion;
    update public.conversations
       set status = 'active', accepted_at = coalesce(accepted_at, now())
     where id = v_conv.id and status <> 'active';
    select * into v_conv from public.conversations where id = v_conv.id;
    return v_conv;
  end if;

  -- Introduction request: rate-limited, one pending per pair (unique
  -- pair constraint makes the concurrent case safe).
  select count(*) into v_recent_requests
  from public.conversations
  where requested_by_account_id = v_uid
    and status = 'request_pending'
    and created_at > now() - interval '1 hour';
  if v_recent_requests >= 5 then
    raise exception 'rate_limited: you have sent several introductions recently — please wait a little';
  end if;

  -- The Companion must be publicly discoverable to receive introductions.
  if not app_private.is_discoverable_companion(p_companion) then
    raise exception 'not_eligible: this Companion is not accepting introductions';
  end if;

  insert into public.conversations (member_profile_id, companion_profile_id, status, requested_by_account_id)
  values (p_member, p_companion, 'request_pending', v_uid)
  on conflict (member_profile_id, companion_profile_id) do nothing;

  select * into v_conv
  from public.conversations
  where member_profile_id = p_member and companion_profile_id = p_companion;
  return v_conv;
end;
$$;
revoke all on function public.get_or_create_conversation(uuid, uuid) from public, anon;
grant execute on function public.get_or_create_conversation(uuid, uuid) to authenticated;

-- ---------- request-aware send gate ----------
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
  v_conv public.conversations;
  v_companion_side boolean;
  v_requester_messages integer;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  if not app_private.can_access_conversation(p_conversation) then
    raise exception 'not_found: conversation';
  end if;

  select * into v_conv from public.conversations where id = p_conversation;
  v_companion_side := app_private.is_companion_side(p_conversation);

  -- Request lifecycle gates (Phase D).
  if v_conv.status = 'declined' then
    raise exception 'request_declined: this introduction was declined';
  end if;
  if v_conv.status = 'request_pending' then
    if v_companion_side then
      -- Accepting IS the companion's reply channel while pending.
      raise exception 'request_pending: accept the introduction to reply';
    end if;
    -- Exactly one requester-side message while pending.
    select count(*) into v_requester_messages
    from public.messages
    where conversation_id = p_conversation and kind = 'user';
    if v_requester_messages >= 1 then
      raise exception 'request_pending: waiting for the Companion to accept';
    end if;
  end if;

  v_body := trim(coalesce(p_body, ''));
  if v_body = '' then
    raise exception 'empty_message: write something first';
  end if;
  if char_length(v_body) > 2000 then
    raise exception 'message_too_long: keep messages under 2000 characters';
  end if;

  select count(*) into v_recent
  from public.messages
  where sender_account_id = auth.uid()
    and kind = 'user'
    and created_at > now() - interval '1 minute';
  if v_recent >= 30 then
    raise exception 'rate_limited: you are sending messages too quickly — wait a moment';
  end if;

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

-- ---------- companion decision ----------
create or replace function public.respond_to_message_request(
  p_conversation uuid,
  p_accept boolean
)
returns public.conversations
language plpgsql security definer
set search_path = ''
as $$
declare
  v_conv public.conversations;
begin
  if auth.uid() is null then
    raise exception 'unauthorised: sign in required';
  end if;
  -- Only the Companion-side OWNER decides; unrelated callers see nothing.
  if not app_private.is_companion_side(p_conversation) then
    raise exception 'not_found: conversation';
  end if;
  select * into v_conv from public.conversations where id = p_conversation for update;

  if p_accept then
    -- Accept from pending OR declined (the Companion reopening contact).
    if v_conv.status not in ('request_pending', 'declined') then
      raise exception 'not_eligible: there is no introduction to accept';
    end if;
    update public.conversations
       set status = 'active', accepted_at = now(), declined_at = null
     where id = p_conversation;
    perform app_private.post_system_message(
      p_conversation, 'message_request_accepted',
      '{}'::jsonb,
      'message_request_accepted:' || p_conversation::text);
  else
    if v_conv.status <> 'request_pending' then
      raise exception 'not_eligible: there is no introduction to decline';
    end if;
    update public.conversations
       set status = 'declined', declined_at = now()
     where id = p_conversation;
    -- No system message: the requester sees the neutral closed state.
  end if;

  select * into v_conv from public.conversations where id = p_conversation;
  return v_conv;
end;
$$;
revoke all on function public.respond_to_message_request(uuid, boolean) from public, anon;
grant execute on function public.respond_to_message_request(uuid, boolean) to authenticated;

-- ---------- qualifying relationships auto-activate the thread ----------
create or replace function app_private.activate_conversation_on_booking()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status = 'confirmed' then
    update public.conversations
       set status = 'active', accepted_at = coalesce(accepted_at, now()), declined_at = null
     where member_profile_id = new.member_profile_id
       and companion_profile_id = new.companion_profile_id
       and status <> 'active';
  end if;
  return new;
end;
$$;
revoke all on function app_private.activate_conversation_on_booking() from public, anon, authenticated;
-- Fires between materialisation (bookings_materialise_conversation) and
-- system events (bookings_zz_system_events) — alphabetical trigger order.
drop trigger if exists bookings_yy_activate_conversation on public.bookings;
create trigger bookings_yy_activate_conversation
  after insert or update on public.bookings
  for each row execute function app_private.activate_conversation_on_booking();

create or replace function app_private.activate_conversation_on_plan()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status = 'active' then
    update public.conversations
       set status = 'active', accepted_at = coalesce(accepted_at, now()), declined_at = null
     where member_profile_id = new.member_profile_id
       and companion_profile_id = new.companion_profile_id
       and status <> 'active';
  end if;
  return new;
end;
$$;
revoke all on function app_private.activate_conversation_on_plan() from public, anon, authenticated;
drop trigger if exists plans_yy_activate_conversation on public.conversation_plans;
create trigger plans_yy_activate_conversation
  after insert or update on public.conversation_plans
  for each row execute function app_private.activate_conversation_on_plan();
