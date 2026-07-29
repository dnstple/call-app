-- ============================================================================
-- 0079_expose_provider_saga_rpcs.sql  (Stage 3C2-C2 correction)
--
-- ROOT CAUSE (PGRST202): the eight 0078 provider-saga RPCs live ONLY in
-- app_private. PostgREST exposes just the `public` schema, so supabase.rpc()
-- from the service-role test client AND from the scoped-stripe-transfers Edge
-- Function resolves `public.<name>(...)` — which does not exist. Grants and
-- signatures were correct; the schema was not reachable through the RPC surface.
--
-- NARROWEST CORRECTION: additive PUBLIC-schema SECURITY DEFINER wrappers with
-- the EXACT app_private signatures and parameter names. Each wrapper:
--   * contains NO business logic — one immediate delegation, JSON preserved;
--   * sets search_path = '' (safe);
--   * is revoked from PUBLIC, anon AND authenticated (support users never drive
--     the provider saga directly; the Edge Function is the only intended caller);
--   * is granted ONLY to service_role;
--   * exposes no arbitrary record expansion — every check (run, scope binding,
--     lease, state, control, ceiling, batch, typed money facts) remains enforced
--     inside the delegated app_private function, unchanged.
-- 0001–0078 remain immutable; no Stripe/provider code; no cron; no worker.
-- ============================================================================

create or replace function public.begin_scoped_provider_transfer_run(p_run_id uuid, p_confirmation_token text)
returns jsonb language sql security definer set search_path = '' as $$
  select app_private.begin_scoped_provider_transfer_run(p_run_id, p_confirmation_token);
$$;
revoke all on function public.begin_scoped_provider_transfer_run(uuid, text) from public, anon, authenticated;
grant execute on function public.begin_scoped_provider_transfer_run(uuid, text) to service_role;

create or replace function public.begin_scoped_provider_transfer_item(p_run_id uuid, p_confirmation_token text, p_earning_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select app_private.begin_scoped_provider_transfer_item(p_run_id, p_confirmation_token, p_earning_id);
$$;
revoke all on function public.begin_scoped_provider_transfer_item(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.begin_scoped_provider_transfer_item(uuid, text, uuid) to service_role;

create or replace function public.record_scoped_transfer_lookup(p_job_id uuid, p_lease_token text, p_outcome text, p_provider jsonb default null)
returns jsonb language sql security definer set search_path = '' as $$
  select app_private.record_scoped_transfer_lookup(p_job_id, p_lease_token, p_outcome, p_provider);
$$;
revoke all on function public.record_scoped_transfer_lookup(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_scoped_transfer_lookup(uuid, text, text, jsonb) to service_role;

create or replace function public.authorize_scoped_transfer_create(p_job_id uuid, p_lease_token text)
returns jsonb language sql security definer set search_path = '' as $$
  select app_private.authorize_scoped_transfer_create(p_job_id, p_lease_token);
$$;
revoke all on function public.authorize_scoped_transfer_create(uuid, text) from public, anon, authenticated;
grant execute on function public.authorize_scoped_transfer_create(uuid, text) to service_role;

create or replace function public.finalize_scoped_transfer_success(p_job_id uuid, p_lease_token text, p_provider jsonb)
returns jsonb language sql security definer set search_path = '' as $$
  select app_private.finalize_scoped_transfer_success(p_job_id, p_lease_token, p_provider);
$$;
revoke all on function public.finalize_scoped_transfer_success(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_scoped_transfer_success(uuid, text, jsonb) to service_role;

create or replace function public.finalize_scoped_transfer_uncertain(p_job_id uuid, p_lease_token text, p_reason_code text)
returns jsonb language sql security definer set search_path = '' as $$
  select app_private.finalize_scoped_transfer_uncertain(p_job_id, p_lease_token, p_reason_code);
$$;
revoke all on function public.finalize_scoped_transfer_uncertain(uuid, text, text) from public, anon, authenticated;
grant execute on function public.finalize_scoped_transfer_uncertain(uuid, text, text) to service_role;

create or replace function public.finalize_scoped_transfer_rejected(p_job_id uuid, p_lease_token text, p_code text, p_permanent boolean)
returns jsonb language sql security definer set search_path = '' as $$
  select app_private.finalize_scoped_transfer_rejected(p_job_id, p_lease_token, p_code, p_permanent);
$$;
revoke all on function public.finalize_scoped_transfer_rejected(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.finalize_scoped_transfer_rejected(uuid, text, text, boolean) to service_role;

create or replace function public.complete_scoped_provider_transfer_run(p_run_id uuid, p_confirmation_token text)
returns jsonb language sql security definer set search_path = '' as $$
  select app_private.complete_scoped_provider_transfer_run(p_run_id, p_confirmation_token);
$$;
revoke all on function public.complete_scoped_provider_transfer_run(uuid, text) from public, anon, authenticated;
grant execute on function public.complete_scoped_provider_transfer_run(uuid, text) to service_role;

select pg_notify('pgrst', 'reload schema');
