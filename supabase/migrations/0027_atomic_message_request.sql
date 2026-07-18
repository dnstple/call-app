-- ============================================================
-- 0027 — atomic introduction requests; strict get_or_create again.
--
-- Live-suite reconciliation exposed a REAL defect in 0025: the generic
-- get_or_create_conversation could create an EMPTY request_pending thread
-- for any member-side caller against a discoverable Companion. The
-- product contract requires the introduction to be one atomic operation
-- (thread + the single introductory message together), and the generic
-- RPC to stay strict:
--
--   * no booking, plan or message request      → no conversation
--   * requested-only booking / plan            → no conversation
--   * get_or_create for a non-qualifying pair  → not_eligible (as pre-0025)
--   * send_message_request                     → atomically creates/reuses
--     the ONE pair thread, sets request_pending, stores the Coordinator
--     (auth.uid()) as the sender and inserts EXACTLY ONE intro message
--
-- The 0025 send_message pending gates, respond_to_message_request and
-- activation triggers are unchanged — nothing here weakens them.
-- ============================================================

-- ---------- get_or_create: strict eligibility restored ----------
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
begin
  if v_uid is null then
    raise exception 'unauthorised: sign in required';
  end if;
  if not exists (select 1 from public.profiles where id = p_member and role = 'member') then
    raise exception 'not_found: conversation';
  end if;
  if not exists (select 1 from public.profiles where id = p_companion and role = 'companion') then
    raise exception 'not_found: conversation';
  end if;

  -- An existing thread (any status, including request_pending) is
  -- returned to its participants — never duplicated.
  select * into v_conv
  from public.conversations
  where member_profile_id = p_member and companion_profile_id = p_companion;
  if v_conv.id is not null then
    if not app_private.can_access_conversation(v_conv.id) then
      raise exception 'not_found: conversation';
    end if;
    return v_conv;
  end if;

  select exists (
    select 1 from public.profile_access pa
    where pa.profile_id = p_member
      and pa.account_id = v_uid
      and pa.consent_status <> 'withdrawn'
      and (pa.access_role = 'owner'
           or (pa.access_role = 'coordinator' and pa.can_message))
  ) into v_member_side;
  if not v_member_side and not app_private.is_companion_side_of_pair(p_companion) then
    raise exception 'not_found: conversation';
  end if;

  -- 0027: the generic call NEVER creates an introduction. Empty pending
  -- threads for unrelated pairs are a defect, not a feature.
  if not app_private.messaging_pair_eligible(p_member, p_companion) then
    raise exception 'not_eligible: messaging opens after a confirmed conversation or an accepted plan';
  end if;

  perform app_private.ensure_conversation(p_member, p_companion);
  select * into v_conv
  from public.conversations
  where member_profile_id = p_member and companion_profile_id = p_companion;
  update public.conversations
     set status = 'active', accepted_at = coalesce(accepted_at, now())
   where id = v_conv.id and status <> 'active';
  select * into v_conv from public.conversations where id = v_conv.id;
  return v_conv;
end;
$$;
revoke all on function public.get_or_create_conversation(uuid, uuid) from public, anon;
grant execute on function public.get_or_create_conversation(uuid, uuid) to authenticated;

-- Companion-side helper for the pair (not the conversation) — lets the
-- Companion owner call get_or_create for their own established pairs.
create or replace function app_private.is_companion_side_of_pair(p_companion uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profile_access pa
    where pa.profile_id = p_companion
      and pa.account_id = auth.uid()
      and pa.access_role = 'owner'
      and pa.consent_status <> 'withdrawn'
  );
$$;
revoke all on function app_private.is_companion_side_of_pair(uuid) from public, anon, authenticated;

-- ---------- the atomic introduction ----------
create or replace function public.send_message_request(
  p_member uuid,
  p_companion uuid,
  p_body text
)
returns public.messages
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_conv public.conversations;
  v_body text;
  v_msg public.messages;
  v_recent integer;
  v_user_messages integer;
begin
  if v_uid is null then
    raise exception 'unauthorised: sign in required';
  end if;
  if not exists (select 1 from public.profiles where id = p_member and role = 'member')
     or not exists (select 1 from public.profiles where id = p_companion and role = 'companion') then
    raise exception 'not_found: conversation';
  end if;

  -- The sender is ALWAYS the calling account, acting for an explicit
  -- managed-Member context it genuinely holds (owner, or consent-live
  -- Coordinator with can_message). Member impersonation is impossible:
  -- the stored sender is auth.uid(), never a profile.
  if not exists (
    select 1 from public.profile_access pa
    where pa.profile_id = p_member
      and pa.account_id = v_uid
      and pa.consent_status <> 'withdrawn'
      and (pa.access_role = 'owner'
           or (pa.access_role = 'coordinator' and pa.can_message))
  ) then
    raise exception 'not_found: conversation';
  end if;

  v_body := trim(coalesce(p_body, ''));
  if v_body = '' then
    raise exception 'empty_message: write something first';
  end if;
  if char_length(v_body) > 2000 then
    raise exception 'message_too_long: keep messages under 2000 characters';
  end if;

  -- Introduction rate limit (per account, rolling hour).
  select count(*) into v_recent
  from public.conversations
  where requested_by_account_id = v_uid
    and status = 'request_pending'
    and created_at > now() - interval '1 hour';
  if v_recent >= 5 then
    raise exception 'rate_limited: you have sent several introductions recently — please wait a little';
  end if;

  -- Reuse-or-create the ONE pair thread (unique pair index makes the
  -- concurrent case safe: at most one row can ever exist).
  select * into v_conv
  from public.conversations
  where member_profile_id = p_member and companion_profile_id = p_companion
  for update;

  if v_conv.id is null then
    if app_private.messaging_pair_eligible(p_member, p_companion) then
      -- A qualifying relationship needs no introduction: normal thread.
      perform app_private.ensure_conversation(p_member, p_companion);
    else
      -- Only discoverable Companions receive introductions.
      if not app_private.is_discoverable_companion(p_companion) then
        raise exception 'not_eligible: this Companion is not accepting introductions';
      end if;
      insert into public.conversations
        (member_profile_id, companion_profile_id, status, requested_by_account_id)
      values (p_member, p_companion, 'request_pending', v_uid)
      on conflict (member_profile_id, companion_profile_id) do nothing;
    end if;
    select * into v_conv
    from public.conversations
    where member_profile_id = p_member and companion_profile_id = p_companion
    for update;
  end if;

  -- Status gates on the (now locked) thread.
  if v_conv.status = 'declined' then
    raise exception 'request_declined: this introduction was declined';
  end if;
  if v_conv.status = 'request_pending' then
    select count(*) into v_user_messages
    from public.messages
    where conversation_id = v_conv.id and kind = 'user';
    if v_user_messages >= 1 then
      raise exception 'request_pending: waiting for the Companion to accept';
    end if;
  end if;

  -- The single (or, for active threads, ordinary) message — sender,
  -- kind, id and timestamp all server-controlled.
  insert into public.messages (conversation_id, sender_account_id, kind, body)
  values (v_conv.id, v_uid, 'user', v_body)
  returning * into v_msg;

  update public.conversations
     set last_message_at = v_msg.created_at
   where id = v_conv.id;

  return v_msg;
end;
$$;
revoke all on function public.send_message_request(uuid, uuid, text) from public, anon;
grant execute on function public.send_message_request(uuid, uuid, text) to authenticated;

-- Clean-up: any EMPTY request_pending thread created by the 0025 generic
-- path (no messages at all) is a defect artefact — remove it so pairs
-- return to the strict no-relationship state. Threads with messages are
-- genuine introductions and are kept.
delete from public.conversations c
where c.status = 'request_pending'
  and not exists (select 1 from public.messages m where m.conversation_id = c.id);
