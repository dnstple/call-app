-- ============================================================
-- Stage 2E4A — recurring conversation plans (wrap-not-rewrite).
--
-- A plan is an ongoing relationship: one Member ↔ one Companion, a weekly
-- rhythm (frequency × duration × method × weekly schedule) and a weekly
-- SIMULATED price (frequency × the companion's snapshotted
-- per-conversation rate). The Companion accepts the PLAN once; generated
-- occurrences become CONFIRMED bookings inside a rolling 4-week window.
--
-- Credits: each plan owns a HIDDEN backing package_purchases row (its
-- allowance account). Every generated occurrence writes grant(1) +
-- reserve(1); completion converts to consume; cancel/skip releases —
-- the entire 0009 engine is reused untouched, and released credits are
-- what make one-off rebooking of a missed occurrence possible.
--
-- Material changes (frequency, duration, method, schedule → weekly price)
-- require Companion re-acceptance via a pending-change proposal.
-- Occurrence-level actions (cancel/skip/reschedule/pause) never do.
--
-- Generation NEVER silently omits an occurrence: every attempt is
-- persisted in plan_generation_log ('booked' or a skipped_* outcome, with
-- no credit movement on skips) and skipped rows are retried by simply
-- calling extend_plan_bookings again.
--
-- The one-time TEST CALL is the existing trial offer: this migration
-- makes trial eligibility permanent per pair (a COMPLETED trial blocks
-- any future trial) and adds get_trial_state for the UI.
--
-- Additive only. No payment is taken anywhere. No UI in this stage.
-- ============================================================

-- ---------- plans ----------
create table public.conversation_plans (
  id uuid primary key default gen_random_uuid(),
  member_profile_id uuid not null references public.profiles(id),
  companion_profile_id uuid not null references public.profiles(id),
  created_by_account_id uuid not null references public.accounts(id),
  frequency_per_week integer not null check (frequency_per_week between 1 and 7),
  duration_minutes integer not null check (duration_minutes in (15, 30, 45, 60)),
  communication_method text not null,
  -- Server-side snapshots (weekly = frequency × per-conversation):
  per_conversation_price_minor integer not null check (per_conversation_price_minor >= 0),
  weekly_price_minor integer not null check (weekly_price_minor >= 0),
  currency text not null default 'GBP' check (currency = 'GBP'),
  status text not null default 'requested'
    check (status in ('requested', 'active', 'paused', 'ended', 'declined')),
  -- Hidden allowance account (1:1) feeding the untouched credit ledger.
  allowance_purchase_id uuid not null references public.package_purchases(id) unique,
  -- Material changes awaiting Companion re-acceptance.
  pending_change jsonb,
  -- Rolling-window watermark.
  generated_until timestamptz,
  paused_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One live plan per Member–Companion pair.
create unique index one_live_plan_per_pair
  on public.conversation_plans (member_profile_id, companion_profile_id)
  where (status in ('requested', 'active', 'paused'));
create index plans_member_idx on public.conversation_plans (member_profile_id);
create index plans_companion_idx on public.conversation_plans (companion_profile_id);

-- ---------- weekly schedule (row count = frequency) ----------
create table public.plan_schedule_slots (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.conversation_plans(id) on delete cascade,
  iso_day integer not null check (iso_day between 1 and 7),
  local_time time not null,
  timezone text not null,
  created_at timestamptz not null default now(),
  unique (plan_id, iso_day, local_time)
);

-- ---------- generation results (requirement: never silent) ----------
create table public.plan_generation_log (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.conversation_plans(id) on delete cascade,
  intended_start timestamptz not null,
  -- 'booked'                → generated (booking_id set)
  -- 'skipped_conflict'      → time taken; RETRIED by extend_plan_bookings
  -- 'skipped_availability'  → outside availability/notice; RETRIED
  -- 'skipped_paused'        → cancelled by pause/change; RETRIED on resume
  -- 'skipped_by_request'    → member skipped deliberately; NEVER retried
  outcome text not null check (outcome in
    ('booked', 'skipped_conflict', 'skipped_availability', 'skipped_paused', 'skipped_by_request')),
  booking_id uuid references public.bookings(id) on delete set null,
  detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plan_id, intended_start) -- idempotency; non-'booked' rows are retriable
);

-- ---------- bookings & purchases: plan linkage (additive) ----------
alter table public.bookings add column plan_id uuid references public.conversation_plans(id);
create index bookings_plan_idx on public.bookings (plan_id) where plan_id is not null;

-- Plan allowances have no package offer (never a fake one).
alter table public.package_purchases alter column package_offer_id drop not null;

-- Recreate the booking view to expose plan_id (b.* re-expansion).
drop view if exists public.my_bookings;
create view public.my_bookings as
select
  b.*,
  pm.first_name as member_first_name,
  left(pm.last_name, 1) as member_last_initial,
  pc.first_name as companion_first_name,
  left(pc.last_name, 1) as companion_last_initial
from public.bookings b
join public.profiles pm on pm.id = b.member_profile_id
join public.profiles pc on pc.id = b.companion_profile_id
where b.booked_by_account_id = auth.uid()
   or app_private.has_profile_access(b.member_profile_id)
   or app_private.has_profile_access(b.companion_profile_id);
grant select on public.my_bookings to authenticated;

-- ---------- RLS ----------
-- Who may act on a plan's occurrences (pause/resume/end/skip): the member
-- side (booker or can_book coordinator) or the companion's own account.
-- Read access alone is never enough.
create or replace function app_private.can_manage_plan(p_plan uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversation_plans cp
    where cp.id = p_plan
      and (
        cp.created_by_account_id = auth.uid()
        or app_private.can_act_for_member(cp.member_profile_id)
        or app_private.can_edit_profile(cp.companion_profile_id)
      )
  );
$$;

create or replace function app_private.can_read_plan(p_plan uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversation_plans cp
    where cp.id = p_plan
      and (
        cp.created_by_account_id = auth.uid()
        or app_private.has_profile_access(cp.member_profile_id)
        or app_private.has_profile_access(cp.companion_profile_id)
      )
  );
$$;
revoke all on function app_private.can_read_plan(uuid) from public, anon;
revoke all on function app_private.can_manage_plan(uuid) from public, anon;
grant execute on function app_private.can_read_plan(uuid) to authenticated;
grant execute on function app_private.can_manage_plan(uuid) to authenticated;

alter table public.conversation_plans enable row level security;
alter table public.plan_schedule_slots enable row level security;
alter table public.plan_generation_log enable row level security;

create policy "plans: participants read" on public.conversation_plans
  for select to authenticated
  using (
    created_by_account_id = auth.uid()
    or app_private.has_profile_access(member_profile_id)
    or app_private.has_profile_access(companion_profile_id)
  );
create policy "plan slots: participants read" on public.plan_schedule_slots
  for select to authenticated using (app_private.can_read_plan(plan_id));
create policy "plan log: participants read" on public.plan_generation_log
  for select to authenticated using (app_private.can_read_plan(plan_id));
-- No direct write policies anywhere: functions only.

-- ============================================================
-- Helpers
-- ============================================================

-- The companion's per-conversation rate for a duration (single offers).
create or replace function app_private.plan_unit_price(p_companion uuid, p_duration integer)
returns table (price_minor integer, methods text[])
language sql stable security definer
set search_path = ''
as $$
  select o.price_minor, o.supported_methods
  from public.conversation_offers o
  where o.companion_profile_id = p_companion
    and o.offer_type = 'single'
    and o.active
    and o.duration_minutes = p_duration
  order by o.price_minor
  limit 1;
$$;
revoke all on function app_private.plan_unit_price(uuid, integer) from public, anon, authenticated;

-- A weekly slot must sit inside a recurring availability window.
create or replace function app_private.slot_fits_recurring(
  p_companion uuid, p_day integer, p_time time, p_duration integer
)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.availability_rules ar
    where ar.companion_profile_id = p_companion
      and ar.active
      and ar.day_of_week = p_day
      and ar.start_local_time <= p_time
      and p_time + make_interval(mins => p_duration) <= ar.end_local_time
  );
$$;
revoke all on function app_private.slot_fits_recurring(uuid, integer, time, integer) from public, anon, authenticated;

-- Validate a slots payload and (re)write the schedule rows.
create or replace function app_private.replace_plan_slots(
  p_plan uuid, p_companion uuid, p_duration integer, p_frequency integer,
  p_tz text, p_slots jsonb
)
returns void
language plpgsql
set search_path = ''
as $$
declare s jsonb; v_day integer; v_time time;
begin
  if p_slots is null or jsonb_typeof(p_slots) <> 'array'
     or jsonb_array_length(p_slots) <> p_frequency then
    raise exception 'invalid_slots: choose exactly % weekly time(s)', p_frequency;
  end if;
  delete from public.plan_schedule_slots where plan_id = p_plan;
  for s in select * from jsonb_array_elements(p_slots) loop
    v_day := (s->>'day')::integer;
    v_time := (s->>'time')::time;
    if v_day is null or v_day < 1 or v_day > 7 or v_time is null then
      raise exception 'invalid_slots: each slot needs a weekday and a time';
    end if;
    if not app_private.slot_fits_recurring(p_companion, v_day, v_time, p_duration) then
      raise exception 'slot_unavailable: % is outside the companion''s weekly availability', s;
    end if;
    insert into public.plan_schedule_slots (plan_id, iso_day, local_time, timezone)
    values (p_plan, v_day, v_time, p_tz);
  end loop;
end;
$$;
revoke all on function app_private.replace_plan_slots(uuid, uuid, integer, integer, text, jsonb) from public, anon, authenticated;

-- ============================================================
-- Plan lifecycle
-- ============================================================
create or replace function public.create_conversation_plan(
  p_member uuid,
  p_companion uuid,
  p_frequency integer,
  p_duration integer,
  p_method text,
  p_slots jsonb
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
  if v_methods is not null and array_length(v_methods, 1) is not null
     and not (p_method = any (v_methods)) then
    raise exception 'invalid_method: that call method is not offered';
  end if;

  -- Hidden allowance account: is_simulated, no package offer, no upfront
  -- credits (grants arrive per generated occurrence).
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
      per_conversation_price_minor, weekly_price_minor, allowance_purchase_id
    ) values (
      p_member, p_companion, auth.uid(),
      p_frequency, p_duration, p_method,
      v_price, v_price * p_frequency, v_purchase
    ) returning * into v_plan;
  exception when unique_violation then
    raise exception 'plan_exists: there is already a conversation plan with this companion';
  end;

  perform app_private.replace_plan_slots(v_plan.id, p_companion, p_duration, p_frequency, coalesce(v_tz, 'Europe/London'), p_slots);
  return v_plan;
end;
$$;

-- ============================================================
-- Rolling 4-week occurrence generation (idempotent + retriable).
-- ============================================================
create or replace function public.extend_plan_bookings(p_plan uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.conversation_plans;
  v_slot record;
  v_day date;
  v_start timestamptz;
  v_end timestamptz;
  v_horizon timestamptz;
  v_log public.plan_generation_log;
  v_booking uuid;
  v_generated integer := 0;
  v_skipped integer := 0;
  v_retried integer := 0;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.conversation_plans where id = p_plan for update;
  if v.id is null or not app_private.can_read_plan(p_plan) then
    raise exception 'Plan not found';
  end if;
  if v.status <> 'active' then
    raise exception 'plan_not_active: this plan is %', v.status;
  end if;
  -- Serialise credit movement with the rest of the engine.
  perform 1 from public.package_purchases where id = v.allowance_purchase_id for update;

  v_horizon := now() + interval '28 days';

  for v_slot in select * from public.plan_schedule_slots where plan_id = p_plan loop
    v_day := (now() at time zone v_slot.timezone)::date;
    while v_day <= (v_horizon at time zone v_slot.timezone)::date loop
      if extract(isodow from v_day)::int = v_slot.iso_day then
        v_start := (v_day + v_slot.local_time) at time zone v_slot.timezone;
        v_end := v_start + make_interval(mins => v.duration_minutes);
        if v_start > now() and v_start <= v_horizon then
          select * into v_log from public.plan_generation_log
            where plan_id = p_plan and intended_start = v_start;
          if v_log.id is not null
             and v_log.outcome in ('booked', 'skipped_by_request') then
            -- already generated, or deliberately skipped: never regenerate
            null;
          else
            if v_log.id is not null then v_retried := v_retried + 1; end if;
            -- Attempt (or retry) this occurrence. NO credit moves on failure.
            begin
              if not app_private.slot_within_availability(v.companion_profile_id, v_start, v_end) then
                raise exception using errcode = 'P2E41', message = 'outside availability, notice or horizon';
              end if;
              insert into public.bookings (
                member_profile_id, companion_profile_id, booked_by_account_id,
                offer_id, package_purchase_id, booking_source, plan_id,
                starts_at, ends_at, timezone, communication_method, status,
                duration_minutes, price_minor, currency, platform_fee_rate,
                platform_fee_minor, companion_amount_minor, is_trial
              ) values (
                v.member_profile_id, v.companion_profile_id, v.created_by_account_id,
                null, v.allowance_purchase_id, 'package_credit', v.id,
                v_start, v_end, v_slot.timezone, v.communication_method, 'confirmed',
                v.duration_minutes, v.per_conversation_price_minor, v.currency, 0, 0,
                v.per_conversation_price_minor, false
              ) returning id into v_booking;

              insert into public.booking_status_history (booking_id, previous_status, new_status, changed_by_account_id, reason)
              values (v_booking, null, 'confirmed', auth.uid(), 'Generated by conversation plan');

              -- Allowance: grant + reserve as a pair (net zero until settled).
              insert into public.package_credit_ledger (package_purchase_id, entry_type, quantity, created_by_account_id, reason)
              values (v.allowance_purchase_id, 'grant', 1, auth.uid(), 'Weekly plan allowance');
              insert into public.package_credit_ledger (package_purchase_id, booking_id, entry_type, quantity, created_by_account_id, reason)
              values (v.allowance_purchase_id, v_booking, 'reserve', 1, auth.uid(), 'Reserved for plan conversation');

              insert into public.plan_generation_log (plan_id, intended_start, outcome, booking_id)
              values (p_plan, v_start, 'booked', v_booking)
              on conflict (plan_id, intended_start) do update
                set outcome = 'booked', booking_id = excluded.booking_id,
                    detail = null, updated_at = now();
              v_generated := v_generated + 1;
            exception
              when exclusion_violation then
                insert into public.plan_generation_log (plan_id, intended_start, outcome, detail)
                values (p_plan, v_start, 'skipped_conflict', 'Time already taken')
                on conflict (plan_id, intended_start) do update
                  set outcome = 'skipped_conflict', detail = 'Time already taken', updated_at = now();
                v_skipped := v_skipped + 1;
              when sqlstate 'P2E41' then
                insert into public.plan_generation_log (plan_id, intended_start, outcome, detail)
                values (p_plan, v_start, 'skipped_availability', 'Outside availability, notice or horizon')
                on conflict (plan_id, intended_start) do update
                  set outcome = 'skipped_availability', detail = 'Outside availability, notice or horizon', updated_at = now();
                v_skipped := v_skipped + 1;
            end;
          end if;
        end if;
      end if;
      v_day := v_day + 1;
    end loop;
  end loop;

  update public.conversation_plans
     set generated_until = v_horizon, updated_at = now()
   where id = p_plan;

  return jsonb_build_object(
    'plan_id', p_plan, 'generated', v_generated, 'skipped', v_skipped,
    'retried', v_retried, 'generated_until', v_horizon
  );
end;
$$;

-- Cancel this plan's FUTURE occurrences (credits release; log rows become
-- retriable so resume/regeneration can rebook them).
create or replace function app_private.cancel_future_plan_bookings(p_plan uuid, p_reason text)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare v_b record; v_count integer := 0;
begin
  for v_b in
    select id, status from public.bookings
    where plan_id = p_plan
      and starts_at > now()
      and status in ('requested', 'confirmed', 'change_proposed')
    for update
  loop
    update public.bookings
       set status = 'cancelled', cancellation_reason = p_reason,
           cancelled_by_account_id = auth.uid(), cancelled_at = now(), updated_at = now()
     where id = v_b.id;
    perform app_private.record_transition(v_b.id, v_b.status, 'cancelled', p_reason);
    perform app_private.settle_package_credit(v_b.id, 'release');
    update public.plan_generation_log
       set outcome = 'skipped_paused', booking_id = null,
           detail = p_reason, updated_at = now()
     where plan_id = p_plan and booking_id = v_b.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function app_private.cancel_future_plan_bookings(uuid, text) from public, anon, authenticated;

create or replace function public.accept_plan(p_plan uuid)
returns jsonb
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
    raise exception 'Only the companion can accept a plan';
  end if;
  if v.status <> 'requested' then
    raise exception 'plan_not_active: this plan is %', v.status;
  end if;
  update public.conversation_plans set status = 'active', updated_at = now() where id = p_plan;
  return public.extend_plan_bookings(p_plan);
end;
$$;

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
     set status = 'declined', end_reason = p_reason, ended_at = now(), updated_at = now()
   where id = p_plan returning * into v;
  return v;
end;
$$;

-- Pause / resume / end: occurrence-level effects only — never re-acceptance.
create or replace function public.pause_plan(p_plan uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare v public.conversation_plans; v_cancelled integer;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.conversation_plans where id = p_plan for update;
  if v.id is null or not app_private.can_read_plan(p_plan) then
    raise exception 'Plan not found';
  end if;
  if not app_private.can_manage_plan(p_plan) then
    raise exception 'You cannot manage this plan';
  end if;
  if v.status <> 'active' then
    raise exception 'plan_not_active: this plan is %', v.status;
  end if;
  update public.conversation_plans
     set status = 'paused', paused_at = now(), updated_at = now() where id = p_plan;
  v_cancelled := app_private.cancel_future_plan_bookings(p_plan, 'Plan paused');
  return jsonb_build_object('plan_id', p_plan, 'status', 'paused', 'cancelled', v_cancelled);
end;
$$;

create or replace function public.resume_plan(p_plan uuid)
returns jsonb
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
  if not app_private.can_manage_plan(p_plan) then
    raise exception 'You cannot manage this plan';
  end if;
  if v.status <> 'paused' then
    raise exception 'plan_not_active: this plan is %', v.status;
  end if;
  update public.conversation_plans
     set status = 'active', paused_at = null, updated_at = now() where id = p_plan;
  return public.extend_plan_bookings(p_plan);
end;
$$;

create or replace function public.end_plan(p_plan uuid, p_reason text default null)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare v public.conversation_plans; v_cancelled integer;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.conversation_plans where id = p_plan for update;
  if v.id is null or not app_private.can_read_plan(p_plan) then
    raise exception 'Plan not found';
  end if;
  if not app_private.can_manage_plan(p_plan) then
    raise exception 'You cannot manage this plan';
  end if;
  if v.status not in ('requested', 'active', 'paused') then
    raise exception 'plan_not_active: this plan is %', v.status;
  end if;
  update public.conversation_plans
     set status = 'ended', ended_at = now(), end_reason = p_reason, updated_at = now()
   where id = p_plan;
  v_cancelled := app_private.cancel_future_plan_bookings(p_plan, coalesce(p_reason, 'Plan ended'));
  return jsonb_build_object('plan_id', p_plan, 'status', 'ended', 'cancelled', v_cancelled);
end;
$$;

-- Skip one week (occurrence-level; no re-acceptance).
create or replace function public.skip_plan_week(p_plan uuid, p_week_start date)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare v public.conversation_plans; v_b record; v_count integer := 0;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.conversation_plans where id = p_plan for update;
  if v.id is null or not app_private.can_read_plan(p_plan) then
    raise exception 'Plan not found';
  end if;
  if not app_private.can_manage_plan(p_plan) then
    raise exception 'You cannot manage this plan';
  end if;
  for v_b in
    select id, status from public.bookings
    where plan_id = p_plan
      and starts_at >= p_week_start::timestamptz
      and starts_at < (p_week_start + 7)::timestamptz
      and starts_at > now()
      and status in ('requested', 'confirmed', 'change_proposed')
    for update
  loop
    update public.bookings
       set status = 'cancelled', cancellation_reason = 'Skipped this week',
           cancelled_by_account_id = auth.uid(), cancelled_at = now(), updated_at = now()
     where id = v_b.id;
    perform app_private.record_transition(v_b.id, v_b.status, 'cancelled', 'Skipped this week');
    perform app_private.settle_package_credit(v_b.id, 'release');
    -- 'skipped_by_request' is deliberate: extend_plan_bookings never
    -- regenerates it, unlike conflict/availability/pause skips.
    update public.plan_generation_log
       set outcome = 'skipped_by_request', booking_id = null,
           detail = 'Skipped by request', updated_at = now()
     where plan_id = p_plan and booking_id = v_b.id;
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('plan_id', p_plan, 'skipped', v_count);
end;
$$;

-- ============================================================
-- Material changes — require Companion re-acceptance.
-- ============================================================
create or replace function public.propose_plan_change(
  p_plan uuid,
  p_frequency integer default null,
  p_duration integer default null,
  p_method text default null,
  p_slots jsonb default null
)
returns public.conversation_plans
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.conversation_plans;
  v_freq integer; v_dur integer; v_method text;
  v_price integer; v_methods text[];
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.conversation_plans where id = p_plan for update;
  if v.id is null or not app_private.can_read_plan(p_plan) then
    raise exception 'Plan not found';
  end if;
  if not (v.created_by_account_id = auth.uid()
          or app_private.can_act_for_member(v.member_profile_id)) then
    raise exception 'Only the member side can propose plan changes';
  end if;
  if v.status not in ('active', 'paused') then
    raise exception 'plan_not_active: this plan is %', v.status;
  end if;

  v_freq := coalesce(p_frequency, v.frequency_per_week);
  v_dur := coalesce(p_duration, v.duration_minutes);
  v_method := coalesce(p_method, v.communication_method);
  if v_freq < 1 or v_freq > 7 then
    raise exception 'invalid_frequency: choose between 1 and 7 conversations per week';
  end if;
  if p_slots is null and (v_freq <> v.frequency_per_week) then
    raise exception 'invalid_slots: a new frequency needs a matching weekly schedule';
  end if;

  select * into v_price, v_methods from app_private.plan_unit_price(v.companion_profile_id, v_dur);
  if v_price is null then
    raise exception 'price_unavailable: this companion has no %-minute conversation rate yet', v_dur;
  end if;
  if v_methods is not null and array_length(v_methods, 1) is not null
     and not (v_method = any (v_methods)) then
    raise exception 'invalid_method: that call method is not offered';
  end if;

  update public.conversation_plans set
    pending_change = jsonb_build_object(
      'frequency_per_week', v_freq,
      'duration_minutes', v_dur,
      'communication_method', v_method,
      'per_conversation_price_minor', v_price,
      'weekly_price_minor', v_price * v_freq,
      'slots', p_slots,
      'proposed_by_account_id', auth.uid(),
      'proposed_at', now()
    ),
    updated_at = now()
  where id = p_plan
  returning * into v;
  return v;
end;
$$;

create or replace function public.accept_plan_change(p_plan uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.conversation_plans;
  c jsonb;
  v_tz text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.conversation_plans where id = p_plan for update;
  if v.id is null or not app_private.can_read_plan(p_plan) then
    raise exception 'Plan not found';
  end if;
  if not app_private.can_edit_profile(v.companion_profile_id) then
    raise exception 'Only the companion can accept plan changes';
  end if;
  if v.pending_change is null then
    raise exception 'no_pending_change: there is nothing to accept';
  end if;
  c := v.pending_change;

  update public.conversation_plans set
    frequency_per_week = (c->>'frequency_per_week')::integer,
    duration_minutes = (c->>'duration_minutes')::integer,
    communication_method = c->>'communication_method',
    per_conversation_price_minor = (c->>'per_conversation_price_minor')::integer,
    weekly_price_minor = (c->>'weekly_price_minor')::integer,
    pending_change = null,
    updated_at = now()
  where id = p_plan;

  if c->'slots' is not null and jsonb_typeof(c->'slots') = 'array' then
    select cp.timezone into v_tz from public.companion_profiles cp
      where cp.profile_id = v.companion_profile_id;
    perform app_private.replace_plan_slots(
      p_plan, v.companion_profile_id,
      (c->>'duration_minutes')::integer, (c->>'frequency_per_week')::integer,
      coalesce(v_tz, 'Europe/London'), c->'slots');
  end if;

  -- Regenerate the future window on the new terms (old occurrences release
  -- their credits; skipped/removed slots are logged, never silent).
  perform app_private.cancel_future_plan_bookings(p_plan, 'Plan schedule changed');
  delete from public.plan_generation_log
    where plan_id = p_plan and intended_start > now() and outcome <> 'booked';
  if v.status = 'active' then
    return public.extend_plan_bookings(p_plan);
  end if;
  return jsonb_build_object('plan_id', p_plan, 'status', v.status, 'generated', 0);
end;
$$;

create or replace function public.decline_plan_change(p_plan uuid)
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
    raise exception 'Only the companion can decline plan changes';
  end if;
  update public.conversation_plans set pending_change = null, updated_at = now()
   where id = p_plan returning * into v;
  return v;
end;
$$;

-- ============================================================
-- Engine adjustments (full re-definitions; behaviour otherwise identical)
-- ============================================================

-- 1. Plan-backed allowances never auto-flip to exhausted (rolling).
create or replace function app_private.settle_package_credit(
  p_booking uuid,
  p_mode text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.bookings;
  v_consumed integer;
begin
  select * into v from public.bookings where id = p_booking;
  if v.package_purchase_id is null then
    return;
  end if;
  perform 1 from public.package_purchases where id = v.package_purchase_id for update;
  if not exists (
    select 1 from public.package_credit_ledger
    where booking_id = p_booking and entry_type = 'reserve'
  ) then
    return;
  end if;
  if exists (
    select 1 from public.package_credit_ledger
    where booking_id = p_booking and entry_type = 'consume'
  ) then
    return;
  end if;

  if p_mode = 'release' then
    if not exists (
      select 1 from public.package_credit_ledger
      where booking_id = p_booking and entry_type = 'release'
    ) then
      insert into public.package_credit_ledger
        (package_purchase_id, booking_id, entry_type, quantity, reason)
      values
        (v.package_purchase_id, p_booking, 'release', 1, 'Reservation released — booking declined or cancelled');
    end if;
    return;
  end if;

  if p_mode = 'consume' then
    if not exists (
      select 1 from public.package_credit_ledger
      where booking_id = p_booking and entry_type = 'release'
    ) then
      insert into public.package_credit_ledger
        (package_purchase_id, booking_id, entry_type, quantity, reason)
      values
        (v.package_purchase_id, p_booking, 'release', 1, 'Reservation converted on completion');
    end if;
    insert into public.package_credit_ledger
      (package_purchase_id, booking_id, entry_type, quantity, reason)
    values
      (v.package_purchase_id, p_booking, 'consume', 1, 'Conversation completed');

    -- Fixed-size packages exhaust; PLAN allowances are rolling and never do.
    if not exists (
      select 1 from public.conversation_plans cpl
      where cpl.allowance_purchase_id = v.package_purchase_id
    ) then
      select coalesce(sum(quantity), 0) into v_consumed
      from public.package_credit_ledger
      where package_purchase_id = v.package_purchase_id and entry_type = 'consume';
      update public.package_purchases pp
         set status = 'exhausted', updated_at = now()
       where pp.id = v.package_purchase_id
         and pp.status = 'active'
         and v_consumed >= pp.conversation_count;
    end if;
  end if;
end;
$$;
revoke all on function app_private.settle_package_credit(uuid, text) from public, anon, authenticated;

-- 2. One TEST CALL per pair, EVER: a completed trial permanently blocks
--    another (full re-definition of 0005's create_booking_request with the
--    single added rule; everything else identical).
create or replace function public.create_booking_request(
  p_member uuid,
  p_offer uuid,
  p_starts_at timestamptz,
  p_method text
)
returns public.bookings
language plpgsql security definer
set search_path = ''
as $$
declare
  v_offer public.conversation_offers;
  v_companion uuid;
  v_accepting boolean;
  v_tz text;
  v_ends timestamptz;
  v_rate numeric(5, 2);
  v_fee integer;
  v_booking public.bookings;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not app_private.can_act_for_member(p_member) then
    raise exception 'You cannot book for this member';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_member and p.role = 'member') then
    raise exception 'Bookings are for member profiles';
  end if;

  select o.* into v_offer from public.conversation_offers o where o.id = p_offer and o.active;
  if v_offer.id is null then raise exception 'Offer not available'; end if;
  v_companion := v_offer.companion_profile_id;

  select cp.is_accepting_new_members, cp.timezone into v_accepting, v_tz
  from public.companion_profiles cp where cp.profile_id = v_companion;
  if coalesce(v_accepting, false) is not true then
    raise exception 'This companion is not accepting new members right now';
  end if;

  if array_length(v_offer.supported_methods, 1) is not null
     and not (p_method = any (v_offer.supported_methods)) then
    raise exception 'That call method is not offered';
  end if;

  -- Stage 2E4A: the test call is once per pair, permanently.
  if v_offer.offer_type = 'trial' and exists (
    select 1 from public.bookings b
    where b.member_profile_id = p_member
      and b.companion_profile_id = v_companion
      and b.is_trial
      and b.status = 'completed'
  ) then
    raise exception 'trial_used: the test call with this companion has already happened';
  end if;

  v_ends := p_starts_at + make_interval(mins => v_offer.duration_minutes);

  if not app_private.slot_within_availability(v_companion, p_starts_at, v_ends) then
    raise exception 'outside_availability: that time is not within the companion''s availability';
  end if;

  select case when v_offer.offer_type = 'trial'
              then pc.trial_commission_pct else pc.standard_commission_pct end
    into v_rate
  from public.platform_config pc limit 1;
  v_rate := coalesce(v_rate, 2);
  v_fee := round(v_offer.price_minor * v_rate / 100);

  begin
    insert into public.bookings (
      member_profile_id, companion_profile_id, booked_by_account_id, offer_id,
      starts_at, ends_at, timezone, communication_method, status,
      duration_minutes, price_minor, currency, platform_fee_rate,
      platform_fee_minor, companion_amount_minor, is_trial
    ) values (
      p_member, v_companion, auth.uid(), v_offer.id,
      p_starts_at, v_ends, coalesce(v_tz, 'Europe/London'), p_method, 'requested',
      v_offer.duration_minutes, v_offer.price_minor, v_offer.currency, v_rate,
      v_fee, v_offer.price_minor - v_fee, v_offer.offer_type = 'trial'
    )
    returning * into v_booking;
  exception
    when exclusion_violation then
      raise exception 'slot_taken: that time has just been taken';
    when unique_violation then
      raise exception 'trial_pending: a trial with this companion is already requested';
  end;

  insert into public.booking_status_history (booking_id, previous_status, new_status, changed_by_account_id)
  values (v_booking.id, null, 'requested', auth.uid());

  return v_booking;
end;
$$;

-- 3. Manual bookings against a plan allowance carry the plan_id and
--    require the plan to be active (full re-definition of 0009's function
--    with those two additions; everything else identical).
create or replace function public.create_package_booking_request(
  p_purchase uuid,
  p_starts_at timestamptz,
  p_method text
)
returns public.bookings
language plpgsql security definer
set search_path = ''
as $$
declare
  v_p public.package_purchases;
  v_plan public.conversation_plans;
  v_methods text[];
  v_tz text;
  v_ends timestamptz;
  v_remaining integer;
  v_price integer;
  v_rate numeric(5, 2);
  v_fee integer;
  v_booking public.bookings;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  select * into v_p from public.package_purchases where id = p_purchase for update;
  if v_p.id is null or not app_private.can_read_purchase(p_purchase) then
    raise exception 'package_mismatch: package not found';
  end if;
  if not app_private.can_act_for_member(v_p.member_profile_id) then
    raise exception 'You cannot book for this member';
  end if;
  if v_p.status <> 'active' then
    raise exception 'package_inactive: this package is % and cannot be used', v_p.status;
  end if;

  select * into v_plan from public.conversation_plans
   where allowance_purchase_id = v_p.id;
  if v_plan.id is not null and v_plan.status <> 'active' then
    raise exception 'plan_not_active: this plan is %', v_plan.status;
  end if;

  if v_p.package_offer_id is not null then
    select po.supported_methods into v_methods
    from public.package_offers po where po.id = v_p.package_offer_id;
    if v_methods is not null and array_length(v_methods, 1) is not null
       and not (p_method = any (v_methods)) then
      raise exception 'invalid_method: that call method is not offered with this package';
    end if;
  end if;

  select coalesce(sum(case
      when entry_type in ('grant', 'release', 'adjustment') then quantity
      else -quantity
    end), 0)
  into v_remaining
  from public.package_credit_ledger
  where package_purchase_id = v_p.id;
  if v_remaining < 1 then
    raise exception 'no_credit: this package has no conversations left';
  end if;

  select cp.timezone into v_tz
  from public.companion_profiles cp where cp.profile_id = v_p.companion_profile_id;
  v_ends := p_starts_at + make_interval(mins => v_p.duration_minutes);

  if not app_private.slot_within_availability(v_p.companion_profile_id, p_starts_at, v_ends) then
    raise exception 'outside_availability: that time is not within the companion''s availability';
  end if;

  v_price := round(v_p.price_minor::numeric / v_p.conversation_count);
  select pc.standard_commission_pct into v_rate from public.platform_config pc limit 1;
  v_rate := coalesce(v_rate, 2);
  v_fee := round(v_price * v_rate / 100);

  begin
    insert into public.bookings (
      member_profile_id, companion_profile_id, booked_by_account_id,
      offer_id, package_purchase_id, booking_source, plan_id,
      starts_at, ends_at, timezone, communication_method, status,
      duration_minutes, price_minor, currency, platform_fee_rate,
      platform_fee_minor, companion_amount_minor, is_trial
    ) values (
      v_p.member_profile_id, v_p.companion_profile_id, auth.uid(),
      null, v_p.id, 'package_credit', v_plan.id,
      p_starts_at, v_ends, coalesce(v_tz, 'Europe/London'), p_method, 'requested',
      v_p.duration_minutes, v_price, v_p.currency, v_rate,
      v_fee, v_price - v_fee, false
    )
    returning * into v_booking;
  exception
    when exclusion_violation then
      raise exception 'slot_taken: that time has just been taken';
  end;

  insert into public.booking_status_history (booking_id, previous_status, new_status, changed_by_account_id)
  values (v_booking.id, null, 'requested', auth.uid());

  insert into public.package_credit_ledger
    (package_purchase_id, booking_id, entry_type, quantity, created_by_account_id, reason)
  values
    (v_p.id, v_booking.id, 'reserve', 1, auth.uid(), 'Reserved for booking request');

  return v_booking;
end;
$$;

-- ============================================================
-- Test-call state (for the profile UI).
-- ============================================================
create or replace function public.get_trial_state(p_member uuid, p_companion uuid)
returns text
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not (app_private.can_act_for_member(p_member)
          or app_private.can_edit_profile(p_companion)) then
    raise exception 'Not found';
  end if;
  if exists (
    select 1 from public.bookings b
    where b.member_profile_id = p_member and b.companion_profile_id = p_companion
      and b.is_trial and b.status = 'completed'
  ) then
    return 'used';
  end if;
  if exists (
    select 1 from public.bookings b
    where b.member_profile_id = p_member and b.companion_profile_id = p_companion
      and b.is_trial and b.status in ('requested', 'confirmed', 'change_proposed')
  ) then
    return 'pending';
  end if;
  return 'available';
end;
$$;

-- ---------- grants ----------
revoke all on function public.create_conversation_plan(uuid, uuid, integer, integer, text, jsonb) from public, anon;
revoke all on function public.extend_plan_bookings(uuid) from public, anon;
revoke all on function public.accept_plan(uuid) from public, anon;
revoke all on function public.decline_plan(uuid, text) from public, anon;
revoke all on function public.pause_plan(uuid) from public, anon;
revoke all on function public.resume_plan(uuid) from public, anon;
revoke all on function public.end_plan(uuid, text) from public, anon;
revoke all on function public.skip_plan_week(uuid, date) from public, anon;
revoke all on function public.propose_plan_change(uuid, integer, integer, text, jsonb) from public, anon;
revoke all on function public.accept_plan_change(uuid) from public, anon;
revoke all on function public.decline_plan_change(uuid) from public, anon;
revoke all on function public.get_trial_state(uuid, uuid) from public, anon;
grant execute on function public.create_conversation_plan(uuid, uuid, integer, integer, text, jsonb) to authenticated;
grant execute on function public.extend_plan_bookings(uuid) to authenticated;
grant execute on function public.accept_plan(uuid) to authenticated;
grant execute on function public.decline_plan(uuid, text) to authenticated;
grant execute on function public.pause_plan(uuid) to authenticated;
grant execute on function public.resume_plan(uuid) to authenticated;
grant execute on function public.end_plan(uuid, text) to authenticated;
grant execute on function public.skip_plan_week(uuid, date) to authenticated;
grant execute on function public.propose_plan_change(uuid, integer, integer, text, jsonb) to authenticated;
grant execute on function public.accept_plan_change(uuid) to authenticated;
grant execute on function public.decline_plan_change(uuid) to authenticated;
grant execute on function public.get_trial_state(uuid, uuid) to authenticated;
