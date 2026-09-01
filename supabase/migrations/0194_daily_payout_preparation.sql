-- ===========================================================================
-- 0194_daily_payout_preparation.sql
--
-- Daily "prepare + you approve" companion payouts. This does NOT move money and
-- does NOT bypass the deliberate human-in-the-loop design in 0073–0079: it only
-- assembles the eligible payable earnings into ready-to-approve transfer_finalise
-- runs (state='requested', <=5 earnings each — the provider batch cap) and
-- notifies support admins. A human still previews, confirms and executes each run
-- through the existing audited saga, which is the only path that speaks to Stripe.
--
-- Also widens companion_earnings.provider to allow a live 'stripe' value
-- alongside 'stripe_test', so real earnings can exist once you go live. (Existing
-- test rows are untouched; nothing here changes an earning's provider.)
--
-- Eligibility mirrors classify_scoped_transfer's "eligible for a new transfer":
-- state='payable', transfer_state='not_ready', positive, due, and the companion
-- is Connect payout-ready (connected_accounts.payouts_enabled). Earnings whose
-- companion is NOT onboarded are HELD (surfaced in the notification, never lost),
-- and earnings already inside an open run are skipped so re-runs never double-scope.
-- ===========================================================================

set search_path = '';

-- 1. Allow a live provider value on the earnings ledger (additive; keeps test).
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.companion_earnings'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%provider%';
  if c is not null then
    execute format('alter table public.companion_earnings drop constraint %I', c);
  end if;
end $$;
alter table public.companion_earnings
  add constraint companion_earnings_provider_check
  check (provider in ('stripe_test', 'stripe'));

-- 2. Config: enable flag + per-companion minimum payout. On membership_payout_config.
alter table public.membership_payout_config
  add column if not exists auto_prepare_payouts_enabled boolean not null default true;
alter table public.membership_payout_config
  add column if not exists min_payout_minor integer not null default 0
    check (min_payout_minor >= 0);

-- 3. The daily preparation sweep (service role; never touches Stripe).
create or replace function app_private.prepare_daily_companion_payouts()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_cfg public.membership_payout_config;
  v_env text;
  v_ids uuid[];
  v_batch uuid[];
  v_total_minor bigint := 0;
  v_run_count int := 0;
  v_held int := 0;
  v_i int;
  v_run_id uuid; v_token text; v_expires timestamptz;
  a record;
  v_day text := to_char(now(), 'YYYY-MM-DD');
begin
  select * into v_cfg from public.membership_payout_config where id = true;
  if v_cfg.id is null or coalesce(v_cfg.auto_prepare_payouts_enabled, false) = false then
    return jsonb_build_object('ok', true, 'skipped', 'disabled');
  end if;
  select environment into v_env from public.financial_operations_config where id = true;
  if v_env is null then
    return jsonb_build_object('ok', false, 'skipped', 'no_environment');
  end if;

  -- Eligible earnings, excluding any already inside an open payout run, and only
  -- for companions whose eligible total clears the minimum payout threshold.
  with open_runs as (
    select u.id as earning_id
      from public.financial_operation_runs r
      cross join lateral unnest(r.scoped_ids) as u(id)
     where r.operation_type = 'transfer_finalise'
       and r.state in ('requested', 'previewed', 'confirmed', 'executing')
  ),
  eligible as (
    select e.id, e.companion_account_id, e.net_minor
      from public.companion_earnings e
      join public.connected_accounts ca on ca.account_id = e.companion_account_id
     where e.state = 'payable'
       and e.transfer_state = 'not_ready'
       and e.net_minor > 0
       and coalesce(e.payable_at, now()) <= now()
       and ca.payouts_enabled = true
       and e.id not in (select earning_id from open_runs)
  ),
  companion_totals as (
    select companion_account_id, sum(net_minor) as tot
      from eligible group by companion_account_id
  )
  select array_agg(e.id order by e.companion_account_id, e.id)
    into v_ids
    from eligible e
    join companion_totals ct on ct.companion_account_id = e.companion_account_id
   where ct.tot >= coalesce(v_cfg.min_payout_minor, 0);

  -- Held: payable earnings whose companion is not payout-ready (onboarding gap).
  select count(*) into v_held
    from public.companion_earnings e
    left join public.connected_accounts ca on ca.account_id = e.companion_account_id
   where e.state = 'payable' and e.transfer_state = 'not_ready' and e.net_minor > 0
     and coalesce(ca.payouts_enabled, false) = false;

  if v_ids is null or array_length(v_ids, 1) is null then
    return jsonb_build_object('ok', true, 'prepared_runs', 0, 'earnings', 0, 'held_unonboarded', v_held);
  end if;

  -- Chunk eligible earnings into runs of at most 5 (the provider batch cap).
  v_i := 1;
  while v_i <= array_length(v_ids, 1) loop
    v_batch := v_ids[v_i : least(v_i + 4, array_length(v_ids, 1))];
    v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    v_expires := now() + interval '48 hours';
    insert into public.financial_operation_runs
      (operation_type, environment, execution_mode, scope_type, scoped_ids, batch_limit, dry_run, reason,
       confirmation_token, requested_by_account_id, expires_at, state)
    values
      ('transfer_finalise', v_env, 'execute_scoped', 'record_ids', v_batch, array_length(v_batch, 1), false,
       'Automated daily payout batch ' || v_day, v_token, null, v_expires, 'requested')
    returning id into v_run_id;
    insert into public.financial_operation_run_events (run_id, action, actor_account_id, detail)
      values (v_run_id, 'requested', null, jsonb_build_object('source', 'auto_daily_payout', 'mode', 'execute_scoped'));
    select v_total_minor + coalesce(sum(net_minor), 0) into v_total_minor
      from public.companion_earnings where id = any(v_batch);
    v_run_count := v_run_count + 1;
    v_i := v_i + 5;
  end loop;

  -- Notify support admins once per day.
  for a in select account_id from public.support_admins loop
    insert into public.notifications (user_id, type, title, body, dedupe_key)
    values (a.account_id, 'payout_batch_ready',
      'Companion payouts ready to release',
      v_run_count || ' payout run(s) totalling £' || to_char(v_total_minor / 100.0, 'FM999999990.00')
        || ' are prepared and awaiting your approval.'
        || case when v_held > 0 then ' (' || v_held || ' earning(s) held — companion not onboarded.)' else '' end,
      'payout_batch_ready:' || v_day)
    on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
  end loop;

  return jsonb_build_object('ok', true, 'prepared_runs', v_run_count,
    'earnings', array_length(v_ids, 1), 'total_minor', v_total_minor, 'held_unonboarded', v_held);
end;
$$;
revoke all on function app_private.prepare_daily_companion_payouts() from public, anon, authenticated;
grant execute on function app_private.prepare_daily_companion_payouts() to service_role;

-- 4. Schedule daily at 07:00.
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — schedule select app_private.prepare_daily_companion_payouts() daily yourself.';
    return;
  end if;
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'prepare-daily-companion-payouts';
  perform cron.schedule('prepare-daily-companion-payouts', '0 7 * * *',
    $cron$select app_private.prepare_daily_companion_payouts();$cron$);
  raise notice 'Scheduled prepare-daily-companion-payouts daily at 07:00.';
exception when others then
  raise notice 'prepare-daily-companion-payouts scheduling skipped (%).', sqlerrm;
end $$;

select pg_notify('pgrst', 'reload schema');
