-- 0149 — Cash payout for referral rewards (Companion referrers).
--
-- 0148 issued every referral reward as account credit. A Companion referrer
-- can't spend member credit, so this routes their £5 through the SAME Stripe
-- payout pipeline as their call earnings: a companion referrer with a ready
-- connected payout account earns a CASH reward (transfer_state='payable'), which
-- the transfer worker sends to their connected account; everyone else keeps
-- account credit. Fully idempotent; one reward per household unchanged.

set search_path = '';

-- 1. Payout tracking on the rewards ledger.
alter table public.referral_rewards
  add column if not exists reward_kind text not null default 'credit',
  add column if not exists connected_account_id text,
  add column if not exists referrer_companion_profile_id uuid references public.profiles(id),
  add column if not exists transfer_state text not null default 'none',
  add column if not exists stripe_transfer_id text,
  add column if not exists transfer_attempt_count integer not null default 0,
  add column if not exists transfer_failure_code text,
  add column if not exists transfer_updated_at timestamptz;
alter table public.referral_rewards drop constraint if exists referral_rewards_reward_kind_check;
alter table public.referral_rewards add constraint referral_rewards_reward_kind_check check (reward_kind in ('credit', 'cash'));
alter table public.referral_rewards drop constraint if exists referral_rewards_transfer_state_check;
alter table public.referral_rewards add constraint referral_rewards_transfer_state_check
  check (transfer_state in ('none', 'payable', 'processing', 'transferred', 'failed', 'failed_permanent'));
create unique index if not exists referral_rewards_transfer_id
  on public.referral_rewards (stripe_transfer_id) where stripe_transfer_id is not null;

-- 2. Award routing — cash for a payout-ready Companion referrer, else credit.
create or replace function app_private.maybe_award_referral_reward(p_household uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_referrer uuid;
  v_cfg public.referral_reward_config;
  v_paid integer;
  v_awarded integer;
  v_credit uuid;
  v_comp_profile uuid;
  v_conn text;
begin
  if p_household is null then return; end if;
  if exists (select 1 from public.referral_rewards where household_account_id = p_household) then return; end if;

  select referrer_account_id into v_referrer
    from public.referral_redemptions where invitee_account_id = p_household limit 1;
  if v_referrer is null or v_referrer = p_household then return; end if;

  select * into v_cfg from public.referral_reward_config where id;

  v_paid := app_private.household_paid_calls(p_household);
  if v_paid < v_cfg.paid_calls_required then return; end if;

  select count(*) into v_awarded from public.referral_rewards;
  if v_awarded >= v_cfg.household_cap then return; end if;

  -- Is the referrer a Companion with a ready payout account? → CASH.
  select p.id into v_comp_profile
    from public.profiles p
    join public.profile_access pa on pa.profile_id = p.id and pa.access_role = 'owner'
   where pa.account_id = v_referrer and p.role = 'companion' limit 1;
  if v_comp_profile is not null then
    select ca.stripe_account_id into v_conn from public.connected_accounts ca
     where ca.account_id = v_referrer and ca.default_currency = 'gbp' limit 1;
  end if;

  if v_comp_profile is not null and v_conn is not null
     and app_private.companion_payments_ready(v_comp_profile) then
    -- CASH: paid via the Stripe transfer pipeline.
    insert into public.referral_rewards
      (household_account_id, referrer_account_id, amount_minor, paid_calls_at_award,
       reward_kind, connected_account_id, referrer_companion_profile_id, transfer_state)
    values (p_household, v_referrer, v_cfg.reward_minor, v_paid,
       'cash', v_conn, v_comp_profile, 'payable')
    on conflict (household_account_id) do nothing;
    perform app_private.notify_account(
      v_referrer, 'referral_reward', 'You earned a £5 referral reward',
      'Someone you introduced has completed four paid calls. £5 will be paid to your Apricoti payout account. Thank you for helping your community grow.',
      null, 'referral_reward:' || p_household::text);
  else
    -- CREDIT: added to the referrer's Apricoti account.
    v_credit := public.issue_account_credit(
      v_referrer, v_cfg.reward_minor, 'referral_reward', p_household,
      'Referral reward — thank you for introducing a new household to Apricoti',
      'referral-reward-' || p_household::text);
    insert into public.referral_rewards
      (household_account_id, referrer_account_id, amount_minor, paid_calls_at_award,
       reward_kind, credit_ledger_id, transfer_state)
    values (p_household, v_referrer, v_cfg.reward_minor, v_paid, 'credit', v_credit, 'none')
    on conflict (household_account_id) do nothing;
    perform app_private.notify_account(
      v_referrer, 'referral_reward', 'You earned a £5 referral reward',
      'Someone you introduced has completed four paid calls. £5 has been added to your Apricoti account. Thank you for helping your community grow.',
      null, 'referral_reward:' || p_household::text);
  end if;
end;
$$;
revoke all on function app_private.maybe_award_referral_reward(uuid) from public, anon, authenticated;

-- 3. Claim payable cash rewards for the transfer worker (per-attempt idempotency key).
create or replace function public.claim_referral_reward_transfers(p_limit integer default 20)
returns table (
  reward_id uuid, referrer_account_id uuid, connected_account_id text,
  amount_minor integer, currency text, stripe_idempotency_key text
)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare r record; v_attempt integer;
begin
  if not app_private.production_payouts_enabled() then return; end if;
  for r in
    select rr.id, rr.referrer_account_id, rr.connected_account_id, rr.amount_minor,
           rr.referrer_companion_profile_id
    from public.referral_rewards rr
    where rr.reward_kind = 'cash'
      and rr.transfer_state in ('payable', 'failed')
      and rr.connected_account_id is not null
      and rr.amount_minor > 0
      and app_private.companion_payments_ready(rr.referrer_companion_profile_id)
    order by rr.awarded_at
    limit greatest(p_limit, 0)
    for update of rr skip locked
  loop
    update public.referral_rewards
       set transfer_state = 'processing',
           transfer_attempt_count = transfer_attempt_count + 1,
           transfer_failure_code = null, transfer_updated_at = now()
     where id = r.id
     returning transfer_attempt_count into v_attempt;

    reward_id := r.id; referrer_account_id := r.referrer_account_id;
    connected_account_id := r.connected_account_id; amount_minor := r.amount_minor; currency := 'GBP';
    stripe_idempotency_key := 'refreward-' || r.id::text || '-a' || v_attempt::text;
    return next;
  end loop;
end;
$$;
revoke all on function public.claim_referral_reward_transfers(integer) from public, anon, authenticated;
grant execute on function public.claim_referral_reward_transfers(integer) to service_role;

-- 4. Finalisers (service-role).
create or replace function public.finalize_referral_reward_transferred(p_reward uuid, p_transfer_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.referral_rewards
     set transfer_state = 'transferred', stripe_transfer_id = p_transfer_id,
         transfer_failure_code = null, transfer_updated_at = now()
   where id = p_reward and transfer_state <> 'transferred';
end;
$$;
revoke all on function public.finalize_referral_reward_transferred(uuid, text) from public, anon, authenticated;
grant execute on function public.finalize_referral_reward_transferred(uuid, text) to service_role;

create or replace function public.finalize_referral_reward_failed(p_reward uuid, p_code text, p_permanent boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.referral_rewards
     set transfer_state = case when p_permanent then 'failed_permanent' else 'failed' end,
         transfer_failure_code = p_code, transfer_updated_at = now()
   where id = p_reward and transfer_state = 'processing';
end;
$$;
revoke all on function public.finalize_referral_reward_failed(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.finalize_referral_reward_failed(uuid, text, boolean) to service_role;

select pg_notify('pgrst', 'reload schema');
