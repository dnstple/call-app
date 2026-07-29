-- ============================================================
-- 2G6B settlement scheduler (migration 0049).
--
-- Apply this AFTER the stripe-transfers worker has been validated manually in
-- Stripe test mode. It adds a daily job that asks the stripe-transfers Edge
-- Function to claim eligible payable earnings and create their Connect
-- transfers. Conservative cadence: once daily at 06:20 UTC (after the 06:00
-- renewal and 06:10 charge_due jobs), NOT after every call.
--
-- Secrets policy (identical to 0044): the project URL and worker secret are read
-- ONLY from Supabase Vault (billing_project_url, billing_cron_secret). No secret
-- or service-role key is hardcoded anywhere; decrypted secrets are never
-- returned, logged or notified.
-- ============================================================

create extension if not exists pg_net;

create or replace function app_private.invoke_plan_transfers()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request_id bigint;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'billing_project_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'billing_cron_secret';

  if v_url is null or v_secret is null then
    raise notice 'settle-plan-transfers: Vault entries billing_project_url/billing_cron_secret absent — skipping (no settlement run).';
    return;
  end if;

  select net.http_post(
    url := v_url || '/functions/v1/stripe-transfers',
    body := jsonb_build_object('limit', 20),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-billing-secret', v_secret
    ),
    timeout_milliseconds := 10000
  ) into v_request_id;
  -- v_request_id is an opaque pg_net queue id; the secret is never returned.
end;
$$;
revoke all on function app_private.invoke_plan_transfers() from public, anon, authenticated;

do $$
declare
  v_have_vault boolean;
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — schedule select app_private.invoke_plan_transfers() at 06:20 UTC yourself.';
    return;
  end if;
  create extension if not exists pg_cron;

  select count(*) = 2 into v_have_vault
    from vault.decrypted_secrets
   where name in ('billing_project_url', 'billing_cron_secret');
  if not v_have_vault then
    raise notice 'settle-plan-transfers NOT scheduled: add Vault entries billing_project_url and billing_cron_secret, then re-run this migration.';
    return;
  end if;

  perform cron.unschedule(jobid)
    from cron.job where jobname = 'settle-plan-transfers';

  perform cron.schedule('settle-plan-transfers', '20 6 * * *',
    $cron$select app_private.invoke_plan_transfers();$cron$);
  raise notice 'Scheduled settle-plan-transfers daily at 06:20 UTC via pg_cron.';
exception when others then
  raise notice 'settle-plan-transfers scheduling skipped (%). Invoke app_private.invoke_plan_transfers() on a schedule.', sqlerrm;
end $$;
