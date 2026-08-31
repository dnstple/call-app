-- ===========================================================================
-- 0179_backup_failover_transport_schedule.sql
--
-- Schedules the call-failover TRANSPORT worker (SMS sending) every minute via
-- pg_cron + pg_net, mirroring 0044. State transitions already run in-DB
-- (process_failover_tick, scheduled in 0178) and do NOT depend on this — this
-- job only asks the Edge Function to flush pending SMS. Reuses the SAME Vault
-- entries as billing (billing_project_url + billing_cron_secret); no secret or
-- service-role key is ever hardcoded here.
--
-- Nothing is sent while backup_failover_config.sms_enabled = false (the Edge
-- Function checks the flag), so scheduling this is safe before you switch on.
-- ===========================================================================

create extension if not exists pg_net;

create or replace function app_private.invoke_call_failover_transport()
returns void language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text; v_request_id bigint;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'billing_project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'billing_cron_secret';
  if v_url is null or v_secret is null then
    raise notice 'call-failover-transport: Vault entries billing_project_url/billing_cron_secret absent — skipping.';
    return;
  end if;
  select net.http_post(
    url := v_url || '/functions/v1/call-failover',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-billing-secret', v_secret),
    timeout_milliseconds := 8000
  ) into v_request_id;
end;
$$;
revoke all on function app_private.invoke_call_failover_transport() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — schedule select app_private.invoke_call_failover_transport() every minute yourself.';
    return;
  end if;
  create extension if not exists pg_cron;
  if not exists (select 1 from vault.decrypted_secrets where name in ('billing_project_url','billing_cron_secret')
                 group by 1 having count(*) >= 1) then
    raise notice 'call-failover-transport NOT scheduled: add Vault entries billing_project_url and billing_cron_secret, then re-run.';
    return;
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'call-failover-transport';
  perform cron.schedule('call-failover-transport', '* * * * *',
    $cron$select app_private.invoke_call_failover_transport();$cron$);
  raise notice 'Scheduled call-failover-transport every minute via pg_cron.';
exception when others then
  raise notice 'call-failover-transport scheduling skipped (%).', sqlerrm;
end $$;
