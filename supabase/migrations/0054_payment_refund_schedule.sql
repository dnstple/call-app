-- ============================================================
-- 2G6C refund scheduler (migration 0054) — HOLD until the stripe-refunds worker
-- has been validated manually with genuine Stripe test-mode payments.
--
-- Adds a daily job that asks the stripe-refunds Edge Function to claim eligible
-- card refunds and create their Stripe refunds. Conservative cadence: once daily
-- at 06:30 UTC (after renewals/charge_due/transfers). Secrets read ONLY from
-- Supabase Vault (billing_project_url, billing_cron_secret); none are hardcoded.
-- ============================================================
create extension if not exists pg_net;

create or replace function app_private.invoke_payment_refunds()
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
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'billing_project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'billing_cron_secret';
  if v_url is null or v_secret is null then
    raise notice 'settle-payment-refunds: Vault entries absent — skipping (no refund run).';
    return;
  end if;
  select net.http_post(
    url := v_url || '/functions/v1/stripe-refunds',
    body := jsonb_build_object('limit', 20),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-billing-secret', v_secret),
    timeout_milliseconds := 10000
  ) into v_request_id;
end;
$$;
revoke all on function app_private.invoke_payment_refunds() from public, anon, authenticated;

do $$
declare v_have_vault boolean;
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — schedule select app_private.invoke_payment_refunds() at 06:30 UTC yourself.';
    return;
  end if;
  create extension if not exists pg_cron;
  select count(*) = 2 into v_have_vault from vault.decrypted_secrets
    where name in ('billing_project_url', 'billing_cron_secret');
  if not v_have_vault then
    raise notice 'settle-payment-refunds NOT scheduled: add the Vault entries, then re-run this migration.';
    return;
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'settle-payment-refunds';
  perform cron.schedule('settle-payment-refunds', '30 6 * * *',
    $cron$select app_private.invoke_payment_refunds();$cron$);
  raise notice 'Scheduled settle-payment-refunds daily at 06:30 UTC via pg_cron.';
exception when others then
  raise notice 'settle-payment-refunds scheduling skipped (%). Invoke app_private.invoke_payment_refunds() on a schedule.', sqlerrm;
end $$;
