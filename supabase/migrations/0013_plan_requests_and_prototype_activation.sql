-- ============================================================
-- Corrective stage — richer plan requests, safe Member profile access,
-- consent messages, prototype activation, adult-only signup and the
-- plan-schedule conflict preview.
--
-- Additive only. RLS stays on everywhere. No chat, MFA, identity
-- verification or admin tooling is built here — those are documented
-- future milestones (see docs/TRUST_AND_SAFETY.md, docs/CHAT_SCOPE.md).
-- ============================================================

-- ============================================================
-- 1. Consent messages on conversation plans
--    (messages attached to the request/response — NOT a chat thread)
-- ============================================================
alter table public.conversation_plans
  add column request_message text
    check (request_message is null or char_length(request_message) <= 1000),
  add column response_message text
    check (response_message is null or char_length(response_message) <= 1000);

-- The requester may edit their message while the plan is still requested.
create or replace function public.update_plan_request_message(
  p_plan uuid,
  p_message text
)
returns public.conversation_plans
language plpgsql security definer
set search_path = ''
as $$
declare v public.conversation_plans;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.conversation_plans where id = p_plan for update;
  if v.id is null or not app_private.can_read_plan(p_plan) then
    raise exception 'Plan not found';
  end if;
  if not (v.created_by_account_id = auth.uid()
          or app_private.can_act_for_member(v.member_profile_id)) then
    raise exception 'Only the requester can edit this message';
  end if;
  if v.status <> 'requested' then
    raise exception 'message_locked: the message can no longer be changed';
  end if;
  update public.conversation_plans
     set request_message = nullif(trim(coalesce(p_message, '')), ''),
         updated_at = now()
   where id = p_plan
  returning * into v;
  return v;
end;
$$;
revoke all on function public.update_plan_request_message(uuid, text) from public, anon;
grant execute on function public.update_plan_request_message(uuid, text) to authenticated;

-- ============================================================
-- 2. Safe Member profile for plan participants.
--    Explicit columns only — never select *. Access requires a live plan
--    between this Member and a Companion the caller can edit.
-- ============================================================
create or replace function public.get_plan_member_profile(p_plan uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v public.conversation_plans;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.conversation_plans where id = p_plan;
  -- The COMPANION side of this specific plan, while it is still relevant.
  if v.id is null
     or not app_private.can_edit_profile(v.companion_profile_id)
     or v.status not in ('requested', 'active', 'paused') then
    raise exception 'Profile not available';
  end if;

  return (
    select jsonb_build_object(
      'plan_id', v.id,
      'first_name', p.first_name,
      'last_initial', left(p.last_name, 1),
      'avatar_path', p.avatar_path,
      'avatar_color', p.avatar_color,
      'age_band', p.age_band,          -- broad range only, as disclosed
      'region', p.region,              -- broad region only
      'bio', p.bio,
      'languages', p.languages,
      'interests', coalesce((
        select array_agg(i.name order by i.name)
        from public.profile_interests pi
        join public.interests i on i.id = pi.interest_id
        where pi.profile_id = p.id
      ), '{}'),
      'preferred_duration_minutes', mp.preferred_duration_minutes,
      'preferred_days', mp.preferred_days,
      'preferred_dayparts', mp.preferred_dayparts,
      'conversation_style', mp.preferred_companion_style,
      -- Accessibility notes are conversation-relevant and consented at
      -- signup ("good to know"); never legal identity or contact data.
      'accessibility_needs', p.accessibility_needs,
      -- Who asked: the Member themselves, or a Coordinator on their behalf.
      -- First name only; never account ids, emails or surnames.
      'requested_by_is_member', exists (
        select 1 from public.profile_access pa
        where pa.profile_id = v.member_profile_id
          and pa.account_id = v.created_by_account_id
          and pa.access_role = 'owner'
      ),
      'requested_by_first_name', coalesce((
        select rp.first_name
        from public.profiles rp
        join public.profile_access pa2
          on pa2.profile_id = rp.id and pa2.access_role = 'owner'
        where pa2.account_id = v.created_by_account_id
          and rp.role = 'coordinator'
        limit 1
      ), p.first_name),
      'requested_at', v.created_at
    )
    from public.profiles p
    left join public.member_profiles mp on mp.profile_id = p.id
    where p.id = v.member_profile_id
  );
end;
$$;
revoke all on function public.get_plan_member_profile(uuid) from public, anon;
grant execute on function public.get_plan_member_profile(uuid) to authenticated;

-- ============================================================
-- 3. Prototype activation (NOT identity verification)
--
-- Audit result: profiles are already created active with owner
-- can_book=true — no approval gate blocks booking. What was wrong:
--  a) some early companion profiles have NO companion_profiles row, so
--     discovery metadata (accepting, verification_status) is NULL;
--  b) the UI badge presented 'pending'/'unverified' as if approval were
--     required. The badge becomes "Profile active" (see UI change); the
--     stored verification fields remain for the future workflow.
--
-- Backfill legitimate prototype profiles; NEVER touch suspended/hidden.
-- ============================================================
insert into public.companion_profiles (profile_id)
select p.id from public.profiles p
where p.role = 'companion'
  and p.profile_status = 'active'
  and not exists (select 1 from public.companion_profiles cp where cp.profile_id = p.id);

update public.profiles
   set profile_status = 'active'
 where profile_status = 'pending_review';
-- 'suspended' and 'hidden' are deliberate states and are left untouched.

-- Configuration boundary for the future Trust & Safety milestone: when a
-- real identity workflow exists, booking/plan functions will consult this
-- flag. It is FALSE for the prototype and nothing reads it yet, so
-- flipping it later is a controlled change, not a rewrite.
alter table public.platform_config
  add column require_identity_verification boolean not null default false;

-- ============================================================
-- 4. Adults only (18+), every role, enforced centrally in the database.
--    The browser sends a date of birth; the SERVER decides the age.
-- ============================================================
create or replace function app_private.enforce_adult_dob()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.date_of_birth is not null
     and new.date_of_birth > (current_date - interval '18 years') then
    raise exception 'under_18: you must be at least 18 to use this service';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function app_private.enforce_adult_dob() from public, anon, authenticated;
drop trigger if exists private_details_adult on public.profile_private_details;
create trigger private_details_adult
  before insert or update on public.profile_private_details
  for each row execute function app_private.enforce_adult_dob();

-- ============================================================
-- 5. Plan-schedule conflict preview (four-week window)
--
-- Classifies each proposed weekly slot BEFORE a plan is requested or
-- accepted: 'available' | 'one_off_conflict' | 'recurring_conflict'.
-- Conflicts consider BOTH participants' active bookings — the same rule
-- the exclusion constraints enforce at insert time. Postgres remains the
-- final authority; this is the honest preview of what it will say.
-- ============================================================
create or replace function public.preview_plan_schedule(
  p_member uuid,
  p_companion uuid,
  p_duration integer,
  p_slots jsonb
)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  s jsonb;
  v_day integer;
  v_time time;
  v_tz text;
  v_d date;
  v_last date;
  v_start timestamptz;
  v_end timestamptz;
  v_conflict boolean;
  v_occurrences jsonb;
  v_conflicts integer;
  v_total integer;
  v_result jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not (app_private.can_act_for_member(p_member)
          or app_private.can_edit_profile(p_companion)) then
    raise exception 'Not available';
  end if;

  select cp.timezone into v_tz from public.companion_profiles cp
    where cp.profile_id = p_companion;
  v_tz := coalesce(v_tz, 'Europe/London');

  for s in select * from jsonb_array_elements(coalesce(p_slots, '[]'::jsonb)) loop
    v_day := (s->>'day')::integer;
    v_time := (s->>'time')::time;
    v_occurrences := '[]'::jsonb;
    v_conflicts := 0;
    v_total := 0;

    v_d := (now() at time zone v_tz)::date;
    v_last := ((now() + interval '28 days') at time zone v_tz)::date;
    while v_d <= v_last loop
      if extract(isodow from v_d)::int = v_day then
        v_start := (v_d + v_time) at time zone v_tz;
        v_end := v_start + make_interval(mins => p_duration);
        if v_start > now() then
          v_total := v_total + 1;
          -- The SAME overlap rule the exclusion constraints enforce:
          -- either participant busy in an active status blocks the time.
          select exists (
            select 1 from public.bookings b
            where b.status in ('requested', 'confirmed', 'change_proposed')
              and b.starts_at < v_end and b.ends_at > v_start
              and (b.companion_profile_id = p_companion
                   or b.member_profile_id = p_member)
          ) into v_conflict;
          if v_conflict then v_conflicts := v_conflicts + 1; end if;
          v_occurrences := v_occurrences || jsonb_build_object(
            'starts_at', v_start, 'conflict', v_conflict
          );
        end if;
      end if;
      v_d := v_d + 1;
    end loop;

    v_result := v_result || jsonb_build_object(
      'day', v_day,
      'time', to_char(v_time, 'HH24:MI'),
      'occurrences', v_occurrences,
      'conflicts', v_conflicts,
      'classification', case
        when v_conflicts = 0 then 'available'
        when v_conflicts = 1 and v_total > 1 then 'one_off_conflict'
        else 'recurring_conflict'
      end
    );
  end loop;
  return v_result;
end;
$$;
revoke all on function public.preview_plan_schedule(uuid, uuid, integer, jsonb) from public, anon;
grant execute on function public.preview_plan_schedule(uuid, uuid, integer, jsonb) to authenticated;

-- ============================================================
-- 6. Plan lifecycle re-definitions (identical behaviour + messages and
--    the recurring-conflict acceptance guard)
-- ============================================================

-- create: gains the optional request message (trimmed, ≤1000).
create or replace function public.create_conversation_plan(
  p_member uuid,
  p_companion uuid,
  p_frequency integer,
  p_duration integer,
  p_method text,
  p_slots jsonb,
  p_message text default null
)
returns public.conversation_plans
language plpgsql security definer
set search_path = ''
as $$
declare
  v_price integer;
  v_methods text[];
  v_accepting boolean;
  v_tz text;
  v_purchase uuid;
  v_plan public.conversation_plans;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not app_private.can_act_for_member(p_member) then
    raise exception 'You cannot book for this member';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_member and p.role = 'member') then
    raise exception 'invalid_slots: plans are for member profiles';
  end if;
  if not (app_private.is_discoverable_companion(p_companion)
          or app_private.has_profile_access(p_companion)) then
    raise exception 'Companion not available';
  end if;
  if p_frequency is null or p_frequency < 1 or p_frequency > 7 then
    raise exception 'invalid_frequency: choose between 1 and 7 conversations per week';
  end if;

  select cp.is_accepting_new_members, cp.timezone into v_accepting, v_tz
  from public.companion_profiles cp where cp.profile_id = p_companion;
  if coalesce(v_accepting, false) is not true then
    raise exception 'This companion is not accepting new members right now';
  end if;

  select * into v_price, v_methods from app_private.plan_unit_price(p_companion, p_duration);
  if v_price is null then
    raise exception 'price_unavailable: this companion has no %-minute conversation rate yet', p_duration;
  end if;

  insert into public.package_purchases (
    buyer_account_id, member_profile_id, companion_profile_id, package_offer_id,
    title, conversation_count, duration_minutes, price_minor, currency, is_simulated
  ) values (
    auth.uid(), p_member, p_companion, null,
    'Conversation plan allowance', p_frequency, p_duration, v_price, 'GBP', true
  ) returning id into v_purchase;

  begin
    insert into public.conversation_plans (
      member_profile_id, companion_profile_id, created_by_account_id,
      frequency_per_week, duration_minutes, communication_method,
      per_conversation_price_minor, weekly_price_minor, allowance_purchase_id,
      request_message
    ) values (
      p_member, p_companion, auth.uid(),
      p_frequency, p_duration, 'in_app',
      v_price, v_price * p_frequency, v_purchase,
      nullif(trim(coalesce(p_message, '')), '')
    ) returning * into v_plan;
  exception when unique_violation then
    raise exception 'plan_exists: there is already a conversation plan with this companion';
  end;

  perform app_private.replace_plan_slots(v_plan.id, p_companion, p_duration, p_frequency, coalesce(v_tz, 'Europe/London'), p_slots);
  return v_plan;
end;
$$;
revoke all on function public.create_conversation_plan(uuid, uuid, integer, integer, text, jsonb, text) from public, anon;
grant execute on function public.create_conversation_plan(uuid, uuid, integer, integer, text, jsonb, text) to authenticated;

-- accept: optional response message + the recurring-conflict guard.
-- Acceptance must NEVER silently deliver a structurally broken schedule.
create or replace function public.accept_plan(p_plan uuid, p_message text default null)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.conversation_plans;
  v_preview jsonb;
  v_slot jsonb;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.conversation_plans where id = p_plan for update;
  if v.id is null or not app_private.can_read_plan(p_plan) then
    raise exception 'Plan not found';
  end if;
  if not app_private.can_edit_profile(v.companion_profile_id) then
    raise exception 'Only the companion can accept a plan';
  end if;
  if v.status <> 'requested' then
    raise exception 'plan_not_active: this plan is %', v.status;
  end if;

  -- A weekly time that conflicts repeatedly is structurally unavailable:
  -- acceptance is refused rather than silently generating fewer
  -- conversations than requested. One-off conflicts remain acceptable —
  -- they are logged, surfaced and reserve no credit.
  select public.preview_plan_schedule(
    v.member_profile_id, v.companion_profile_id, v.duration_minutes,
    (select coalesce(jsonb_agg(jsonb_build_object(
        'day', ps.iso_day, 'time', to_char(ps.local_time, 'HH24:MI'))), '[]'::jsonb)
     from public.plan_schedule_slots ps where ps.plan_id = p_plan)
  ) into v_preview;
  for v_slot in select * from jsonb_array_elements(v_preview) loop
    if v_slot->>'classification' = 'recurring_conflict' then
      raise exception 'recurring_conflict: the weekly time on day % at % is no longer available',
        v_slot->>'day', v_slot->>'time';
    end if;
  end loop;

  update public.conversation_plans
     set status = 'active',
         response_message = nullif(trim(coalesce(p_message, '')), ''),
         updated_at = now()
   where id = p_plan;
  return public.extend_plan_bookings(p_plan) || jsonb_build_object('preview', v_preview);
end;
$$;
revoke all on function public.accept_plan(uuid, text) from public, anon;
grant execute on function public.accept_plan(uuid, text) to authenticated;

-- decline: optional response message (otherwise identical to 0011).
create or replace function public.decline_plan(p_plan uuid, p_reason text default null)
returns public.conversation_plans
language plpgsql security definer
set search_path = ''
as $$
declare v public.conversation_plans;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.conversation_plans where id = p_plan for update;
  if v.id is null or not app_private.can_read_plan(p_plan) then
    raise exception 'Plan not found';
  end if;
  if not app_private.can_edit_profile(v.companion_profile_id) then
    raise exception 'Only the companion can decline a plan';
  end if;
  if v.status <> 'requested' then
    raise exception 'plan_not_active: this plan is %', v.status;
  end if;
  update public.conversation_plans
     set status = 'declined',
         end_reason = p_reason,
         response_message = nullif(trim(coalesce(p_reason, '')), ''),
         ended_at = now(), updated_at = now()
   where id = p_plan returning * into v;
  return v;
end;
$$;
