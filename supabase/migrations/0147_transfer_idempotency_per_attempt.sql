-- 0147 — Fix payout retries poisoned by Stripe's idempotency cache.
--
-- claim_payable_transfers (0136) returned a STABLE Stripe idempotency key
-- ('transfer-<earning_id>'). Stripe caches the response for an idempotency key
-- for 24h — INCLUDING a `balance_insufficient` error. So once the first attempt
-- failed for lack of funds, every retry with the same key replayed that cached
-- error, even after the balance became available (a manual transfer with a fresh
-- key succeeded, proving the balance was fine).
--
-- Fix: append the attempt number to the Stripe idempotency key so each retry is
-- a fresh key ('transfer-<earning_id>-a<attempt_count>'). Exactly-once is still
-- protected for the SUCCESS case: a succeeded earning is marked transferred and
-- never re-claimed. (The residual risk is an ambiguous network timeout mid-send;
-- for that, the scoped saga's lookup-before-create is the fully-safe path. For a
-- clean error like balance_insufficient the transfer definitely wasn't created,
-- so a fresh key is safe.)

set search_path = '';

create or replace function public.claim_payable_transfers(p_limit integer default 20)
returns table (
  attempt_id uuid, earning_id uuid, companion_account_id uuid, companion_profile_id uuid,
  connected_account_id text, amount_minor integer, currency text, booking_id uuid,
  stripe_idempotency_key text
)
language plpgsql security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  r record;
  v_attempt uuid;
  v_attempt_count integer;
  v_cfg public.payout_execution_config;
  v_day_used integer;
  v_remaining integer;
  v_running integer := 0;
begin
  if not app_private.production_payouts_enabled() then return; end if;
  select * into v_cfg from public.payout_execution_config where id;

  select coalesce(sum(amount_minor), 0) into v_day_used
    from public.companion_transfer_attempts
   where state in ('processing', 'succeeded')
     and claimed_at >= date_trunc('day', now());
  v_remaining := v_cfg.daily_ceiling_minor - v_day_used;
  if v_remaining <= 0 then return; end if;

  for r in
    select e.id as earning_id, e.companion_account_id, e.companion_profile_id, e.booking_id,
           e.net_minor, ca.stripe_account_id
    from public.companion_earnings e
    join public.connected_accounts ca on ca.account_id = e.companion_account_id
    join public.payment_orders po on po.id = e.payment_order_id and po.status = 'succeeded'
    left join public.plan_billing_periods bp on bp.id = e.plan_billing_period_id
    where e.state = 'payable'
      and e.net_minor > 0
      and e.transfer_state in ('not_ready', 'ready', 'failed')
      and e.currency = 'GBP' and ca.default_currency = 'gbp'
      and (e.plan_billing_period_id is null or bp.status = 'paid')
      and app_private.companion_payments_ready(e.companion_profile_id)
      and not exists (select 1 from public.conversation_issues i
                      where i.booking_id = e.booking_id and i.state <> 'resolved')
      and not app_private.evidence_hold_blocks_payout(e.booking_id)
      and not exists (select 1 from public.companion_transfer_attempts ta
                      where ta.earning_id = e.id
                        and ta.state in ('processing', 'succeeded', 'failed_permanent'))
      and e.net_minor <= v_cfg.per_transfer_ceiling_minor
      and (not v_cfg.require_allowlist
           or ca.stripe_account_id in (select stripe_account_id from public.payout_destination_allowlist))
    order by e.payable_at nulls last, e.created_at
    limit greatest(p_limit, 0)
    for update of e skip locked
  loop
    if v_running + r.net_minor > v_remaining then continue; end if;

    insert into public.companion_transfer_attempts
      (earning_id, companion_account_id, companion_profile_id, connected_account_id,
       amount_minor, currency, state, attempt_count, idempotency_key, claimed_at)
    values
      (r.earning_id, r.companion_account_id, r.companion_profile_id, r.stripe_account_id,
       r.net_minor, 'GBP', 'processing', 1, 'transfer-' || r.earning_id::text, now())
    on conflict (earning_id) do update set
      state = 'processing',
      attempt_count = public.companion_transfer_attempts.attempt_count + 1,
      connected_account_id = excluded.connected_account_id,
      amount_minor = excluded.amount_minor,
      failure_code = null, failure_message = null,
      claimed_at = now(), updated_at = now()
    returning id, attempt_count into v_attempt, v_attempt_count;

    update public.companion_earnings set transfer_state = 'processing', updated_at = now()
     where id = r.earning_id;

    v_running := v_running + r.net_minor;
    attempt_id := v_attempt; earning_id := r.earning_id;
    companion_account_id := r.companion_account_id; companion_profile_id := r.companion_profile_id;
    connected_account_id := r.stripe_account_id; amount_minor := r.net_minor; currency := 'GBP';
    booking_id := r.booking_id;
    -- Fresh key per attempt ⇒ a clean prior failure (e.g. balance_insufficient)
    -- doesn't replay from Stripe's idempotency cache.
    stripe_idempotency_key := 'transfer-' || r.earning_id::text || '-a' || v_attempt_count::text;
    return next;
  end loop;
end;
$$;
revoke all on function public.claim_payable_transfers(integer) from public, anon, authenticated;
grant execute on function public.claim_payable_transfers(integer) to service_role;

select pg_notify('pgrst', 'reload schema');
