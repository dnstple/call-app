-- ============================================================
-- 2G5B — recurring-billing charge engine (migration 0040).
-- Decision: monthly billing TOPS UP the existing plan allowance. Billed plans
-- reserve occurrences against the billing-granted balance (no self-grant);
-- unbilled/mock plans keep the current simulated self-grant, unchanged.
--
-- Money flow: 2G5A period math → occurrence count → subtotal − 10% discount
-- → account credit FIRST → off-session card for the remainder → on SUCCESS
-- grant exactly `occurrences` allowance credits. Allowance is NEVER granted
-- before a confirmed finalisation. Reuses the 2G2 order + credit-reservation +
-- finalisation + webhook infrastructure. No transfers/payouts (that is 2G6).
--
-- Additive only. Redefinitions (create-or-replace) keep every existing branch
-- byte-identical and only ADD the plan-billing paths.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Mark a plan as stripe-billed. Default false = today's simulated plans
--    keep self-granting; only opted-in plans are recurring-billed.
-- ------------------------------------------------------------
alter table public.conversation_plans
  add column if not exists billing_enabled boolean not null default false;

-- ------------------------------------------------------------
-- 2. Billing-period: extra states + audit references for 2G5B.
-- ------------------------------------------------------------
alter table public.plan_billing_periods
  drop constraint if exists plan_billing_periods_status_check;
alter table public.plan_billing_periods
  add constraint plan_billing_periods_status_check check (status in
    ('draft', 'preview', 'payment_pending', 'processing', 'paid', 'payment_failed',
     'action_required', 'partially_credited', 'closed'));
alter table public.plan_billing_periods
  add column if not exists allowance_purchase_id uuid references public.package_purchases(id);
alter table public.plan_billing_periods
  add column if not exists allowance_credits_granted integer not null default 0
    check (allowance_credits_granted >= 0);
alter table public.plan_billing_periods
  add column if not exists failure_reason text;

-- ------------------------------------------------------------
-- 3. Allowance remaining (grant − net-reserved − consumed). Internal.
--    Matches the deployed balance formula (0018) so the settlement machinery
--    (reserve/release/consume) stays UNCHANGED.
-- ------------------------------------------------------------
create or replace function app_private.plan_allowance_remaining(p_purchase uuid)
returns integer
language sql stable security definer
set search_path = ''
as $$
  select coalesce(sum(quantity) filter (where entry_type in ('grant', 'adjustment')), 0)
       - (coalesce(sum(quantity) filter (where entry_type = 'reserve'), 0)
          - coalesce(sum(quantity) filter (where entry_type = 'release'), 0))
       - coalesce(sum(quantity) filter (where entry_type = 'consume'), 0)
  from public.package_credit_ledger
  where package_purchase_id = p_purchase;
$$;
revoke all on function app_private.plan_allowance_remaining(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. Occurrence generation — REDEFINED additively. For billing_enabled plans
--    it reserves against the funded balance and NEVER self-grants; an unfunded
--    occurrence is skipped (retriable) instead of manufactured. Unbilled plans
--    are byte-identical to 0011. New retriable outcome: 'skipped_unfunded'.
-- ------------------------------------------------------------
alter table public.plan_generation_log drop constraint if exists plan_generation_log_outcome_check;
alter table public.plan_generation_log add constraint plan_generation_log_outcome_check
  check (outcome in ('booked', 'skipped_conflict', 'skipped_availability',
                     'skipped_paused', 'skipped_by_request', 'skipped_unfunded'));

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
              if not app_private.slot_within_availability(v.companion_profile_id, v_start, v_end) then
                raise exception using errcode = 'P2E41', message = 'outside availability, notice or horizon';
              end if;
              -- 2G5B: a billed plan may only book what its funded allowance covers.
              if v.billing_enabled
                 and app_private.plan_allowance_remaining(v.allowance_purchase_id) < 1 then
                raise exception using errcode = 'P2E42', message = 'no funded allowance credit';
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

              -- Billed plans DRAW DOWN the funded allowance (reserve only);
              -- unbilled plans self-fund exactly as before (grant + reserve).
              if not v.billing_enabled then
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
-- 5. Finalisation — REDEFINED additively. plan_period orders TOP UP the
--    allowance (grant exactly `occurrences` credits, idempotently) instead of
--    inserting a booking; the trial/one_off booking path is byte-identical.
-- ------------------------------------------------------------
create or replace function app_private.finalise_paid_order(
  p_order uuid, p_outcome text, p_intent text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.payment_orders;
  v_booking uuid;
  v_bp public.plan_billing_periods;
begin
  select * into v_order from public.payment_orders where id = p_order for update;
  if v_order.id is null then return; end if;
  if v_order.status not in ('pending', 'requires_action', 'processing') then return; end if;

  -- ---- 2G5B: recurring plan billing → allowance top-up (no booking) ----
  if v_order.order_type = 'plan_period' then
    if p_outcome = 'succeeded' then
      update public.payment_orders
         set status = 'succeeded',
             stripe_payment_intent_id = coalesce(p_intent, stripe_payment_intent_id),
             updated_at = now()
       where id = p_order;
      select * into v_bp from public.plan_billing_periods where payment_order_id = p_order;
      -- Grant EXACTLY the calculated occurrence count, once (never fewer).
      if v_bp.id is not null and v_bp.occurrences_count > 0
         and not exists (select 1 from public.package_credit_ledger
                         where package_purchase_id = v_bp.allowance_purchase_id
                           and reason = 'plan-billing:' || p_order::text) then
        insert into public.package_credit_ledger
          (package_purchase_id, entry_type, quantity, created_by_account_id, reason)
        values (v_bp.allowance_purchase_id, 'grant', v_bp.occurrences_count,
                v_order.coordinator_account_id, 'plan-billing:' || p_order::text);
      end if;
      if v_bp.id is not null then
        update public.plan_billing_periods
           set status = 'paid', allowance_credits_granted = occurrences_count, updated_at = now()
         where id = v_bp.id;
      end if;
      perform app_private.notify_account(
        v_order.coordinator_account_id, 'plan_billed', 'Plan payment received',
        'This month’s plan conversations are funded and ready to schedule.',
        null, 'plan-billed:' || p_order::text);
    else
      update public.payment_orders
         set status = case when p_outcome = 'expired' then 'expired' else 'failed' end,
             failure_reason = p_outcome, updated_at = now()
       where id = p_order;
      if v_order.credit_applied_minor > 0 then
        perform public.issue_account_credit(
          v_order.coordinator_account_id, v_order.credit_applied_minor,
          'platform_failure', v_order.id,
          'Reservation released: plan payment did not complete', 'release-' || v_order.id::text);
      end if;
      update public.plan_billing_periods
         set status = 'payment_failed', failure_reason = p_outcome, updated_at = now()
       where payment_order_id = p_order;
      perform app_private.notify_account(
        v_order.coordinator_account_id, 'plan_billing_failed', 'Plan payment didn’t go through',
        'We couldn’t take payment for your plan this month. Please review your payment method.',
        null, 'plan-billing-failed:' || p_order::text);
    end if;
    return;
  end if;

  -- ---- unchanged: single trial / one-off funded booking ----
  if p_outcome = 'succeeded' then
    update public.payment_orders
       set status = 'succeeded',
           stripe_payment_intent_id = coalesce(p_intent, stripe_payment_intent_id),
           updated_at = now()
     where id = p_order;
    insert into public.bookings
      (member_profile_id, companion_profile_id, booked_by_account_id, offer_id,
       starts_at, ends_at, timezone, communication_method, status, duration_minutes,
       price_minor, currency, platform_fee_rate, platform_fee_minor,
       companion_amount_minor, is_trial)
    values
      (v_order.member_profile_id, v_order.companion_profile_id,
       v_order.coordinator_account_id, v_order.offer_id,
       v_order.starts_at, v_order.starts_at + make_interval(mins => v_order.duration_minutes),
       'Europe/London', 'in_app', 'requested', v_order.duration_minutes,
       v_order.subtotal_minor, 'GBP', v_order.commission_rate_pct,
       v_order.commission_minor,
       v_order.subtotal_minor - v_order.commission_minor, v_order.order_type = 'trial')
    returning id into v_booking;
    update public.payment_orders set booking_id = v_booking where id = p_order;
  else
    update public.payment_orders
       set status = case when p_outcome = 'expired' then 'expired' else 'failed' end,
           failure_reason = p_outcome, updated_at = now()
     where id = p_order;
    if v_order.credit_applied_minor > 0 then
      perform public.issue_account_credit(
        v_order.coordinator_account_id, v_order.credit_applied_minor,
        'platform_failure', v_order.id,
        'Reservation released: payment did not complete', 'release-' || v_order.id::text);
    end if;
  end if;
end;
$$;
revoke all on function app_private.finalise_paid_order(uuid, text, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 6. Renewal engine (service-role). Idempotent per (plan, period_start).
--    Prices the period, reserves account credit FIRST, and — when credit fully
--    covers it — finalises with NO Stripe. A card remainder is left in
--    'payment_pending' for the stripe-billing Edge Function to charge
--    off-session; the existing webhook finalises async events.
-- ------------------------------------------------------------
create or replace function public.renew_plan_billing_period(p_plan uuid, p_period_start date)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_plan public.conversation_plans;
  v_bp public.plan_billing_periods;
  v_end date;
  v_occ integer;
  v_per integer;
  v_gross integer;
  v_discount integer;
  v_net integer;
  v_credit integer;
  v_applied integer := 0;
  v_card integer;
  v_order public.payment_orders;
  v_order_id uuid;
  v_key text;
begin
  select * into v_plan from public.conversation_plans where id = p_plan for update;
  if v_plan.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if not v_plan.billing_enabled then return jsonb_build_object('ok', false, 'reason', 'not_billed'); end if;

  -- Only one worker per period; a settled/in-flight period is a safe no-op.
  select * into v_bp from public.plan_billing_periods
   where plan_id = p_plan and period_start = p_period_start for update;
  if v_bp.id is not null and v_bp.status in
     ('paid', 'processing', 'payment_pending', 'action_required', 'closed') then
    return jsonb_build_object('ok', true, 'repeat', true, 'status', v_bp.status, 'period_id', v_bp.id);
  end if;

  v_end := app_private.monthly_period_end(p_period_start);
  v_per := v_plan.per_conversation_price_minor;
  select count(*)::integer into v_occ
    from public.plan_schedule_slots s
    join generate_series(p_period_start, (v_end - 1), interval '1 day') d(day)
      on extract(isodow from d.day)::int = s.iso_day
    where s.plan_id = p_plan;
  v_gross := v_occ * v_per;
  v_discount := (v_gross * 10) / 100;
  v_net := v_gross - v_discount;

  -- No occurrences → nothing to bill; record a closed zero period.
  if v_net = 0 then
    insert into public.plan_billing_periods
      (plan_id, coordinator_account_id, period_start, period_end, status,
       occurrences_count, gross_minor, discount_minor, net_minor,
       credit_applied_minor, card_amount_minor, allowance_purchase_id)
    values (p_plan, v_plan.created_by_account_id, p_period_start, v_end, 'closed',
            0, 0, 0, 0, 0, 0, v_plan.allowance_purchase_id)
    on conflict (plan_id, period_start) do update set status = 'closed', updated_at = now()
    returning * into v_bp;
    return jsonb_build_object('ok', true, 'status', 'closed', 'occurrences', 0, 'period_id', v_bp.id);
  end if;

  v_key := 'plan-bill-' || p_plan::text || '-' || p_period_start::text;
  insert into public.payment_orders
    (coordinator_account_id, member_profile_id, companion_profile_id, plan_id,
     order_type, status, subtotal_minor, discount_minor, service_fee_minor,
     credit_applied_minor, card_amount_minor, total_minor,
     commission_rate_pct, commission_minor, idempotency_key, expires_at)
  values
    (v_plan.created_by_account_id, v_plan.member_profile_id, v_plan.companion_profile_id, p_plan,
     'plan_period', 'pending', v_gross, v_discount, 0,
     0, v_net, v_net, 0, 0, v_key, now() + interval '3 days')
  on conflict (idempotency_key) do nothing
  returning * into v_order;
  if v_order.id is null then
    select * into v_order from public.payment_orders where idempotency_key = v_key;
  end if;
  v_order_id := v_order.id;

  -- Credit FIRST (FIFO, idempotent). Reserve now; released on failure.
  select coalesce(sum(remaining_minor), 0)::integer into v_credit
    from public.credit_ledger
   where coordinator_account_id = v_plan.created_by_account_id
     and entry_type = 'credit' and remaining_minor > 0
     and (expires_at is null or expires_at > now());
  if v_credit > 0 then
    v_applied := public.spend_account_credit(
      v_plan.created_by_account_id, least(v_credit, v_net), 'plan_renewal',
      v_order_id, v_order_id, 'Reserved for plan billing period', 'spend-' || v_order_id::text);
  end if;
  v_card := v_net - v_applied;
  update public.payment_orders
     set credit_applied_minor = v_applied, card_amount_minor = v_card, updated_at = now()
   where id = v_order_id;

  insert into public.plan_billing_periods
    (plan_id, coordinator_account_id, period_start, period_end, status,
     occurrences_count, gross_minor, discount_minor, net_minor,
     credit_applied_minor, card_amount_minor, allowance_purchase_id, payment_order_id)
  values (p_plan, v_plan.created_by_account_id, p_period_start, v_end,
          case when v_card = 0 then 'processing' else 'payment_pending' end,
          v_occ, v_gross, v_discount, v_net, v_applied, v_card,
          v_plan.allowance_purchase_id, v_order_id)
  on conflict (plan_id, period_start) do update set
    status = case when v_card = 0 then 'processing' else 'payment_pending' end,
    occurrences_count = v_occ, gross_minor = v_gross, discount_minor = v_discount, net_minor = v_net,
    credit_applied_minor = v_applied, card_amount_minor = v_card,
    payment_order_id = v_order_id, updated_at = now()
  returning * into v_bp;

  -- Fully covered by credit → finalise now (NO Stripe), grant the allowance.
  if v_card = 0 then
    perform app_private.finalise_paid_order(v_order_id, 'succeeded', null);
    select * into v_bp from public.plan_billing_periods where id = v_bp.id;
  end if;

  return jsonb_build_object('ok', true, 'period_id', v_bp.id, 'order_id', v_order_id,
    'status', v_bp.status, 'occurrences', v_occ, 'net_minor', v_net,
    'credit_applied_minor', v_applied, 'card_amount_minor', v_card);
end;
$$;
revoke all on function public.renew_plan_billing_period(uuid, date) from public, anon, authenticated;
grant execute on function public.renew_plan_billing_period(uuid, date) to service_role;

-- ------------------------------------------------------------
-- 7. Renewal orchestrator (service-role). Bills the current calendar month for
--    every active billed plan that has no settled/in-flight period yet. One
--    worker per plan via SKIP LOCKED; each renewal independently idempotent.
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
    where p.status = 'active' and p.billing_enabled
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

-- ------------------------------------------------------------
-- 8. Schedule daily where pg_cron is available (guarded + idempotent). The
--    Edge Function charges the card remainder for 'payment_pending' periods.
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('process-plan-renewals', '0 6 * * *',
      $cron$select public.process_plan_renewals();$cron$);
    raise notice 'Scheduled process_plan_renewals() daily at 06:00 via pg_cron.';
  else
    raise notice 'pg_cron unavailable — run select public.process_plan_renewals(); on a schedule.';
  end if;
exception when others then
  raise notice 'pg_cron registration skipped (%). Invoke process_plan_renewals() manually.', sqlerrm;
end $$;
