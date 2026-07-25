-- ============================================================================
-- 0089 — Block 2 (Trust & Safety): conversation-scoped reporting.
-- ============================================================================
-- Stage 3F identified that report_conversation_issue (0034) is booking-scoped
-- (booking_id NOT NULL) and offers only completion-oriented categories. Trust &
-- safety needs a report action available from a CONVERSATION (before/during/
-- after a booked call) with a broad safeguarding taxonomy, while REUSING the
-- existing earning/payout hold path when a related booking earning is still
-- pending. This migration adds a conversation-scoped concern model that feeds
-- the existing support authorisation model and the SAME hold mechanism —
-- never a second money path.
--
-- The browser submits only: conversation id, an allowed category, and a safe
-- description. The server derives reporter identity + role, the reported
-- participant, the related booking/earning, the hold consequence, timestamps
-- and status. Reporting NEVER alters payment success; it can only move a
-- still-pending earning into the existing held_for_issue state.
-- ----------------------------------------------------------------------------

create table if not exists public.conversation_concerns (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  booking_id uuid references public.bookings(id),
  earning_id uuid references public.companion_earnings(id),
  reporter_account_id uuid not null references public.accounts(id),
  reporter_role text not null check (reporter_role in ('member', 'coordinator', 'companion')),
  reported_profile_id uuid references public.profiles(id),
  category text not null check (category in
    ('inappropriate_conduct', 'safeguarding', 'harassment', 'suspected_fraud',
     'privacy', 'technical_call_problem', 'other')),
  description text not null check (char_length(description) between 1 and 4000),
  priority text not null default 'normal' check (priority in ('normal', 'high')),
  state text not null default 'open' check (state in ('open', 'reviewing', 'resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
-- One ACTIVE concern per (conversation, reporter, category): duplicate clicks
-- and repeated submissions safely coalesce to the existing open concern.
create unique index if not exists conversation_concerns_one_active
  on public.conversation_concerns (conversation_id, reporter_account_id, category)
  where state <> 'resolved';
create index if not exists conversation_concerns_conversation_idx
  on public.conversation_concerns (conversation_id);

alter table public.conversation_concerns enable row level security;
-- The reporter reads their own concern (neutral status). The reported party
-- never sees the complaint. Support reads via SECURITY DEFINER RPC only.
drop policy if exists "concerns: reporter reads own" on public.conversation_concerns;
create policy "concerns: reporter reads own" on public.conversation_concerns
  for select to authenticated using (reporter_account_id = auth.uid());
-- No client insert/update/delete: all writes go through the definer RPC.

-- Categories that, when a related booking earning is still pending, must place
-- the existing payout hold (single authority: the same held_for_issue path).
create or replace function app_private.concern_category_holds(p_category text)
returns boolean language sql immutable set search_path = '' as $$
  select p_category in ('inappropriate_conduct', 'safeguarding', 'harassment', 'suspected_fraud');
$$;
revoke all on function app_private.concern_category_holds(text) from public, anon, authenticated;

-- ---------- the report entry point ----------
create or replace function public.report_conversation_concern(
  p_conversation uuid, p_category text, p_description text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_c public.conversations;
  v_role text;
  v_reported uuid;
  v_priority text := 'normal';
  v_booking uuid;
  v_earning uuid;
  v_existing public.conversation_concerns;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  select * into v_c from public.conversations where id = p_conversation;
  if v_c.id is null then raise exception 'not_found: conversation'; end if;

  if p_description is null or trim(p_description) = '' or char_length(p_description) > 4000 then
    raise exception 'description_required: please describe the concern';
  end if;
  if not app_private.concern_category_holds(p_category)
     and p_category not in ('privacy', 'technical_call_problem', 'other') then
    raise exception 'invalid_category';
  end if;

  -- Derive reporter role from conversation participation (same rules as 0023/0087):
  -- companion owner, member owner, or member Coordinator with messaging authority.
  if app_private.profile_owner_account(v_c.companion_profile_id) = auth.uid() then
    v_role := 'companion';
    v_reported := v_c.member_profile_id;
  elsif app_private.profile_owner_account(v_c.member_profile_id) = auth.uid() then
    v_role := 'member';
    v_reported := v_c.companion_profile_id;
  elsif exists (
      select 1 from public.profile_access pa
      where pa.profile_id = v_c.member_profile_id and pa.account_id = auth.uid()
        and pa.access_role = 'coordinator' and pa.can_message
        and pa.consent_status <> 'withdrawn'
    ) then
    v_role := 'coordinator';
    v_reported := v_c.companion_profile_id;
  else
    -- Unrelated users cannot report into a private conversation.
    raise exception 'not_found: conversation';
  end if;

  if app_private.concern_category_holds(p_category) then v_priority := 'high'; end if;

  -- Idempotent: return the existing open concern of the same category if present.
  select * into v_existing from public.conversation_concerns
    where conversation_id = p_conversation and reporter_account_id = auth.uid()
      and category = p_category and state <> 'resolved'
    limit 1;
  if v_existing.id is not null then
    return jsonb_build_object('ok', true, 'already', true, 'concern_id', v_existing.id, 'status', v_existing.state);
  end if;

  -- Relate to the most recent booking for this member↔companion pair, and place
  -- the EXISTING payout hold only when the category qualifies and an earning is
  -- still pending. This is the same held_for_issue path used by 0034 — no new
  -- money movement, and successful payments are never altered.
  select b.id into v_booking
  from public.bookings b
  where b.member_profile_id = v_c.member_profile_id
    and b.companion_profile_id = v_c.companion_profile_id
  order by b.starts_at desc
  limit 1;

  if v_booking is not null and app_private.concern_category_holds(p_category) then
    select id into v_earning from public.companion_earnings
      where booking_id = v_booking for update;
    if v_earning is not null then
      update public.companion_earnings
         set state = 'held_for_issue', updated_at = now()
       where id = v_earning and state = 'pending_completion';
    end if;
  end if;

  insert into public.conversation_concerns
    (conversation_id, booking_id, earning_id, reporter_account_id, reporter_role,
     reported_profile_id, category, description, priority)
  values (p_conversation, v_booking, v_earning, auth.uid(), v_role,
          v_reported, p_category, trim(p_description), v_priority)
  returning * into v_existing;

  -- Neutral notification to the reporter (no complaint text stored in it).
  insert into public.notifications (user_id, type, title, body, conversation_id, related_booking_id, dedupe_key, read, read_at)
  values (auth.uid(), 'concern_received', 'Report received',
          'Thank you. Our support team will review your report.', p_conversation, v_booking,
          'concern_received:' || v_existing.id::text, false, null)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;

  return jsonb_build_object('ok', true, 'already', false, 'concern_id', v_existing.id, 'status', 'open');
end;
$$;
revoke all on function public.report_conversation_concern(uuid, text, text) from public, anon;
grant execute on function public.report_conversation_concern(uuid, text, text) to authenticated;

-- ---------- support queue projection (authorised only) ----------
create or replace function public.support_concerns_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_rows jsonb;
begin
  if not app_private.is_support_admin() then raise exception 'unauthorised: support only'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'concern_id', cc.id,
           'conversation_id', cc.conversation_id,
           'booking_id', cc.booking_id,
           'category', cc.category,
           'priority', cc.priority,
           'state', cc.state,
           'reporter_role', cc.reporter_role,
           'earning_held', (cc.earning_id is not null),
           'created_at', cc.created_at
         ) order by (cc.priority = 'high') desc, cc.created_at desc), '[]'::jsonb)
    into v_rows
  from public.conversation_concerns cc
  where cc.state <> 'resolved';
  return jsonb_build_object('ok', true, 'concerns', v_rows);
end;
$$;
revoke all on function public.support_concerns_overview() from public, anon;
grant execute on function public.support_concerns_overview() to authenticated;

-- ---------- support resolution (authorised only, audited via updated_at) ----------
create or replace function public.support_resolve_concern(p_concern uuid, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_c public.conversation_concerns;
begin
  if not app_private.is_support_admin() then raise exception 'unauthorised: support only'; end if;
  update public.conversation_concerns
     set state = 'resolved', resolved_at = now(), updated_at = now()
   where id = p_concern and state <> 'resolved'
  returning * into v_c;
  if v_c.id is null then return jsonb_build_object('ok', true, 'already', true); end if;
  return jsonb_build_object('ok', true, 'concern_id', v_c.id);
end;
$$;
revoke all on function public.support_resolve_concern(uuid, text) from public, anon;
grant execute on function public.support_resolve_concern(uuid, text) to authenticated;

select pg_notify('pgrst', 'reload schema');
