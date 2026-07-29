-- ============================================================
-- Restore completion & earning semantics (migration 0068).
--
-- Additive corrective migration over the immutable 0001–0067 baseline. 0067
-- added the correct new invariant (a booking must be ACCEPTED, status
-- 'confirmed', to attend/earn) but built two functions from STALE bodies,
-- silently reverting migration 0046's cumulative behaviour:
--
--   * app_private.ensure_companion_earning — 0067 used the 0034 body, dropping
--     0046's Path B (recurring-plan occurrence funding via plan_billing_periods),
--     the payer_charge_minor / plan_id / plan_billing_period_id snapshots, and
--     the fix that resolves the Companion owner from the BOOKING
--     (v_b.companion_profile_id) rather than the order. Effect: a CONFIRMED,
--     funded booking (one-off orders created by the real RPCs, or recurring-plan
--     occurrences) produced NO earning → submit_companion_attendance raised
--     'not_eligible: this conversation has no real payment to release', cascading
--     into the 2G4E / 2G6A / 2G6B / 2G6C / 2G6D suites.
--
--   * public.resolve_unconfirmed_attendance — 0067 used the 0037 body, dropping
--     0046's broadened funding eligibility (succeeded order OR paid recurring
--     billing period).
--
-- This migration redefines BOTH functions from the actual latest cumulative
-- (0046) body and adds ONLY the new invariant at the narrowest safe choke point
-- (booking.status = 'confirmed'). It restores every one-off AND recurring-plan
-- branch, the payer_charge / plan snapshots, held-for-issue behaviour and
-- idempotent creation. It does NOT reintroduce the requested-booking defect.
--
-- The other 0067 redefinitions are already correct against their latest bodies
-- (submit_companion_attendance ← 0035; create_companion_attendance_reminders and
-- create_review_prompts ← 0037) and are intentionally NOT touched here.
--
-- No schema change, no data change, no cron, no worker, no Stripe call.
-- ============================================================

-- ------------------------------------------------------------
-- 1. ensure_companion_earning — the 0046 cumulative body (Path A one-off/trial +
--    Path B recurring-plan occurrence), with the confirmed-status invariant added
--    at the top (fails CLOSED for any non-accepted booking).
-- ------------------------------------------------------------
create or replace function app_private.ensure_companion_earning(p_booking uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_b public.bookings;
  v_order public.payment_orders;
  v_plan public.conversation_plans;
  v_period public.plan_billing_periods;
  v_companion_account uuid;
  v_basis integer;
  v_rate numeric;
  v_commission integer;
  v_net integer;
  v_charge integer;
  v_plan_id uuid := null;
  v_period_id uuid := null;
  v_id uuid;
begin
  select id into v_id from public.companion_earnings where booking_id = p_booking;
  if v_id is not null then return v_id; end if;

  select * into v_b from public.bookings where id = p_booking;
  if v_b.id is null then return null; end if;

  -- INVARIANT (0067/0068): only an ACCEPTED (confirmed) booking may ever earn.
  -- A requested/declined/cancelled/change_proposed booking never earns, even
  -- when funded. This is the narrowest safe choke point — it precedes BOTH the
  -- one-off and recurring-plan funding paths below.
  if v_b.status <> 'confirmed' then
    return null;
  end if;

  -- Path A: a directly-funded booking (one-off / trial) — snapshot from order.
  select * into v_order from public.payment_orders
   where booking_id = p_booking and provider = 'stripe_test' and status = 'succeeded'
   for update;
  if v_order.id is not null then
    v_basis      := v_order.subtotal_minor - v_order.discount_minor;
    v_rate       := v_order.commission_rate_pct;
    v_commission := v_order.commission_minor;
    v_net        := v_order.subtotal_minor - v_order.discount_minor - v_order.commission_minor;
    v_charge     := v_order.total_minor;
  else
    -- Path B: a recurring-plan occurrence funded by a PAID billing period.
    if v_b.plan_id is null or v_b.booking_source <> 'package_credit' then
      return null; -- simulation / unfunded / non-plan: NO earning, ever.
    end if;
    select * into v_plan from public.conversation_plans where id = v_b.plan_id;
    if v_plan.id is null or v_plan.funding_mode <> 'recurring' then
      return null; -- legacy simulated plans are prototype-only: no real money.
    end if;
    -- The calendar month's period must be settled ('paid') and its funding
    -- order genuinely succeeded before the companion can earn.
    select * into v_period from public.plan_billing_periods
     where plan_id = v_b.plan_id and status = 'paid'
       and period_start = date_trunc('month', (v_b.starts_at at time zone v_b.timezone))::date
     for update;
    if v_period.id is null or v_period.payment_order_id is null
       or v_period.occurrences_count < 1 then
      return null; -- month not yet billed → not financially eligible yet.
    end if;
    select * into v_order from public.payment_orders where id = v_period.payment_order_id;
    if v_order.id is null or v_order.status <> 'succeeded' then
      return null;
    end if;
    v_basis      := v_b.price_minor;                 -- server-snapshotted, never client-supplied
    v_rate       := v_b.platform_fee_rate;
    v_commission := v_b.platform_fee_minor;
    v_net        := v_b.companion_amount_minor;      -- the booking's snapshotted companion amount
    v_charge     := round(v_period.net_minor::numeric / v_period.occurrences_count)::integer;
    v_plan_id    := v_b.plan_id;
    v_period_id  := v_period.id;
  end if;

  select pa.account_id into v_companion_account
  from public.profile_access pa
  where pa.profile_id = v_b.companion_profile_id
    and pa.access_role = 'owner' and pa.consent_status <> 'withdrawn'
  limit 1;
  if v_companion_account is null then return null; end if;

  insert into public.companion_earnings
    (booking_id, payment_order_id, companion_account_id, companion_profile_id,
     member_profile_id, payer_account_id, basis_minor, commission_rate_pct,
     commission_minor, net_minor, plan_id, plan_billing_period_id, payer_charge_minor)
  values
    (p_booking, v_order.id, v_companion_account, v_b.companion_profile_id,
     v_b.member_profile_id, v_order.coordinator_account_id,
     v_basis, v_rate, v_commission, v_net, v_plan_id, v_period_id, v_charge)
  on conflict (booking_id) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.companion_earnings where booking_id = p_booking;
  end if;
  return v_id;
end;
$$;
revoke all on function app_private.ensure_companion_earning(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. resolve_unconfirmed_attendance — the 0046 cumulative body (accepts a
--    succeeded order OR a paid recurring billing period), with the eligibility
--    gate tightened to accepted bookings only.
-- ------------------------------------------------------------
create or replace function public.resolve_unconfirmed_attendance()
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_comp integer;
  v_mem integer;
  v_earning uuid;
  v_companion_account uuid;
  v_member_name text;
  v_companion_name text;
  v_count integer := 0;
begin
  for v_row in
    select b.id as booking_id, b.ends_at, b.booked_by_account_id,
           b.member_profile_id, b.companion_profile_id
    from public.bookings b
    where b.ends_at + interval '24 hours' <= now()
      and b.status = 'confirmed'                     -- INVARIANT: accepted bookings only
      and not exists (select 1 from public.conversation_attendance a where a.booking_id = b.id)
      and not exists (select 1 from public.conversation_issues i
                      where i.booking_id = b.id and i.state <> 'resolved')
      and (
        exists (select 1 from public.payment_orders po
                where po.booking_id = b.id and po.provider = 'stripe_test' and po.status = 'succeeded')
        or exists (
          select 1
          from public.conversation_plans p
          join public.plan_billing_periods bp on bp.plan_id = p.id
          where p.id = b.plan_id and p.funding_mode = 'recurring'
            and bp.status = 'paid'
            and bp.period_start = date_trunc('month', (b.starts_at at time zone b.timezone))::date)
      )
    limit 100
    for update of b skip locked
  loop
    v_earning := app_private.ensure_companion_earning(v_row.booking_id);
    if v_earning is null then continue; end if;

    select companion_account_id into v_companion_account
      from public.companion_earnings where id = v_earning;
    select first_name into v_member_name from public.profiles where id = v_row.member_profile_id;
    select first_name into v_companion_name from public.profiles where id = v_row.companion_profile_id;

    select coalesce(sum(duration_seconds), 0) into v_comp
      from public.call_attendance_segments
      where booking_id = v_row.booking_id and side = 'companion';
    select coalesce(sum(duration_seconds), 0) into v_mem
      from public.call_attendance_segments
      where booking_id = v_row.booking_id and side = 'member';

    if v_comp >= 120 and v_mem >= 120 then
      insert into public.conversation_attendance
        (booking_id, outcome, source, explanation)
      values (v_row.booking_id, 'took_place', 'system',
              'Apparent completion from trusted attendance')
      on conflict (booking_id) do nothing;
      perform app_private.make_earning_payable(v_earning);
      perform app_private.notify_account(
        v_companion_account, 'conversation_completed', 'Conversation completed',
        'We confirmed the conversation attendance from the call record.',
        v_row.booking_id, 'fallback-completed:' || v_row.booking_id::text);
      perform app_private.notify_account(
        v_row.booked_by_account_id, 'conversation_completed', 'Conversation completed',
        'The conversation between ' || coalesce(v_member_name, 'the member') || ' and '
          || coalesce(v_companion_name, 'the companion') || ' has been marked as completed.',
        v_row.booking_id, 'fallback-completed:' || v_row.booking_id::text);

    elsif v_comp >= 600 and v_mem < 120 then
      insert into public.conversation_attendance
        (booking_id, outcome, source, explanation)
      values (v_row.booking_id, 'member_no_show', 'system',
              'Likely Member no-show from trusted attendance')
      on conflict (booking_id) do nothing;
      perform app_private.make_earning_payable(v_earning);
      perform app_private.notify_account(
        v_companion_account, 'attendance_confirmed', 'Attendance confirmed',
        'Your attendance was confirmed and your earnings are ready for payout.',
        v_row.booking_id, 'fallback-attendance:' || v_row.booking_id::text);
      perform app_private.notify_account(
        v_row.booked_by_account_id, 'attendance_updated', 'Conversation attendance updated',
        'The conversation attendance was reviewed using the call record.',
        v_row.booking_id, 'fallback-attendance:' || v_row.booking_id::text);

    else
      update public.companion_earnings set state = 'held_for_issue', updated_at = now()
       where id = v_earning and state = 'pending_completion';
      insert into public.conversation_issues
        (booking_id, earning_id, reporter_account_id, reporter_role, category,
         description, idempotency_key)
      select v_row.booking_id, v_earning, e.companion_account_id, 'system', 'unclear_attendance',
             'Attendance evidence unclear — manual review required',
             'unclear-' || v_row.booking_id::text
      from public.companion_earnings e where e.id = v_earning
      on conflict (idempotency_key) do nothing;
      perform app_private.notify_account(
        v_companion_account, 'attendance_under_review', 'Conversation under review',
        'We could not confirm the conversation outcome automatically. It is being reviewed.',
        v_row.booking_id, 'attendance-review:' || v_row.booking_id::text);
      perform app_private.notify_account(
        v_row.booked_by_account_id, 'attendance_under_review', 'Conversation under review',
        'The conversation outcome could not be confirmed automatically and is being reviewed.',
        v_row.booking_id, 'attendance-review:' || v_row.booking_id::text);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.resolve_unconfirmed_attendance() from public, anon, authenticated;
grant execute on function public.resolve_unconfirmed_attendance() to service_role;

select pg_notify('pgrst', 'reload schema');
