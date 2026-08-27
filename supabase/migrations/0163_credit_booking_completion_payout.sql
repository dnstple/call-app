-- ===========================================================================
-- 0163_credit_booking_completion_payout.sql  (Membership restructure — Phase 5)
--
-- Companion payout for credit-funded calls. On completion of a call the companion
-- actually delivered, create a companion_earning worth the £8.33 credit allocation
-- minus a modelled Stripe fee minus Apricoti's 15% commission, released into the
-- existing transfer pipeline. Calls taken over by an admin pay the companion
-- NOTHING.
--
-- Config-driven so the exact per-credit Stripe fee (Open Decision #2) can be set
-- without code changes.
-- ===========================================================================

set search_path = '';

-- Credit earnings are not tied to a per-booking payment order (subscription funds
-- them), so payment_order_id becomes optional.
alter table public.companion_earnings alter column payment_order_id drop not null;

create table if not exists public.membership_payout_config (
  id                         boolean primary key default true check (id),
  credit_allocation_minor    integer not null default 833,   -- £8.33 per credit
  stripe_fee_minor_per_credit integer not null default 15,    -- modelled Stripe fee per credit (Open Decision #2)
  commission_rate_pct        numeric(5,2) not null default 15.00,
  updated_at                 timestamptz not null default now()
);
insert into public.membership_payout_config (id) values (true) on conflict (id) do nothing;
alter table public.membership_payout_config enable row level security;  -- service role only

-- Complete a credit booking and, when the companion delivered it, create the
-- earning. Service role / admin (call-completion driven). Idempotent per booking.
create or replace function public.complete_credit_booking(p_booking uuid, p_delivered_by_companion boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings;
  cfg public.membership_payout_config;
  v_companion_account uuid;
  v_basis integer; v_commission integer; v_net integer;
  v_earned boolean := false;
begin
  select * into b from public.bookings where id = p_booking for update;
  if b.id is null then raise exception 'not_found'; end if;

  -- Mark completed (idempotent).
  update public.bookings set status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now()
   where id = p_booking;

  -- No payout for admin-handled fallbacks, or if an earning already exists.
  if b.status = 'admin_fallback' or b.handled_by_admin_id is not null or p_delivered_by_companion = false then
    return jsonb_build_object('ok', true, 'earned', false, 'reason', 'admin_or_undelivered');
  end if;
  if exists (select 1 from public.companion_earnings where booking_id = p_booking) then
    return jsonb_build_object('ok', true, 'earned', false, 'reason', 'already_earned');
  end if;

  select * into cfg from public.membership_payout_config where id;
  select pa.account_id into v_companion_account
    from public.profile_access pa
   where pa.profile_id = b.companion_profile_id and pa.access_role = 'owner' limit 1;
  if v_companion_account is null then
    return jsonb_build_object('ok', true, 'earned', false, 'reason', 'no_companion_account');
  end if;

  -- £8.33 − Stripe fee, then 15% commission on the remainder.
  v_basis := greatest(cfg.credit_allocation_minor - cfg.stripe_fee_minor_per_credit, 0);
  v_commission := round(v_basis * cfg.commission_rate_pct / 100.0);
  v_net := greatest(v_basis - v_commission, 0);

  insert into public.companion_earnings (
    booking_id, payment_order_id, companion_account_id, companion_profile_id,
    member_profile_id, payer_account_id, currency, basis_minor, commission_rate_pct,
    commission_minor, net_minor, provider, state, transfer_state, payable_at
  ) values (
    p_booking, null, v_companion_account, b.companion_profile_id,
    b.member_profile_id, b.booked_by_account_id, 'GBP', v_basis, cfg.commission_rate_pct,
    v_commission, v_net, 'stripe_test', 'payable', 'not_ready', now()
  );
  v_earned := true;

  return jsonb_build_object('ok', true, 'earned', v_earned, 'net_minor', v_net, 'basis_minor', v_basis);
end;
$$;
revoke all on function public.complete_credit_booking(uuid, boolean) from public, anon, authenticated;
grant execute on function public.complete_credit_booking(uuid, boolean) to service_role;

select pg_notify('pgrst', 'reload schema');
