-- ===========================================================================
-- 0155_auth_confirmation_reminders.sql
--
-- Ledger for the "confirm your email" resend path (0153's sibling). People who
-- signed up but never confirmed their email have NO public.accounts row yet, so
-- the email_notifications ledger (FK → accounts) can't track them. This table is
-- keyed by the auth user id instead and records how many confirmation reminders
-- we've sent, when, and whether they opted out.
--
-- Written only by the service role (Edge Functions): the resend-confirmations
-- worker records each send here to enforce cadence + cap, and the public
-- email-unsubscribe endpoint flips `unsubscribed` for category 'auth_confirmation'.
-- ===========================================================================

set search_path = '';

create table if not exists public.auth_confirmation_reminders (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  email            text,
  reminder_count   integer not null default 0 check (reminder_count >= 0),
  last_reminded_at timestamptz,
  unsubscribed     boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- RLS on with NO policies: no anon/authenticated access at all. The service role
-- (used by the Edge Functions) bypasses RLS, which is the only writer/reader.
alter table public.auth_confirmation_reminders enable row level security;

-- Scheduler → resend-confirmations edge function (same Vault secrets as the rest).
create extension if not exists pg_net;

create or replace function app_private.invoke_confirmation_resends()
returns void language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text; v_request_id bigint;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'billing_project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'billing_cron_secret';
  if v_url is null or v_secret is null then
    raise notice 'resend-confirmations: Vault entries billing_project_url/billing_cron_secret absent — skipping.';
    return;
  end if;
  select net.http_post(
    url := v_url || '/functions/v1/resend-confirmations',
    body := jsonb_build_object('limit', 200),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-billing-secret', v_secret),
    timeout_milliseconds := 20000
  ) into v_request_id;
end;
$$;
revoke all on function app_private.invoke_confirmation_resends() from public, anon, authenticated;

do $$
declare v_have_vault boolean;
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — schedule select app_private.invoke_confirmation_resends() daily yourself.';
    return;
  end if;
  create extension if not exists pg_cron;
  select count(*) = 2 into v_have_vault from vault.decrypted_secrets
    where name in ('billing_project_url', 'billing_cron_secret');
  if not v_have_vault then
    raise notice 'resend-confirmations NOT scheduled: add Vault entries billing_project_url and billing_cron_secret, then re-run this migration.';
    return;
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'resend-confirmations';
  -- Offset from the confirmed-user nudge (09:30) so the two runs don't overlap.
  perform cron.schedule('resend-confirmations', '45 9 * * *',
    $cron$select app_private.invoke_confirmation_resends();$cron$);
  raise notice 'Scheduled resend-confirmations daily at 09:45 UTC via pg_cron.';
exception when others then
  raise notice 'resend-confirmations scheduling skipped (%). Invoke app_private.invoke_confirmation_resends() on a schedule.', sqlerrm;
end $$;

select pg_notify('pgrst', 'reload schema');
