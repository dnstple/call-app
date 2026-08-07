-- 0135 — Fix: expose record_payment_processing_fee to the webhook.
--
-- 0133 defined app_private.record_payment_processing_fee, but the stripe-webhook
-- calls it via the Supabase API (PostgREST), which only resolves functions in
-- the PUBLIC schema — so the call 404'd and every payment's fee stayed 'pending'
-- (never recorded, never paid out). Add a thin public wrapper, granted to
-- service_role only (the webhook), delegating to the private implementation.
-- SQL-to-SQL callers (create_paid_request) keep calling app_private directly.

set search_path = '';

create or replace function public.record_payment_processing_fee(
  p_order uuid, p_charge text, p_balance_txn text, p_fee_pence integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return app_private.record_payment_processing_fee(p_order, p_charge, p_balance_txn, p_fee_pence);
end;
$$;
revoke all on function public.record_payment_processing_fee(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.record_payment_processing_fee(uuid, text, text, integer) to service_role;

select pg_notify('pgrst', 'reload schema');
