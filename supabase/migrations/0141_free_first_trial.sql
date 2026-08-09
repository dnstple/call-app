-- 0141 — Free first trial (platform-funded).
--
-- Every Member gets ONE free trial call: their first trial is free to them and
-- the cost is covered by Apricoti. Implemented on the existing account-credit
-- rails: at the moment a Member books their FIRST trial (and has never had one),
-- we issue a one-time £5 platform credit; the existing credit flow in
-- create_paid_request then funds the trial in full, so the Member pays £0, the
-- Companion is still paid the trial rate, and the platform bears the £5.
--
-- Guards against abuse: one grant per Member profile (guard table + idempotent
-- credit key), and only when the Member has no prior successful trial order.
-- Additive; standard/paid conversations are unaffected.

set search_path = '';

-- 1. Allow a distinct ledger source for the platform-funded free trial.
alter table public.credit_ledger drop constraint if exists credit_ledger_source_type_check;
alter table public.credit_ledger add constraint credit_ledger_source_type_check check (source_type in (
  'companion_declined', 'eligible_cancellation', 'plan_reduction', 'plan_paused',
  'plan_ended', 'platform_failure', 'refund_resolution', 'support_adjustment',
  'trial_purchase', 'one_off_purchase', 'plan_renewal', 'plan_addition', 'service_fee',
  'payment_restoration', 'free_trial_grant'));

-- 2. One free trial per Member (guard).
create table if not exists public.member_free_trials (
  member_profile_id uuid primary key references public.profiles(id) on delete cascade,
  payer_account_id  uuid references public.accounts(id),
  granted_at        timestamptz not null default now()
);
alter table public.member_free_trials enable row level security;   -- no client policies

-- 3. create_paid_request — 0133 body, with the free-first-trial grant added at
--    the top so the quote sees the credit and the Member pays nothing.
create or replace function public.create_paid_request(
  p_member uuid, p_companion uuid, p_offer uuid,
  p_starts_at timestamptz, p_idempotency text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_quote jsonb; v_order public.payment_orders; v_applied integer; v_offer_type text;
begin
  select * into v_order from public.payment_orders where idempotency_key = p_idempotency;
  if v_order.id is not null then
    return jsonb_build_object('order_id', v_order.id, 'status', v_order.status,
      'card_amount_minor', v_order.card_amount_minor);
  end if;

  -- FREE FIRST TRIAL (platform-funded): grant a one-time £5 credit for this
  -- Member's first trial, before quoting, so the existing credit flow funds it.
  select offer_type into v_offer_type from public.conversation_offers
   where id = p_offer and companion_profile_id = p_companion and active;
  if v_offer_type = 'trial'
     and not exists (select 1 from public.member_free_trials where member_profile_id = p_member)
     and not exists (select 1 from public.payment_orders po
                     where po.member_profile_id = p_member and po.order_type = 'trial'
                       and po.status in ('succeeded', 'credited')) then
    perform public.issue_account_credit(
      auth.uid(), 500, 'free_trial_grant', p_member,
      'Free first trial (platform-funded)', 'free-trial-' || p_member::text);
    insert into public.member_free_trials (member_profile_id, payer_account_id)
    values (p_member, auth.uid()) on conflict (member_profile_id) do nothing;
  end if;

  v_quote := public.quote_paid_request(p_member, p_companion, p_offer);
  if p_starts_at is null or p_starts_at < now() then
    raise exception 'invalid_slot: choose a future time';
  end if;

  insert into public.payment_orders
    (coordinator_account_id, member_profile_id, companion_profile_id,
     order_type, status, subtotal_minor, discount_minor, service_fee_minor,
     credit_applied_minor, card_amount_minor, total_minor,
     commission_rate_pct, commission_minor, commission_rate_bps, fee_calculation_status,
     offer_id, starts_at, duration_minutes, idempotency_key, expires_at)
  values
    (auth.uid(), p_member, p_companion,
     v_quote->>'type', 'pending',
     (v_quote->>'subtotal_minor')::integer, 0, 0,
     (v_quote->>'credit_applied_minor')::integer, (v_quote->>'card_amount_minor')::integer,
     (v_quote->>'total_minor')::integer,
     (v_quote->>'commission_rate_pct')::numeric, 0,
     (v_quote->>'commission_rate_bps')::integer, 'pending',
     p_offer, p_starts_at, (v_quote->>'duration_minutes')::integer,
     p_idempotency, now() + interval '30 minutes')
  returning * into v_order;

  if v_order.credit_applied_minor > 0 then
    v_applied := public.spend_account_credit(
      auth.uid(), v_order.credit_applied_minor,
      case when v_order.order_type = 'trial' then 'trial_purchase' else 'one_off_purchase' end,
      v_order.id, v_order.id, 'Reserved for conversation request', 'spend-' || v_order.id::text);
    if v_applied < v_order.credit_applied_minor then
      update public.payment_orders
         set credit_applied_minor = v_applied, card_amount_minor = total_minor - v_applied
       where id = v_order.id returning * into v_order;
    end if;
  end if;

  if v_order.card_amount_minor = 0 then
    perform app_private.finalise_paid_order(v_order.id, 'succeeded', null);
    perform app_private.record_payment_processing_fee(v_order.id, null, null, 0);
    select * into v_order from public.payment_orders where id = v_order.id;
  end if;

  return jsonb_build_object('order_id', v_order.id, 'status', v_order.status,
    'card_amount_minor', v_order.card_amount_minor);
end;
$$;
revoke all on function public.create_paid_request(uuid, uuid, uuid, timestamptz, text) from public, anon;
grant execute on function public.create_paid_request(uuid, uuid, uuid, timestamptz, text) to authenticated;

select pg_notify('pgrst', 'reload schema');
