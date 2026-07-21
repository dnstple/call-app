-- ============================================================
-- 2G6B fix — claim_plan_transfers column-reference ambiguity (migration 0050).
--
-- claim_plan_transfers (0048) declares RETURNS TABLE OUT columns whose names
-- (earning_id, companion_account_id, …) collide with real table columns used in
-- the body — notably `on conflict (earning_id)`. With PL/pgSQL's default
-- #variable_conflict = error, that raised "column reference earning_id is
-- ambiguous" at call time, so no transfer could ever be claimed.
--
-- Fix: redefine the function IDENTICALLY but with `#variable_conflict
-- use_column`, so an ambiguous name inside a SQL statement resolves to the
-- COLUMN (correct for the ON CONFLICT target and the INSERT). Assignment targets
-- (earning_id := r.earning_id, …) still assign to the OUT variables, so the
-- returned column names — and therefore the Edge Function's contract — are
-- UNCHANGED. No Edge Function redeploy is required. Additive: create or replace.
-- ============================================================
create or replace function public.claim_plan_transfers(p_limit integer default 20)
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
begin
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
      and not exists (select 1 from public.companion_transfer_attempts ta
                      where ta.earning_id = e.id
                        and ta.state in ('processing', 'succeeded', 'failed_permanent'))
    order by e.payable_at nulls last, e.created_at
    limit greatest(p_limit, 0)
    for update of e skip locked
  loop
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
    returning id into v_attempt;

    update public.companion_earnings set transfer_state = 'processing', updated_at = now()
     where id = r.earning_id;

    attempt_id := v_attempt; earning_id := r.earning_id;
    companion_account_id := r.companion_account_id; companion_profile_id := r.companion_profile_id;
    connected_account_id := r.stripe_account_id; amount_minor := r.net_minor; currency := 'GBP';
    booking_id := r.booking_id;
    stripe_idempotency_key := 'transfer-' || r.earning_id::text; -- stable ⇒ exactly-once
    return next;
  end loop;
end;
$$;
revoke all on function public.claim_plan_transfers(integer) from public, anon, authenticated;
grant execute on function public.claim_plan_transfers(integer) to service_role;

select pg_notify('pgrst', 'reload schema');
