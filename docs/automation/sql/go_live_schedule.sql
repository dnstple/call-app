-- ===========================================================================
-- go_live_schedule.sql — NOT a migration. Run by hand ONLY after Daniel has
-- approved going live with charity outreach (docs/automation/RUNBOOK.md §B4).
--
-- Schedules (pg_cron, times in UTC):
--   charity-outreach-run   weekdays 09:30 UTC  (09:30 GMT / 10:30 BST)
--   charity-outreach-poll  every 30 min, weekdays 07:00–19:30 UTC
-- Even when scheduled, the run sends only if automation_controls.outreach_live
-- = true and the postal address is set; otherwise it records a dry run.
-- Uses the existing Vault entries billing_project_url / billing_cron_secret.
-- ===========================================================================
set search_path = '';

create or replace function app_private.invoke_charity_outreach(p_fn text, p_body jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text; v_id bigint;
begin
  if p_fn not in ('charity-outreach-run', 'charity-outreach-poll') then
    raise exception 'unexpected function %', p_fn;
  end if;
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'billing_project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'billing_cron_secret';
  if v_url is null or v_secret is null then
    raise notice '%: Vault entries missing — skipping.', p_fn; return;
  end if;
  select net.http_post(
    url := v_url || '/functions/v1/' || p_fn, body := p_body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-billing-secret', v_secret),
    timeout_milliseconds := 150000
  ) into v_id;
end;
$$;
revoke all on function app_private.invoke_charity_outreach(text, jsonb) from public, anon, authenticated;

select cron.schedule('charity-outreach-run', '30 9 * * 1-5',
  $c$select app_private.invoke_charity_outreach('charity-outreach-run', '{"dryRun": false}'::jsonb);$c$);
select cron.schedule('charity-outreach-poll', '*/30 7-19 * * 1-5',
  $c$select app_private.invoke_charity_outreach('charity-outreach-poll', '{}'::jsonb);$c$);

-- Verify:
-- select jobname, schedule, active from cron.job where jobname like 'charity-outreach-%';
-- To stop everything immediately:
--   update public.automation_controls set outreach_live = false, updated_at = now(), updated_by = 'Daniel';
--   select cron.unschedule('charity-outreach-run'); select cron.unschedule('charity-outreach-poll');
