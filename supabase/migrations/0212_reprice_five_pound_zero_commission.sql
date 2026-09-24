-- ===========================================================================
-- 0212_reprice_five_pound_zero_commission.sql
--
-- New pricing model: £5.00 per call, platform takes 0% commission, the Stripe
-- fee is deducted from the £5 and the Companion receives the remainder.
--
-- membership_payout_config drives complete_credit_booking's payout maths:
--   basis      = credit_allocation_minor          (now £5.00)
--   commission = round(basis * commission_rate_pct/100)   (now 0)
--   net        = basis - commission - stripe_fee_minor_per_credit
-- so the Companion nets £5.00 minus the modelled Stripe fee, with nothing to the
-- platform.
--
-- NOTE: subscription CHARGE amounts (monthly, extra credits) are Stripe Price
-- objects / edge constants and are updated separately — see the deploy notes.
-- ===========================================================================

set search_path = '';

update public.membership_payout_config
   set credit_allocation_minor = 500,   -- £5.00 per call (was £8.33)
       commission_rate_pct     = 0      -- platform takes nothing (was 30%)
 where id;

select pg_notify('pgrst', 'reload schema');
