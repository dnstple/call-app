-- ============================================================
-- 0020 — server-derived message sender attribution (2F2B fix).
--
-- Companions must see a Coordinator's message attributed to the
-- Coordinator, never to the Member. The browser cannot (and must not)
-- map account ids to people, so the messaging READ path now returns
-- safe sender metadata derived here:
--
--   sender_role: 'member' | 'companion' | 'coordinator' | 'system'
--                | 'participant' (legacy/unknown fallback)
--   sender_name: first name + last initial of the sender's own profile
--                (the Coordinator's own name for coordinator messages)
--
-- Access, pagination and every security rule are identical to the
-- 0019 direct-select path this replaces. No policies change; no data
-- changes; additive only.
-- ============================================================

create or replace function public.list_conversation_messages(
  p_conversation uuid,
  p_before_created timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 30
)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select case
    when auth.uid() is null then null
    when not app_private.can_access_conversation(p_conversation) then null
    else (
      select coalesce(jsonb_agg(row order by row->>'created_at' desc, row->>'id' desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'id', m.id,
          'conversation_id', m.conversation_id,
          'sender_account_id', m.sender_account_id,
          'kind', m.kind,
          'body', m.body,
          'system_event', m.system_event,
          'system_payload', m.system_payload,
          'deleted_at', m.deleted_at,
          'created_at', m.created_at,
          'sender_role', case
            when m.kind = 'system' then 'system'
            when exists (
              select 1 from public.profile_access pa
              join public.conversations c2 on c2.id = m.conversation_id
              where pa.account_id = m.sender_account_id
                and pa.profile_id = c2.companion_profile_id
                and pa.access_role = 'owner'
            ) then 'companion'
            when exists (
              select 1 from public.profile_access pa
              join public.conversations c2 on c2.id = m.conversation_id
              where pa.account_id = m.sender_account_id
                and pa.profile_id = c2.member_profile_id
                and pa.access_role = 'owner'
            ) then 'member'
            when exists (
              select 1 from public.profile_access pa
              join public.conversations c2 on c2.id = m.conversation_id
              where pa.account_id = m.sender_account_id
                and pa.profile_id = c2.member_profile_id
                and pa.access_role = 'coordinator'
            ) then 'coordinator'
            else 'participant'
          end,
          'sender_name', (
            -- The sender's OWN owned profile: safe first name + initial.
            select p.first_name
              || case when p.last_name <> '' then ' ' || left(p.last_name, 1) || '.' else '' end
            from public.profile_access pa
            join public.profiles p on p.id = pa.profile_id
            where pa.account_id = m.sender_account_id
              and pa.access_role = 'owner'
            order by case p.role when 'coordinator' then 0 when 'companion' then 1 else 2 end
            limit 1
          )
        ) as row
        from public.messages m
        where m.conversation_id = p_conversation
          and m.deleted_at is null
          and (
            p_before_created is null
            or m.created_at < p_before_created
            or (m.created_at = p_before_created and m.id < coalesce(p_before_id, m.id))
          )
        order by m.created_at desc, m.id desc
        limit greatest(1, least(coalesce(p_limit, 30), 100))
      ) page
    )
  end;
$$;
revoke all on function public.list_conversation_messages(uuid, timestamptz, uuid, integer) from public, anon;
grant execute on function public.list_conversation_messages(uuid, timestamptz, uuid, integer) to authenticated;
