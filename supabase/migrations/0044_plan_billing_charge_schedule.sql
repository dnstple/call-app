-- ============================================================
-- 2G5B automatic charging — daily charge_due scheduler (0044).
--
-- process_plan_renewals (06:00 UTC) creates due billing periods and leaves any
-- CARD remainder as a 'pending' plan_period order / 'payment_pending' period.
-- This migration adds the second daily job that actually charges those cards
-- off-session, at 06:10 UTC, by asking the stripe-billing Edge Function to run
-- its service-only `charge_due` action.
--
-- Secrets policy: the project URL and the cron secret are read ONLY from
-- Supabase Vault (vault.decrypted_secrets). No secret or service-role key is
-- hardcoded in any migration, function body, source file or cron command, and
-- decrypted secrets are never returned, logged, notified or surfaced in tests.
-- Required Vault entries (added manually before applying this migration):
--   billing_project_url   e.g. https://<ref>.supabase.co
--   billing_cron_secret   the same value as the function's BILLING_CRON_SECRET
-- ============================================================

create extension if not exists pg_net;

-- ------------------------------------------------------------
-- Private helper: POST {"action":"charge_due"} to the Edge Function, using the
-- Vault-held URL + secret. SECURITY DEFINER + private schema; execute is
-- revoked from every client role. Skips cleanly (NOTICE only) if either Vault
-- entry is absent, and never includes the secret in its NOTICE/return.
-- ------------------------------------------------------------
create or replace function app_private.invoke_plan_billing_charge_due()
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
    raise notice 'charge-due-plan-periods: Vault entries billing_project_url/billing_cron_secret absent — skipping (no charge run).';
    return;
  end if;

  select net.http_post(
    url := v_url || '/functions/v1/stripe-billing',
    body := jsonb_build_object('action', 'charge_due'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-billing-secret', v_secret
    ),
    timeout_milliseconds := 8000
  ) into v_request_id;
  -- v_request_id is an opaque pg_net queue id; the secret is never returned.
end;
$$;
revoke all on function app_private.invoke_plan_billing_charge_due() from public, anon, authenticated;

-- ------------------------------------------------------------
-- Idempotent daily schedule at 06:10 UTC. Reuses/removes any existing job of
-- the same name so re-applying never creates duplicates. Requires pg_cron and
-- both Vault entries; otherwise it skips with a clear NOTICE (no partial job).
-- ------------------------------------------------------------
do $$
declare
  v_have_vault boolean;
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — schedule select app_private.invoke_plan_billing_charge_due() at 06:10 UTC yourself.';
    return;
  end if;
  create extension if not exists pg_cron;

  select count(*) = 2 into v_have_vault
    from vault.decrypted_secrets
   where name in ('billing_project_url', 'billing_cron_secret');
  if not v_have_vault then
    raise notice 'charge-due-plan-periods NOT scheduled: add Vault entries billing_project_url and billing_cron_secret, then re-run this migration.';
    return;
  end if;

  -- Remove any prior job of this name so we never stack duplicates.
  perform cron.unschedule(jobid)
    from cron.job where jobname = 'charge-due-plan-periods';

  perform cron.schedule('charge-due-plan-periods', '10 6 * * *',
    $cron$select app_private.invoke_plan_billing_charge_due();$cron$);
  raise notice 'Scheduled charge-due-plan-periods daily at 06:10 UTC via pg_cron.';
exception when others then
  raise notice 'charge-due-plan-periods scheduling skipped (%). Invoke app_private.invoke_plan_billing_charge_due() on a schedule.', sqlerrm;
end $$;
