-- ===========================================================================
-- 0161_membership_lifecycle.sql  (Membership restructure — Phase 3)
--
-- Membership lifecycle driven by Stripe (the webhook edge function calls these
-- as the service role). Billing model = Resolution A:
--   * £25 starter → 3 credits at day 0.
--   * Monthly subscription begins at anchor = starter + 7 days.
--   * £100 every 28 days = 12 credits, released 3 at each weekly boundary.
--
-- All credit issuance flows through public.issue_call_credit (0160). Nothing here
-- talks to Stripe directly; the edge function owns the API calls and passes us
-- verified facts.
-- ===========================================================================

set search_path = '';

alter table public.memberships
  add column if not exists last_weekly_credit_at timestamptz,
  add column if not exists starter_credit_issued boolean not null default false;

-- Create/attach a membership for a member (idempotent per stripe subscription).
create or replace function public.upsert_membership(
  p_member_profile uuid, p_payer_account uuid,
  p_stripe_customer text, p_stripe_subscription text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select id into v_id from public.memberships where stripe_subscription_id = p_stripe_subscription;
  if v_id is not null then return v_id; end if;

  -- Reuse an existing live membership for the member if present, else create.
  select id into v_id from public.memberships
   where member_profile_id = p_member_profile
     and status in ('pending','starter','active','past_due','paused')
   limit 1;

  if v_id is null then
    insert into public.memberships (member_profile_id, payer_account_id, stripe_customer_id, stripe_subscription_id, status)
    values (p_member_profile, p_payer_account, p_stripe_customer, p_stripe_subscription, 'pending')
    returning id into v_id;
  else
    update public.memberships
       set payer_account_id = p_payer_account,
           stripe_customer_id = coalesce(p_stripe_customer, stripe_customer_id),
           stripe_subscription_id = coalesce(p_stripe_subscription, stripe_subscription_id),
           updated_at = now()
     where id = v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function public.upsert_membership(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.upsert_membership(uuid, uuid, text, text) to service_role;

-- Starter paid (£25): issue the 3 starter credits ONCE, set the anchor 7 days out.
create or replace function public.record_membership_starter_paid(p_membership uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare m public.memberships;
begin
  select * into m from public.memberships where id = p_membership for update;
  if m.id is null then raise exception 'membership_not_found'; end if;

  update public.memberships
     set status = case when status = 'pending' then 'starter' else status end,
         starter_paid_at = coalesce(starter_paid_at, now()),
         anchor_at = coalesce(anchor_at, now() + interval '7 days'),
         paid_through_at = greatest(coalesce(paid_through_at, now()), now() + interval '7 days'),
         updated_at = now()
   where id = p_membership;

  if not m.starter_credit_issued then
    perform public.issue_call_credit(m.member_profile_id, p_membership, 'starter', 3);
    update public.memberships set starter_credit_issued = true where id = p_membership;
  end if;
end;
$$;
revoke all on function public.record_membership_starter_paid(uuid) from public, anon, authenticated;
grant execute on function public.record_membership_starter_paid(uuid) to service_role;

-- A recurring monthly invoice was paid: mark active + extend the paid-through and
-- the current billing period (28-day cadence under Resolution A).
create or replace function public.record_membership_invoice_paid(
  p_membership uuid, p_period_start timestamptz, p_period_end timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.memberships
     set status = 'active',
         current_period_start = coalesce(p_period_start, current_period_start),
         current_period_end   = coalesce(p_period_end, current_period_end),
         paid_through_at      = greatest(coalesce(paid_through_at, now()), coalesce(p_period_end, now() + interval '28 days')),
         updated_at = now()
   where id = p_membership;
end;
$$;
revoke all on function public.record_membership_invoice_paid(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.record_membership_invoice_paid(uuid, timestamptz, timestamptz) to service_role;

-- Status transitions from Stripe (past_due / paused / cancelled / active).
create or replace function public.record_membership_status(
  p_membership uuid, p_status text, p_cancel_at_period_end boolean default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('pending','starter','active','past_due','paused','cancelled','expired') then
    raise exception 'invalid_status';
  end if;
  update public.memberships
     set status = p_status,
         cancel_at_period_end = coalesce(p_cancel_at_period_end, cancel_at_period_end),
         updated_at = now()
   where id = p_membership;
end;
$$;
revoke all on function public.record_membership_status(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.record_membership_status(uuid, text, boolean) to service_role;

-- Weekly credit accrual: for each active membership, release 3 credits at every
-- 7-day boundary since the anchor that hasn't been credited yet, while paid.
-- Idempotent + catch-up safe. Runs daily; only issues when genuinely due.
create or replace function public.accrue_weekly_credits()
returns integer language plpgsql security definer set search_path = '' as $$
declare m record; v_due timestamptz; v_issued integer := 0; v_guard integer;
begin
  for m in
    select id, member_profile_id, anchor_at, last_weekly_credit_at, paid_through_at
    from public.memberships
    where status in ('active','starter')
      and anchor_at is not null
      and coalesce(paid_through_at, now()) > now() - interval '1 day'
  loop
    v_guard := 0;
    -- next due = last credited + 7d, or the anchor for the first weekly release.
    v_due := coalesce(m.last_weekly_credit_at + interval '7 days', m.anchor_at);
    while v_due <= now() and v_due <= coalesce(m.paid_through_at, now()) and v_guard < 8 loop
      perform public.issue_call_credit(m.member_profile_id, m.id, 'weekly', 3);
      update public.memberships set last_weekly_credit_at = v_due, updated_at = now() where id = m.id;
      v_issued := v_issued + 3;
      v_guard := v_guard + 1;
      v_due := v_due + interval '7 days';
    end loop;
  end loop;
  return v_issued;
end;
$$;
revoke all on function public.accrue_weekly_credits() from public, anon, authenticated;
grant execute on function public.accrue_weekly_credits() to service_role;

-- Buy extra credits (£8.33 each) after a one-off Stripe payment succeeds.
create or replace function public.grant_extra_credits(p_member_profile uuid, p_count integer)
returns integer language plpgsql security definer set search_path = '' as $$
begin
  return public.issue_call_credit(p_member_profile, null, 'extra', greatest(coalesce(p_count,1),1));
end;
$$;
revoke all on function public.grant_extra_credits(uuid, integer) from public, anon, authenticated;
grant execute on function public.grant_extra_credits(uuid, integer) to service_role;

-- Schedule weekly accrual (daily check; the function only issues when due).
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — schedule select public.accrue_weekly_credits() daily yourself.';
    return;
  end if;
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'accrue-weekly-credits';
  perform cron.schedule('accrue-weekly-credits', '30 3 * * *',
    $cron$select public.accrue_weekly_credits();$cron$);
  raise notice 'Scheduled accrue-weekly-credits daily at 03:30 UTC.';
exception when others then
  raise notice 'accrue-weekly-credits scheduling skipped (%).', sqlerrm;
end $$;

select pg_notify('pgrst', 'reload schema');
