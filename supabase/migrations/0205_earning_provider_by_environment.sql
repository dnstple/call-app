-- ===========================================================================
-- 0205_earning_provider_by_environment.sql
--
-- When real payouts are live, new companion earnings should be recorded against
-- the live provider ('stripe') rather than 'stripe_test'. complete_credit_booking
-- (0201) hard-coded 'stripe_test'; this makes the provider follow the financial
-- environment: 'production_live' -> 'stripe', anything else -> 'stripe_test'.
-- Everything else (the 30% split) is unchanged.
-- ===========================================================================

set search_path = '';

create or replace function public.complete_credit_booking(p_booking uuid, p_delivered_by_companion boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings;
  cfg public.membership_payout_config;
  v_companion_account uuid;
  v_basis integer; v_commission integer; v_net integer; v_provider text;
  v_earned boolean := false;
begin
  select * into b from public.bookings where id = p_booking for update;
  if b.id is null then raise exception 'not_found'; end if;

  update public.bookings set status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now()
   where id = p_booking;

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

  -- 30% of the full fee, then Stripe cost off the remainder (unchanged).
  v_basis := cfg.credit_allocation_minor;
  v_commission := round(v_basis * cfg.commission_rate_pct / 100.0);
  v_net := greatest(v_basis - v_commission - cfg.stripe_fee_minor_per_credit, 0);

  -- Provider follows the live/test environment.
  v_provider := case when app_private.current_financial_environment() = 'production_live'
                     then 'stripe' else 'stripe_test' end;

  insert into public.companion_earnings (
    booking_id, payment_order_id, companion_account_id, companion_profile_id,
    member_profile_id, payer_account_id, currency, basis_minor, commission_rate_pct,
    commission_minor, net_minor, provider, state, transfer_state, payable_at
  ) values (
    p_booking, null, v_companion_account, b.companion_profile_id,
    b.member_profile_id, b.booked_by_account_id, 'GBP', v_basis, cfg.commission_rate_pct,
    v_commission, v_net, v_provider, 'payable', 'not_ready', now()
  );
  v_earned := true;

  return jsonb_build_object('ok', true, 'earned', v_earned, 'net_minor', v_net,
    'basis_minor', v_basis, 'commission_minor', v_commission, 'provider', v_provider);
end;
$$;
revoke all on function public.complete_credit_booking(uuid, boolean) from public, anon, authenticated;
grant execute on function public.complete_credit_booking(uuid, boolean) to service_role;

select pg_notify('pgrst', 'reload schema');
