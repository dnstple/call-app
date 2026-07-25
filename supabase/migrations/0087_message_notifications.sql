-- ============================================================================
-- 0087 — Stage 3F-A: in-app notifications for new conversation messages.
-- ============================================================================
-- Gap (audit §3 A1): send_message (0019) / send_message_request (0027) insert a
-- user message and bump last_message_at but emit NO notification, so the
-- recipient gets no bell/notification-centre entry. This migration adds the
-- smallest additive hook: an AFTER INSERT trigger on public.messages that, for
-- USER messages only, notifies every OTHER conversation participant. Using a
-- trigger (not a rewrite of the two sender functions) means one authoritative
-- hook covers both existing senders and any future insert path.
--
-- Recipient set + permission rules are identical to 0023
-- (notify_conversation_participants): companion owner, member owner, and member
-- COORDINATORS only where they hold can_message and non-withdrawn consent. The
-- message's own sender is always excluded. Purely additive: no payment,
-- booking, earning or transfer object is touched; notifications are ordinary
-- RLS-scoped rows the recipient already owns.
--
-- Coalescing: at most ONE unread 'message_received' notification per
-- (recipient, conversation). Each new message re-surfaces that single row
-- (read=false, refreshed timestamp) instead of creating a pile; reading it
-- (mark_notification_read / mark_all) clears it; the next message re-surfaces
-- it again. This satisfies "deduplication" + "unread badge" + "deep link"
-- without storing message content in the notifications table (privacy-minimal,
-- and future email/SMS/digest channels can read this same model unchanged).
-- ----------------------------------------------------------------------------

create or replace function app_private.notify_new_message(
  p_conversation uuid, p_sender_account uuid
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
      and pa.account_id is not null
      and pa.account_id is distinct from p_sender_account  -- never notify the sender
  loop
    insert into public.notifications
      (user_id, type, title, body, conversation_id, dedupe_key, read, read_at)
    values
      (v_account, 'message_received', 'New message',
       'You have a new message.', p_conversation,
       'message_received:' || p_conversation::text, false, null)
    on conflict (user_id, dedupe_key) where dedupe_key is not null
      do update set read = false, read_at = null, created_at = now(),
                    title = excluded.title, body = excluded.body;
  end loop;
end;
$$;
revoke all on function app_private.notify_new_message(uuid, uuid) from public, anon, authenticated;

-- AFTER INSERT trigger: user messages only. System messages already flow
-- through the 0023 lifecycle notifier; a null-sender system row is skipped.
create or replace function app_private.on_message_insert_notify()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.kind = 'user' and new.sender_account_id is not null then
    perform app_private.notify_new_message(new.conversation_id, new.sender_account_id);
  end if;
  return new;
end;
$$;
revoke all on function app_private.on_message_insert_notify() from public, anon, authenticated;

drop trigger if exists trg_message_insert_notify on public.messages;
create trigger trg_message_insert_notify
  after insert on public.messages
  for each row
  execute function app_private.on_message_insert_notify();
