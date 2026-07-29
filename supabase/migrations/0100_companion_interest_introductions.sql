-- 0100 — Block 11: Companions can see who's interested (favourited them) and
-- send ONE introduction back. The Member/Coordinator → Companion request flow
-- already exists (0025/0027); this adds the reverse direction, reusing the same
-- conversation state machine and the same trust triggers.
--
-- Safety is inherited, not re-implemented: every conversation/message insert
-- still passes through enforce_conversation_trust / enforce_message_trust
-- (0092), which reject blocked pairs, suspended/unapproved Companions, and
-- missing consent. This migration adds no new authority — it only opens a
-- controlled, rate-limited, one-pending, favourite-gated path.
--
-- Additive: three new functions, no schema/table changes, RLS unchanged.
-- Apply hosted after 0099 with `supabase db push`.

set search_path = '';

-- ---------------------------------------------------------------------------
-- Who has favourited the authenticated Companion? Returns ONLY safe display
-- fields (first name + region), resolving a Coordinator-on-behalf favourite to
-- the managed Member who would actually have the conversation. Blocked pairs
-- are omitted. No emails, phones, dates of birth or account ids are exposed.
-- ---------------------------------------------------------------------------
create or replace function public.companion_favouriters()
returns table (
  member_profile_id uuid,
  member_first_name text,
  member_region text,
  via_coordinator boolean,
  favourited_at timestamptz,
  conversation_status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (mem.id)
    mem.id,
    mem.first_name,
    mem.region,
    (rel.access_role = 'coordinator') as via_coordinator,
    f.created_at,
    c.status
  from public.favourites f
  -- The caller must OWN the favourited (companion) profile.
  join public.profile_access comp_pa
    on comp_pa.profile_id = f.profile_id
   and comp_pa.account_id = auth.uid()
   and comp_pa.access_role = 'owner'
  join public.profiles comp on comp.id = f.profile_id and comp.role = 'companion'
  -- Resolve the favouriting account to the Member it books for (self or managed).
  join public.profile_access rel
    on rel.account_id = f.account_id
   and rel.can_book
   and rel.consent_status <> 'withdrawn'
  join public.profiles mem on mem.id = rel.profile_id and mem.role = 'member'
  left join public.conversations c
    on c.member_profile_id = mem.id and c.companion_profile_id = f.profile_id
  where not app_private.active_block_between(mem.id, f.profile_id)
  order by mem.id, f.created_at desc;
$$;
revoke all on function public.companion_favouriters() from public, anon;
grant execute on function public.companion_favouriters() to authenticated;

-- ---------------------------------------------------------------------------
-- The Companion sends ONE introduction to a Member who favourited them. Creates
-- a request_pending conversation (recipient = the Member side) plus the single
-- introductory message, atomically. No booking, no payment, no auto-active
-- thread — the Member/Coordinator still accepts or declines.
-- ---------------------------------------------------------------------------
create or replace function public.companion_introduce(
  p_companion uuid,
  p_member uuid,
  p_message text
)
returns public.conversations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_conv public.conversations;
  v_recent integer;
begin
  if v_uid is null then raise exception 'unauthorised: sign in required'; end if;
  if p_message is null or btrim(p_message) = '' then
    raise exception 'invalid: an introduction needs a short message';
  end if;
  if char_length(p_message) > 2000 then
    raise exception 'invalid: message too long';
  end if;

  -- The caller must own the Companion profile they claim to speak as.
  if not exists (
    select 1 from public.profile_access pa
    where pa.profile_id = p_companion and pa.account_id = v_uid
      and pa.access_role = 'owner' and pa.consent_status <> 'withdrawn'
  ) then
    raise exception 'not_found: companion';
  end if;

  -- The Member (or their Coordinator) must have favourited this Companion — that
  -- expressed interest is what authorises the Companion to reach out.
  if not exists (
    select 1
    from public.favourites f
    join public.profile_access pa on pa.account_id = f.account_id and pa.can_book
    where f.profile_id = p_companion and pa.profile_id = p_member
  ) then
    raise exception 'not_eligible: this person has not expressed interest';
  end if;

  -- Only a complete, discoverable Companion may initiate (approved + consent +
  -- visible + not blocked). Mirrors the introduction gate on the other side.
  if not app_private.is_discoverable_companion(p_companion) then
    raise exception 'not_eligible: complete your profile before reaching out';
  end if;

  -- One conversation per pair governs everything: respect any prior outcome.
  select * into v_conv from public.conversations
   where member_profile_id = p_member and companion_profile_id = p_companion;
  if v_conv.id is not null then
    if v_conv.status = 'active' then
      raise exception 'already_connected: you already have a conversation with this person';
    elsif v_conv.status = 'request_pending' then
      raise exception 'already_sent: an introduction is already pending';
    else -- declined
      raise exception 'request_declined: this introduction was already declined';
    end if;
  end if;

  -- Rate limit: at most five pending introductions per hour, per caller.
  select count(*) into v_recent
  from public.conversations
  where requested_by_account_id = v_uid
    and status = 'request_pending'
    and created_at > now() - interval '1 hour';
  if v_recent >= 5 then
    raise exception 'rate_limited: you have sent several introductions recently — please wait a little';
  end if;

  -- Create the pending conversation (trust trigger enforces blocks / suspended /
  -- consent) initiated BY the Companion side.
  insert into public.conversations (member_profile_id, companion_profile_id, status, requested_by_account_id)
  values (p_member, p_companion, 'request_pending', v_uid)
  on conflict (member_profile_id, companion_profile_id) do nothing
  returning * into v_conv;
  if v_conv.id is null then
    raise exception 'already_sent: an introduction is already pending';
  end if;

  -- The single introductory message (trust trigger enforces blocks).
  insert into public.messages (conversation_id, sender_account_id, kind, body)
  values (v_conv.id, v_uid, 'user', btrim(p_message));

  return v_conv;
end;
$$;
revoke all on function public.companion_introduce(uuid, uuid, text) from public, anon;
grant execute on function public.companion_introduce(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The recipient side responds to a COMPANION-initiated introduction. This is
-- the mirror of respond_to_message_request (which is Companion-side only): here
-- the Member/Coordinator side accepts (→ active) or declines (→ declined) a
-- request the Companion started. It refuses to touch member-initiated requests.
-- ---------------------------------------------------------------------------
create or replace function public.respond_to_introduction(
  p_conversation uuid,
  p_accept boolean
)
returns public.conversations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_conv public.conversations;
  v_companion_initiated boolean;
begin
  if v_uid is null then raise exception 'unauthorised: sign in required'; end if;

  select * into v_conv from public.conversations where id = p_conversation for update;
  if v_conv.id is null then raise exception 'not_found: conversation'; end if;

  -- This responder is ONLY for Companion-initiated introductions.
  select exists (
    select 1 from public.profile_access pa
    where pa.profile_id = v_conv.companion_profile_id
      and pa.account_id = v_conv.requested_by_account_id
      and pa.access_role = 'owner'
  ) into v_companion_initiated;
  if not v_companion_initiated then
    raise exception 'not_eligible: this introduction is not yours to answer';
  end if;

  -- The caller must be the MEMBER side (owner, or a can-message Coordinator).
  if not exists (
    select 1 from public.profile_access pa
    where pa.profile_id = v_conv.member_profile_id
      and pa.account_id = v_uid
      and pa.consent_status <> 'withdrawn'
      and (pa.access_role = 'owner' or (pa.access_role = 'coordinator' and pa.can_message))
  ) then
    raise exception 'not_found: conversation';
  end if;

  if p_accept then
    if v_conv.status <> 'request_pending' then
      raise exception 'not_eligible: there is no introduction to accept';
    end if;
    update public.conversations
       set status = 'active', accepted_at = now(), declined_at = null
     where id = p_conversation;
    perform app_private.post_system_message(
      p_conversation, 'message_request_accepted', '{}'::jsonb,
      'message_request_accepted:' || p_conversation::text);
  else
    if v_conv.status <> 'request_pending' then
      raise exception 'not_eligible: there is no introduction to decline';
    end if;
    update public.conversations
       set status = 'declined', declined_at = now()
     where id = p_conversation;
  end if;

  select * into v_conv from public.conversations where id = p_conversation;
  return v_conv;
end;
$$;
revoke all on function public.respond_to_introduction(uuid, boolean) from public, anon;
grant execute on function public.respond_to_introduction(uuid, boolean) to authenticated;

select pg_notify('pgrst', 'reload schema');
