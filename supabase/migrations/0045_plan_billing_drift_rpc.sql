-- ============================================================
-- 2G5B reconciliation RPC exposure (migration 0045).
--
-- app_private.plan_billing_state_drift() (0043) returns the number of
-- plan_period orders whose billing-period status has drifted from the required
-- mapping. It is intentionally private, so PostgREST cannot see it and the live
-- reconciliation test's rpc('plan_billing_state_drift') resolved to a missing
-- public.plan_billing_state_drift() (PGRST202).
--
-- This adds a thin public wrapper that ONLY delegates to the private function,
-- keeping app_private off PostgREST. Same return type (integer). Service-role
-- only — normal authenticated and anonymous callers cannot execute it.
-- No billing state logic, allowance behaviour, Edge Functions, cron jobs or
-- migrations 0043/0044 are changed.
-- ============================================================

create or replace function public.plan_billing_state_drift()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.plan_billing_state_drift();
$$;
revoke all on function public.plan_billing_state_drift() from public, anon, authenticated;
grant execute on function public.plan_billing_state_drift() to service_role;

select pg_notify('pgrst', 'reload schema');
