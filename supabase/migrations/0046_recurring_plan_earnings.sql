-- ============================================================
-- 2G6A — recurring-plan companion earnings & settlement eligibility (0046).
--
-- Problem: recurring-plan occurrences consume funded allowance but never
-- created a companion_earning. ensure_companion_earning (0034) only knew about
-- directly-funded bookings — a succeeded payment_order with booking_id = the
-- booking — but a plan occurrence carries booking_source='package_credit' with
-- NO such order (the plan_period order references plan_id, not booking_id).
--
-- Fix (additive): one idempotent earning per completed recurring-plan booking,
-- created ONLY once the occurrence is financially eligible — i.e. the calendar
-- month's plan_billing_period is 'paid' (the coordinator was actually billed).
-- The earning is snapshotted from the BOOKING (companion amount, currency,
-- companion/member profile, plan, funding source, booking id) and flows through
-- the SAME downstream machinery (held_for_issue / payable / reversed, issues,
-- resolutions, release) as one-off, trial and package bookings. No separate
-- earning or dispute path. No client supplies an amount. Idempotent by booking.
--
-- Financial model reused unchanged:
--   monthly billing succeeds → allowance granted → booking generated →
--   allowance reserved → conversation completes → allowance consumed →
--   companion earning created/released → payable → (2G6B) Stripe transfer.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Snapshot columns for plan earnings (nullable; one-off/trial leave null).
--    payer_charge_minor = the customer-side value of THIS occurrence, so issue
--    resolution credits/splits a single conversation — never a whole month.
-- ------------------------------------------------------------
alter table public.companion_earnings
  add column if not exists plan_id uuid references public.conversation_plans(id),
  add column if not exists plan_billing_period_id uuid references public.plan_billing_periods(id),
  add column if not exists payer_charge_minor integer check (payer_charge_minor is null or payer_charge_minor >= 0);

-- Backfill the customer-charge snapshot for existing (directly-funded) earnings
-- so issue resolution keeps its exact prior behaviour for them.
update public.companion_earnings e
   set payer_charge_minor = po.total_minor
  from public.payment_orders po
 where e.payment_order_id = po.id
   and e.payer_charge_minor is null;

-- ------------------------------------------------------------
-- 2. ensure_companion_earning — REDEFINED additively. Path A (directly-funded
--    order) is byte-identical to 0034 plus the payer_charge snapshot; Path B
--    (recurring-plan occurrence) is new and snapshot-only.
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
-- 3. resolve_conversation_issue — REDEFINED so customer credit / partial split
--    is capped by THIS occurrence's customer charge (payer_charge_minor), not
--    the whole month's order total. For directly-funded earnings the snapshot
--    equals order.total_minor, so behaviour is unchanged. Everything else
--    (companion caps, credit ledger, dismissal, notification) is identical.
-- ------------------------------------------------------------
create or replace function public.resolve_conversation_issue(
  p_issue uuid, p_outcome text, p_note text,
  p_companion_minor integer, p_credit_minor integer, p_idempotency text
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_issue public.conversation_issues;
  v_e public.companion_earnings;
  v_order public.payment_orders;
  v_charge integer;
begin
  if not app_private.is_support_admin() then
    raise exception 'not_found: issue';
  end if;
  if exists (select 1 from public.issue_resolutions where idempotency_key = p_idempotency) then
    return jsonb_build_object('ok', true, 'repeat', true);
  end if;
  select * into v_issue from public.conversation_issues where id = p_issue for update;
  if v_issue.id is null then raise exception 'not_found: issue'; end if;
  if v_issue.state = 'resolved' then
    return jsonb_build_object('ok', true, 'repeat', true);
  end if;
  if p_note is null or trim(p_note) = '' then
    raise exception 'note_required: add a resolution note';
  end if;
  select * into v_e from public.companion_earnings where id = v_issue.earning_id for update;
  select * into v_order from public.payment_orders where id = v_e.payment_order_id;
  -- Occurrence-scoped customer charge (equals the order total for one-offs).
  v_charge := coalesce(v_e.payer_charge_minor, v_order.total_minor);

  if p_outcome = 'companion_payable_full' then
    p_companion_minor := v_e.net_minor; p_credit_minor := 0;
  elsif p_outcome = 'customer_credit_full' then
    p_companion_minor := 0; p_credit_minor := v_charge;
  elsif p_outcome = 'issue_dismissed_release' then
    p_companion_minor := v_e.net_minor; p_credit_minor := 0;
  elsif p_outcome = 'partial_resolution' then
    if p_companion_minor is null or p_credit_minor is null
       or p_companion_minor < 0 or p_credit_minor < 0
       or p_companion_minor > v_e.net_minor
       or p_credit_minor > v_charge
       or (p_companion_minor + p_credit_minor) > v_charge then
      raise exception 'invalid_amounts: partial resolution exceeds the payment';
    end if;
  else
    raise exception 'invalid_outcome: unknown resolution outcome';
  end if;

  if p_credit_minor > 0 then
    perform public.issue_account_credit(
      v_e.payer_account_id, p_credit_minor, 'refund_resolution', v_issue.id,
      'Issue resolution credit', 'resolution-credit-' || v_issue.id::text);
  end if;

  update public.companion_earnings
     set state = case when p_companion_minor > 0 then 'payable' else 'reversed' end,
         net_minor = case when p_outcome = 'partial_resolution' then p_companion_minor else net_minor end,
         payable_at = case when p_companion_minor > 0 then coalesce(payable_at, now()) else payable_at end,
         updated_at = now()
   where id = v_e.id;

  insert into public.issue_resolutions
    (issue_id, earning_id, resolver_account_id, outcome, note,
     companion_amount_minor, credit_amount_minor, idempotency_key)
  values (v_issue.id, v_e.id, auth.uid(), p_outcome, trim(p_note),
          p_companion_minor, p_credit_minor, p_idempotency);

  update public.conversation_issues
     set state = 'resolved', resolved_at = now(), updated_at = now()
   where id = v_issue.id;

  perform app_private.notify_account(
    v_issue.reporter_account_id, 'issue_resolved', 'Issue resolved',
    'Your reported issue has been reviewed and resolved.',
    v_issue.booking_id, 'issue_resolved:' || v_issue.id::text);
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.resolve_conversation_issue(uuid, text, text, integer, integer, text)
  from public, anon;
grant execute on function public.resolve_conversation_issue(uuid, text, text, integer, integer, text)
  to authenticated; -- internally gated by is_support_admin()

-- ------------------------------------------------------------
-- 4. resolve_unconfirmed_attendance — REDEFINED so the 24-hour trusted-evidence
--    fallback also covers recurring-plan occurrences (eligible via a PAID
--    period). Only the driving query's eligibility broadens; every downstream
--    branch (system attendance, release, held_for_issue, notifications) is
--    identical to 0037.
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
      and b.status not in ('cancelled', 'declined', 'change_proposed')
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
