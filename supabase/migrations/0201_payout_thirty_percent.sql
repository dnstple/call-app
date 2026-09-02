-- ===========================================================================
-- 0201_payout_thirty_percent.sql
--
-- New companion payout split. Previously the Stripe fee was removed first and a
-- 15% commission taken on the remainder. Now:
--   1. the platform takes 30% of the FULL call fee (the credit allocation),
--   2. the Stripe processing cost is removed from what remains,
--   3. the companion receives whatever is left.
--
-- Worked example at the default config (£8.33 credit, £0.15 modelled Stripe fee):
--   commission = round(833 * 30%) = 250  (£2.50 to the platform)
--   companion  = 833 - 250 - 15   = 568  (£5.68 to the companion)
--
-- Applies to every credit call completed from now on. The Companion agreement
-- text + version are updated separately in the frontend.
-- ===========================================================================

set search_path = '';

-- 1. Config: 30% commission.
update public.membership_payout_config
   set commission_rate_pct = 30.00, updated_at = now()
 where id = true;

-- 2. New split in the completion/payout function (body mirrors 0163; only the
--    basis/commission/net calculation changes).
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

  -- NEW split: platform takes commission_rate_pct% of the FULL call fee, THEN the
  -- Stripe cost comes out of the remainder; the companion receives what is left.
  v_basis := cfg.credit_allocation_minor;                                  -- gross call fee
  v_commission := round(v_basis * cfg.commission_rate_pct / 100.0);        -- platform share (30%)
  v_net := greatest(v_basis - v_commission - cfg.stripe_fee_minor_per_credit, 0);  -- remainder − Stripe

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

  return jsonb_build_object('ok', true, 'earned', v_earned, 'net_minor', v_net,
    'basis_minor', v_basis, 'commission_minor', v_commission);
end;
$$;
revoke all on function public.complete_credit_booking(uuid, boolean) from public, anon, authenticated;
grant execute on function public.complete_credit_booking(uuid, boolean) to service_role;

select pg_notify('pgrst', 'reload schema');
