-- ===========================================================================
-- 0153_onboarding_reminder_engine.sql
--
-- Automated "finish setting up your account" reminder campaign.
--
-- Audience: accounts that started but never completed onboarding
-- (onboarding_complete = false) and are still active. Both message variants are
-- supported (confirm-your-email vs finish-your-profile) — see email_confirmed.
-- NOTE: users who never confirmed their email and so never signed in have no
-- public.accounts row yet (it is created on first authenticated action), so they
-- are not reachable by this ledger-backed campaign; that population is handled by
-- Supabase Auth's own confirmation-resend, wired separately if wanted.
--
-- Cadence: the sender runs daily, but each person is only returned once every
-- cadence_days (default 7 → weekly), and only up to max_reminders times
-- (default 8; 0 = unlimited). Sends stop automatically once the person finishes
-- onboarding (they drop out of the candidate set) or unsubscribes.
--
-- Pieces:
--   * email_suppressions          — per-account opt-out of a lifecycle category.
--   * onboarding_nudge_config     — single-row cadence/enabled/cap knobs.
--   * claim_onboarding_nudges()   — who is due a reminder right now.
--   * invoke_onboarding_nudges()  — pg_net POST to the sender edge function.
--   * daily pg_cron schedule.
-- ===========================================================================

set search_path = '';

-- Opt-out store for lifecycle emails (category-scoped so it is reusable).
create table if not exists public.email_suppressions (
  account_id uuid not null references public.accounts(id) on delete cascade,
  category   text not null,
  source     text,
  created_at timestamptz not null default now(),
  primary key (account_id, category)
);
alter table public.email_suppressions enable row level security;
-- Read-own only (if ever surfaced); no client write policy ⇒ only service role writes.
drop policy if exists "email_suppressions: read own" on public.email_suppressions;
create policy "email_suppressions: read own" on public.email_suppressions
  for select to authenticated using (account_id = auth.uid());

-- Single-row config for the reminder cadence.
create table if not exists public.onboarding_nudge_config (
  id            boolean primary key default true check (id),
  enabled       boolean not null default true,
  cadence_days  integer not null default 7 check (cadence_days between 1 and 90),
  max_reminders integer not null default 8 check (max_reminders >= 0),  -- 0 = unlimited
  updated_at    timestamptz not null default now()
);
insert into public.onboarding_nudge_config (id) values (true) on conflict (id) do nothing;
alter table public.onboarding_nudge_config enable row level security;  -- no policies: service role only

-- Record an opt-out (called by the public unsubscribe endpoint via service role).
-- In public schema + granted to service_role so the Edge Function can call it via
-- PostgREST rpc(); locked away from anon/authenticated.
create or replace function public.suppress_onboarding_emails(p_account uuid, p_source text default 'user')
returns void language sql security definer set search_path = '' as $$
  insert into public.email_suppressions (account_id, category, source)
  values (p_account, 'onboarding', coalesce(p_source, 'user'))
  on conflict (account_id, category) do nothing;
$$;
revoke all on function public.suppress_onboarding_emails(uuid, text) from public, anon, authenticated;
grant execute on function public.suppress_onboarding_emails(uuid, text) to service_role;

-- Who is due a reminder right now. Public + service_role only (Edge Function
-- calls it via PostgREST rpc()); never exposed to anon/authenticated.
create or replace function public.claim_onboarding_nudges(p_limit integer default 100)
returns table (
  account_id      uuid,
  email           text,
  first_name      text,
  intended_role   text,
  email_confirmed boolean
) language sql stable security definer set search_path = '' as $$
  with cfg as (select * from public.onboarding_nudge_config where id),
  candidates as (
    select ac.id as account_id,
           coalesce(nullif(p.email, ''), u.email) as email,
           p.first_name,
           ac.intended_role,
           (u.email_confirmed_at is not null) as email_confirmed
    from public.accounts ac
    join auth.users u on u.id = ac.id
    left join lateral (
      select pr.first_name, pr.email
      from public.profile_access pax
      join public.profiles pr on pr.id = pax.profile_id
      where pax.account_id = ac.id and pax.access_role = 'owner'
      order by pax.created_at limit 1) p on true
    where ac.onboarding_complete = false
      and ac.status = 'active'
  )
  select c.account_id, c.email, c.first_name, c.intended_role, c.email_confirmed
  from candidates c, cfg
  where cfg.enabled
    and c.email is not null and c.email <> ''
    and not exists (
      select 1 from public.email_suppressions s
      where s.account_id = c.account_id and s.category = 'onboarding')
    -- cadence: nothing successful or in-flight within the cadence window
    and not exists (
      select 1 from public.email_notifications en
      where en.recipient_user_id = c.account_id
        and en.notification_type = 'onboarding_incomplete'
        and en.status in ('sending', 'sent', 'delivered')
        and en.created_at > now() - make_interval(days => cfg.cadence_days))
    -- cap: stop after max_reminders successful sends (0 = unlimited)
    and (cfg.max_reminders = 0 or (
      select count(*) from public.email_notifications en2
      where en2.recipient_user_id = c.account_id
        and en2.notification_type = 'onboarding_incomplete'
        and en2.status in ('sent', 'delivered')) < cfg.max_reminders)
  order by c.account_id
  limit greatest(coalesce(p_limit, 100), 1);
$$;
revoke all on function public.claim_onboarding_nudges(integer) from public, anon, authenticated;
grant execute on function public.claim_onboarding_nudges(integer) to service_role;

-- Scheduler → sender edge function, using Vault-held secrets (reusing
-- billing_project_url / billing_cron_secret, same as the payout worker).
create extension if not exists pg_net;

create or replace function app_private.invoke_onboarding_nudges()
returns void language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text; v_request_id bigint;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'billing_project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'billing_cron_secret';
  if v_url is null or v_secret is null then
    raise notice 'nudge-incomplete-onboarding: Vault entries billing_project_url/billing_cron_secret absent — skipping.';
    return;
  end if;
  select net.http_post(
    url := v_url || '/functions/v1/nudge-incomplete-onboarding',
    body := jsonb_build_object('limit', 200),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-billing-secret', v_secret),
    timeout_milliseconds := 15000
  ) into v_request_id;
end;
$$;
revoke all on function app_private.invoke_onboarding_nudges() from public, anon, authenticated;

do $$
declare v_have_vault boolean;
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — schedule select app_private.invoke_onboarding_nudges() daily yourself.';
    return;
  end if;
  create extension if not exists pg_cron;
  select count(*) = 2 into v_have_vault from vault.decrypted_secrets
    where name in ('billing_project_url', 'billing_cron_secret');
  if not v_have_vault then
    raise notice 'nudge-incomplete-onboarding NOT scheduled: add Vault entries billing_project_url and billing_cron_secret, then re-run this migration.';
    return;
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'nudge-incomplete-onboarding';
  perform cron.schedule('nudge-incomplete-onboarding', '30 9 * * *',
    $cron$select app_private.invoke_onboarding_nudges();$cron$);
  raise notice 'Scheduled nudge-incomplete-onboarding daily at 09:30 UTC via pg_cron.';
exception when others then
  raise notice 'nudge-incomplete-onboarding scheduling skipped (%). Invoke app_private.invoke_onboarding_nudges() on a schedule.', sqlerrm;
end $$;

select pg_notify('pgrst', 'reload schema');
