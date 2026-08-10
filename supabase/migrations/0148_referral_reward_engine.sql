-- 0148 — Referral reward engine: £5 once a referred household completes 4 paid calls.
--
-- Attribution comes from referral_redemptions (0118): the household is the
-- account that redeemed a referral code; the referrer is who invited them. A
-- "paid call" is a completed, non-trial, non-reversed earning for that household.
-- When the count reaches 4, the referrer is awarded £5 — recorded in a rewards
-- ledger AND issued as account credit — subject to: one reward per household, the
-- referrer isn't the household (no self-referral), and the pilot's first-25-
-- households cap. Evaluated on every new companion earning; fully idempotent.
--
-- NOTE: v1 pays the £5 as ACCOUNT CREDIT to the referrer. Companion referrers
-- can't spend member credit, so a cash-payout path for companion referrers is a
-- follow-up; meanwhile every earned reward is in referral_rewards for support to
-- action. No reward moves real money here.

set search_path = '';

-- 1. Ledger source for the reward credit.
alter table public.credit_ledger drop constraint if exists credit_ledger_source_type_check;
alter table public.credit_ledger add constraint credit_ledger_source_type_check check (source_type in (
  'companion_declined', 'eligible_cancellation', 'plan_reduction', 'plan_paused',
  'plan_ended', 'platform_failure', 'refund_resolution', 'support_adjustment',
  'trial_purchase', 'one_off_purchase', 'plan_renewal', 'plan_addition', 'service_fee',
  'payment_restoration', 'free_trial_grant', 'referral_reward'));

-- 2. Rewards ledger — at most ONE reward per referred household.
create table if not exists public.referral_rewards (
  id uuid primary key default gen_random_uuid(),
  household_account_id uuid not null unique references public.accounts(id) on delete cascade,
  referrer_account_id  uuid not null references public.accounts(id) on delete cascade,
  amount_minor integer not null default 500,
  paid_calls_at_award integer not null,
  credit_ledger_id uuid references public.credit_ledger(id),
  awarded_at timestamptz not null default now()
);
create index if not exists referral_rewards_referrer_idx
  on public.referral_rewards (referrer_account_id, awarded_at desc);
alter table public.referral_rewards enable row level security;
drop policy if exists "referral rewards: referrer reads own" on public.referral_rewards;
create policy "referral rewards: referrer reads own" on public.referral_rewards
  for select to authenticated using (referrer_account_id = auth.uid());

-- Pilot cap: the first N qualifying households earn a reward.
create table if not exists public.referral_reward_config (
  id boolean primary key default true check (id),
  household_cap integer not null default 25,
  paid_calls_required integer not null default 4,
  reward_minor integer not null default 500
);
insert into public.referral_reward_config (id) values (true) on conflict (id) do nothing;
alter table public.referral_reward_config enable row level security;   -- no client policies

-- 3. Count a household's qualifying paid calls (completed, non-trial, non-reversed).
create or replace function app_private.household_paid_calls(p_household uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::int
  from public.companion_earnings ce
  join public.payment_orders po on po.id = ce.payment_order_id
  where ce.payer_account_id = p_household
    and po.order_type <> 'trial'
    and ce.state <> 'reversed';
$$;
revoke all on function app_private.household_paid_calls(uuid) from public, anon, authenticated;

-- 4. Award the referral reward if the household just qualified (idempotent).
create or replace function app_private.maybe_award_referral_reward(p_household uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_referrer uuid;
  v_cfg public.referral_reward_config;
  v_paid integer;
  v_awarded integer;
  v_credit uuid;
begin
  if p_household is null then return; end if;
  -- Already rewarded for this household? Nothing to do.
  if exists (select 1 from public.referral_rewards where household_account_id = p_household) then
    return;
  end if;
  -- Was this household referred? (and never self-referred — 0118 blocks that.)
  select referrer_account_id into v_referrer
    from public.referral_redemptions where invitee_account_id = p_household limit 1;
  if v_referrer is null or v_referrer = p_household then return; end if;

  select * into v_cfg from public.referral_reward_config where id;

  -- Enough paid calls yet?
  v_paid := app_private.household_paid_calls(p_household);
  if v_paid < v_cfg.paid_calls_required then return; end if;

  -- Pilot cap: only the first N qualifying households earn.
  select count(*) into v_awarded from public.referral_rewards;
  if v_awarded >= v_cfg.household_cap then return; end if;

  -- Award: issue credit to the referrer (idempotent key per household).
  v_credit := public.issue_account_credit(
    v_referrer, v_cfg.reward_minor, 'referral_reward', p_household,
    'Referral reward — thank you for introducing a new household to Apricoti',
    'referral-reward-' || p_household::text);

  insert into public.referral_rewards
    (household_account_id, referrer_account_id, amount_minor, paid_calls_at_award, credit_ledger_id)
  values (p_household, v_referrer, v_cfg.reward_minor, v_paid, v_credit)
  on conflict (household_account_id) do nothing;

  perform app_private.notify_account(
    v_referrer, 'referral_reward', 'You earned a £5 referral reward',
    'Someone you introduced has completed four paid calls. £5 has been added to your Apricoti account. Thank you for helping your community grow.',
    null, 'referral_reward:' || p_household::text);
end;
$$;
revoke all on function app_private.maybe_award_referral_reward(uuid) from public, anon, authenticated;

-- 5. Evaluate the reward whenever a new (completed, paid) earning is created.
create or replace function app_private.trg_referral_reward_on_earning()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Reward evaluation must NEVER block creation of a Companion's earning.
  begin
    perform app_private.maybe_award_referral_reward(new.payer_account_id);
  exception when others then
    null;
  end;
  return new;
end;
$$;
revoke all on function app_private.trg_referral_reward_on_earning() from public, anon, authenticated;
drop trigger if exists referral_reward_on_earning on public.companion_earnings;
create trigger referral_reward_on_earning
  after insert on public.companion_earnings
  for each row execute function app_private.trg_referral_reward_on_earning();

select pg_notify('pgrst', 'reload schema');
