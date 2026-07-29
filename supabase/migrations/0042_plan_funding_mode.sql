-- ============================================================
-- 2G5B lifecycle correction — explicit plan funding mode (migration 0042).
--
-- Root cause of "a billed plan generates NOTHING until funded" failing:
-- accept_plan invoked extend_plan_bookings on acceptance, and generation used
-- billing_enabled=false as the marker for the legacy simulated self-grant path.
-- A newly requested plan (billing not yet activated) therefore ran through the
-- simulated path on acceptance, generating/attempting occurrences before any
-- real funding, and the availability check ran BEFORE the funding gate — so an
-- unfunded window logged skipped_availability rows as well as skipped_unfunded.
--
-- Correction (additive):
--   * An explicit, server-controlled funding_mode replaces billing_enabled as
--     the generation marker. Existing rows are LEGACY 'simulated' (unchanged
--     self-granting engine). Newly created plans are 'recurring' and can never
--     enter the self-granting path.
--   * accept_plan validates the companion, transitions to accepted, runs the
--     recurring-conflict check and notifies the coordinator. It does NOT
--     generate for recurring plans; only explicitly-marked legacy 'simulated'
--     plans still generate on acceptance.
--   * extend_plan_bookings checks the funding gate FIRST for recurring plans
--     (unfunded ⇒ only skipped_unfunded), self-grants ONLY for 'simulated'.
--   * activate_plan_billing / process_plan_renewals apply only to 'recurring'
--     plans. Completion, cancellation, package settlement and earnings paths
--     are untouched.
-- ============================================================

-- ------------------------------------------------------------
-- 0. Explicit funding mode. Existing rows keep the legacy simulated engine;
--    the column is server-controlled (no client grant to write it directly —
--    conversation_plans already denies direct client writes via RLS).
-- ------------------------------------------------------------
alter table public.conversation_plans
  add column if not exists funding_mode text not null default 'simulated'
    check (funding_mode in ('simulated', 'recurring'));

-- ------------------------------------------------------------
-- 1. create_conversation_plan — new plans are 'recurring' (never self-grant).
--    Body identical to 0013 except the funding_mode on the plan insert.
-- ------------------------------------------------------------
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
      request_message, funding_mode
    ) values (
      p_member, p_companion, auth.uid(),
      p_frequency, p_duration, 'in_app',
      v_price, v_price * p_frequency, v_purchase,
      nullif(trim(coalesce(p_message, '')), ''), 'recurring'
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

-- ------------------------------------------------------------
-- 2. accept_plan — validate companion, transition, conflict-check, notify.
--    Recurring plans NEVER generate on acceptance (no self-grant, no reserve,
--    no extend_plan_bookings). Only legacy 'simulated' plans still generate
--    on acceptance, preserving the prototype engine for marked legacy plans.
-- ------------------------------------------------------------
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
  -- Idempotent: an already-accepted plan is a safe no-op for the companion.
  if v.status = 'active' then
    return jsonb_build_object('ok', true, 'repeat', true, 'plan_id', p_plan, 'status', 'active');
  end if;
  if v.status <> 'requested' then
    raise exception 'plan_not_active: this plan is %', v.status;
  end if;

  -- A weekly time that conflicts repeatedly is structurally unavailable:
  -- acceptance is refused rather than silently generating fewer conversations.
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

  -- Notify the coordinator (plan payer) — deterministic, deduped.
  perform app_private.notify_account(
    v.created_by_account_id, 'plan_accepted', 'Plan accepted',
    'Your companion accepted the conversation plan. Set up monthly billing to begin.',
    null, 'plan-accepted:' || p_plan::text);

  -- Recurring (paid) plans generate NOTHING on acceptance: no booking, no
  -- self-granted allowance, no reservation. Generation happens only once the
  -- coordinator activates billing and a renewal funds the allowance.
  if v.funding_mode = 'simulated' then
    return public.extend_plan_bookings(p_plan) || jsonb_build_object('preview', v_preview);
  end if;
  return jsonb_build_object('ok', true, 'plan_id', p_plan, 'status', 'active',
                            'generated', 0, 'skipped', 0, 'preview', v_preview);
end;
$$;
revoke all on function public.accept_plan(uuid, text) from public, anon;
grant execute on function public.accept_plan(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 3. extend_plan_bookings — funding gate FIRST for recurring plans (unfunded
--    windows log ONLY skipped_unfunded, never skipped_availability); self-grant
--    ONLY for legacy 'simulated' plans. Body otherwise identical to 0040.
-- ------------------------------------------------------------
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
            null; -- already generated, or deliberately skipped: never regenerate
          else
            if v_log.id is not null then v_retried := v_retried + 1; end if;
            begin
              -- 2G5B: a recurring (billed) plan may only book what its funded
              -- allowance covers. Checked BEFORE availability so an unfunded
              -- window records ONLY skipped_unfunded.
              if v.funding_mode = 'recurring'
                 and app_private.plan_allowance_remaining(v.allowance_purchase_id) < 1 then
                raise exception using errcode = 'P2E42', message = 'no funded allowance credit';
              end if;
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

              -- Legacy 'simulated' plans self-fund exactly as before (grant +
              -- reserve). Recurring plans DRAW DOWN the funded allowance only
              -- (reserve), never self-granting.
              if v.funding_mode = 'simulated' then
                insert into public.package_credit_ledger (package_purchase_id, entry_type, quantity, created_by_account_id, reason)
                values (v.allowance_purchase_id, 'grant', 1, auth.uid(), 'Weekly plan allowance');
              end if;
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
              when sqlstate 'P2E42' then
                insert into public.plan_generation_log (plan_id, intended_start, outcome, detail)
                values (p_plan, v_start, 'skipped_unfunded', 'Awaiting this month’s plan payment')
                on conflict (plan_id, intended_start) do update
                  set outcome = 'skipped_unfunded', detail = 'Awaiting this month’s plan payment', updated_at = now();
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

-- ------------------------------------------------------------
-- 4. activate_plan_billing — recurring plans only. Legacy simulated plans are
--    self-funding and are never billed. Body otherwise identical to 0041.
-- ------------------------------------------------------------
create or replace function public.activate_plan_billing(p_plan uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.conversation_plans;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  select * into v from public.conversation_plans where id = p_plan for update;
  if v.id is null or v.created_by_account_id <> auth.uid() then
    raise exception 'not_found: plan';
  end if;
  if v.funding_mode <> 'recurring' then
    -- Legacy simulated plans self-fund; billing does not apply to them.
    raise exception 'not_found: plan';
  end if;
  if v.billing_enabled then
    return jsonb_build_object('ok', true, 'repeat', true, 'billing_enabled', true);
  end if;
  if v.status <> 'active' then
    raise exception 'plan_not_active: the plan must be accepted before billing can start';
  end if;
  -- Usable payment method required — never enable billing without one.
  if not exists (
    select 1 from public.stripe_customers
    where account_id = auth.uid() and payment_method_ready = true
  ) then
    raise exception 'payment_method_required: add a payment method before enabling billing';
  end if;

  update public.conversation_plans set billing_enabled = true, updated_at = now()
   where id = p_plan;
  return jsonb_build_object('ok', true, 'billing_enabled', true);
end;
$$;
revoke all on function public.activate_plan_billing(uuid) from public, anon;
grant execute on function public.activate_plan_billing(uuid) to authenticated;

-- ------------------------------------------------------------
-- 5. process_plan_renewals — recurring plans only (defence in depth; billing
--    activation already restricts billing_enabled to recurring plans).
-- ------------------------------------------------------------
create or replace function public.process_plan_renewals()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_period date := date_trunc('month', now())::date;
  v_count integer := 0;
  v_errors text := '';
begin
  for v_row in
    select p.id
    from public.conversation_plans p
    where p.status = 'active' and p.billing_enabled and p.funding_mode = 'recurring'
      and not exists (
        select 1 from public.plan_billing_periods bp
        where bp.plan_id = p.id and bp.period_start = v_period
          and bp.status in ('paid', 'processing', 'payment_pending', 'action_required', 'closed'))
    limit 100
    for update of p skip locked
  loop
    begin
      perform public.renew_plan_billing_period(v_row.id, v_period);
      v_count := v_count + 1;
    exception when others then
      v_errors := v_errors || v_row.id::text || ': ' || sqlerrm || '; ';
    end;
  end loop;
  return jsonb_build_object('period', v_period, 'processed', v_count, 'errors', nullif(v_errors, ''));
end;
$$;
revoke all on function public.process_plan_renewals() from public, anon, authenticated;
grant execute on function public.process_plan_renewals() to service_role;

select pg_notify('pgrst', 'reload schema');
