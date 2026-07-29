-- ============================================================
-- 2G6B — Companion Connect settlement (migration 0048).
--
-- Transfers a PAYABLE companion earning to the companion's Express connected
-- account as ONE platform-to-connected-account transfer per earning (separate
-- charges & transfers). Because an earning's funding may span account credit, a
-- card PaymentIntent, a monthly recurring-plan PaymentIntent and/or several
-- occurrence earnings, no single charge represents it — so these are ORDINARY
-- PLATFORM-BALANCE transfers (no source_transaction). A Stripe transfer to a
-- connected account is NOT a bank payout; earnings are marked 'transferred',
-- never "bank paid".
--
-- Lifecycle: payable → (worker claims, atomically, commit before Stripe) →
-- Stripe transfer created (stable idempotency key per earning) → succeeded →
-- earning transferred; webhooks reconcile later. Refunds/disputes are NOT in
-- 2G6B beyond safely recording transfer.reversed.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Earning transfer_state: extend the allowed set (additive superset; every
--    existing row is 'not_ready'). Existing values are preserved.
-- ------------------------------------------------------------
alter table public.companion_earnings
  drop constraint if exists companion_earnings_transfer_state_check;
alter table public.companion_earnings
  add constraint companion_earnings_transfer_state_check check (transfer_state in
    ('not_ready', 'ready', 'transfer_pending', 'processing', 'transferred', 'failed', 'reversed'));

-- ------------------------------------------------------------
-- 2. Immutable-ish, auditable settlement ledger — ONE row per earning. Detailed
--    settlement data is private (RLS on, NO client policies at all): only the
--    service role writes it and support reads via RPC.
-- ------------------------------------------------------------
create table if not exists public.companion_transfer_attempts (
  id uuid primary key default gen_random_uuid(),
  earning_id uuid not null unique references public.companion_earnings(id),
  companion_account_id uuid not null references public.accounts(id),
  companion_profile_id uuid not null references public.profiles(id),
  connected_account_id text not null,
  amount_minor integer not null check (amount_minor > 0),
  currency text not null default 'GBP' check (currency = 'GBP'),
  state text not null default 'queued' check (state in
    ('queued', 'processing', 'succeeded', 'failed_retryable', 'failed_permanent', 'reversed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  idempotency_key text not null unique,
  stripe_transfer_id text unique,
  failure_code text,
  failure_message text,
  claimed_at timestamptz,
  stripe_created_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists transfer_attempts_state_idx on public.companion_transfer_attempts (state);
create index if not exists transfer_attempts_companion_idx on public.companion_transfer_attempts (companion_account_id);
-- At most one SUCCEEDED transfer per earning (belt-and-braces with unique earning_id).
create unique index if not exists transfer_attempts_one_success
  on public.companion_transfer_attempts (earning_id) where state = 'succeeded';
alter table public.companion_transfer_attempts enable row level security;
-- No client policies: browsers can neither read nor write settlement rows.

-- ------------------------------------------------------------
-- 3. Claim worker (service-role). Selects a bounded set of eligible earnings
--    with FOR UPDATE SKIP LOCKED, claims/creates their transfer attempt, marks
--    both processing, and returns ONLY the server-derived transfer payload. The
--    Edge Function calls this, the claim COMMITS (function returns), then Stripe
--    is contacted OUTSIDE any open transaction. The Stripe idempotency key is
--    stable per earning, so a stale-claim retry can never double-transfer.
-- ------------------------------------------------------------
create or replace function public.claim_plan_transfers(p_limit integer default 20)
returns table (
  attempt_id uuid, earning_id uuid, companion_account_id uuid, companion_profile_id uuid,
  connected_account_id text, amount_minor integer, currency text, booking_id uuid,
  stripe_idempotency_key text
)
language plpgsql security definer
set search_path = ''
as $$
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

-- ------------------------------------------------------------
-- 4. Stale-claim recovery (service-role). A crashed worker leaves an attempt in
--    'processing' with no Stripe id. Because the Stripe idempotency key is
--    stable per earning, resetting to 'failed_retryable' is safe: the next claim
--    reuses the same key, so Stripe returns the existing transfer if one was
--    created and never makes a second.
-- ------------------------------------------------------------
create or replace function public.recover_stale_transfers(p_minutes integer default 30)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare v_count integer;
begin
  with stale as (
    update public.companion_transfer_attempts ta
       set state = 'failed_retryable',
           failure_code = 'stale_claim',
           failure_message = 'Worker did not finalise in time; safe to retry.',
           updated_at = now()
     where ta.state = 'processing'
       and ta.stripe_transfer_id is null
       and ta.claimed_at < now() - make_interval(mins => greatest(p_minutes, 1))
    returning ta.earning_id
  )
  update public.companion_earnings e set transfer_state = 'failed', updated_at = now()
    from stale where e.id = stale.earning_id and e.transfer_state = 'processing';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.recover_stale_transfers(integer) from public, anon, authenticated;
grant execute on function public.recover_stale_transfers(integer) to service_role;

-- ------------------------------------------------------------
-- 5. Finalisation RPCs (service-role). Called by BOTH the Edge Function (from
--    the Stripe API response) and the webhook — each idempotent.
-- ------------------------------------------------------------
create or replace function public.finalize_transfer_succeeded(
  p_attempt uuid, p_transfer_id text, p_created bigint default null
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_att public.companion_transfer_attempts;
  v_e public.companion_earnings;
begin
  select * into v_att from public.companion_transfer_attempts where id = p_attempt for update;
  if v_att.id is null then return; end if;
  select * into v_e from public.companion_earnings where id = v_att.earning_id for update;
  if v_att.state = 'succeeded' then return; end if; -- idempotent
  update public.companion_transfer_attempts
     set state = 'succeeded',
         stripe_transfer_id = coalesce(stripe_transfer_id, p_transfer_id),
         stripe_created_at = coalesce(to_timestamp(p_created), stripe_created_at),
         failure_code = null, failure_message = null,
         completed_at = now(), updated_at = now()
   where id = p_attempt;
  update public.companion_earnings
     set transfer_state = 'transferred', updated_at = now()
   where id = v_att.earning_id;
  perform app_private.notify_account(
    v_att.companion_account_id, 'earning_transferred', 'Earnings sent to your payment account',
    'Your earnings have been sent to your payment account.',
    v_e.booking_id, 'transfer-sent:' || v_att.earning_id::text);
end;
$$;
revoke all on function public.finalize_transfer_succeeded(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.finalize_transfer_succeeded(uuid, text, bigint) to service_role;

create or replace function public.finalize_transfer_failed_retryable(
  p_attempt uuid, p_code text, p_message text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare v_att public.companion_transfer_attempts;
begin
  select * into v_att from public.companion_transfer_attempts where id = p_attempt for update;
  if v_att.id is null or v_att.state = 'succeeded' then return; end if; -- never un-succeed
  update public.companion_transfer_attempts
     set state = 'failed_retryable', failure_code = left(coalesce(p_code, 'provider_error'), 100),
         failure_message = left(coalesce(p_message, ''), 500), updated_at = now()
   where id = p_attempt;
  update public.companion_earnings set transfer_state = 'failed', updated_at = now()
   where id = v_att.earning_id and transfer_state = 'processing';
  -- No notification on a retryable failure.
end;
$$;
revoke all on function public.finalize_transfer_failed_retryable(uuid, text, text) from public, anon, authenticated;
grant execute on function public.finalize_transfer_failed_retryable(uuid, text, text) to service_role;

create or replace function public.finalize_transfer_failed_permanent(
  p_attempt uuid, p_code text, p_message text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_att public.companion_transfer_attempts;
  v_e public.companion_earnings;
begin
  select * into v_att from public.companion_transfer_attempts where id = p_attempt for update;
  if v_att.id is null or v_att.state = 'succeeded' then return; end if;
  select * into v_e from public.companion_earnings where id = v_att.earning_id for update;
  update public.companion_transfer_attempts
     set state = 'failed_permanent', failure_code = left(coalesce(p_code, 'permanent_error'), 100),
         failure_message = left(coalesce(p_message, ''), 500), completed_at = now(), updated_at = now()
   where id = p_attempt;
  update public.companion_earnings set transfer_state = 'failed', updated_at = now()
   where id = v_att.earning_id;
  perform app_private.notify_account(
    v_att.companion_account_id, 'earning_transfer_action', 'Action needed to receive your earnings',
    'We could not send your earnings automatically. Please check your payment setup.',
    v_e.booking_id, 'transfer-action:' || v_att.earning_id::text);
end;
$$;
revoke all on function public.finalize_transfer_failed_permanent(uuid, text, text) from public, anon, authenticated;
grant execute on function public.finalize_transfer_failed_permanent(uuid, text, text) to service_role;

-- transfer.reversed reconciliation (2G6B RECORDS this only; no refund logic).
create or replace function public.finalize_transfer_reversed(
  p_attempt uuid, p_code text default 'transfer_reversed'
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare v_att public.companion_transfer_attempts;
begin
  select * into v_att from public.companion_transfer_attempts where id = p_attempt for update;
  if v_att.id is null or v_att.state = 'reversed' then return; end if; -- idempotent
  update public.companion_transfer_attempts
     set state = 'reversed', failure_code = left(coalesce(p_code, 'transfer_reversed'), 100),
         updated_at = now()
   where id = p_attempt;
  update public.companion_earnings set transfer_state = 'reversed', updated_at = now()
   where id = v_att.earning_id;
end;
$$;
revoke all on function public.finalize_transfer_reversed(uuid, text) from public, anon, authenticated;
grant execute on function public.finalize_transfer_reversed(uuid, text) to service_role;

-- Webhook helper: resolve an attempt by Stripe transfer id (metadata is the
-- primary key path in the Edge Function; this is the fallback for webhooks).
create or replace function public.attempt_id_for_transfer(p_transfer_id text)
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select id from public.companion_transfer_attempts where stripe_transfer_id = p_transfer_id;
$$;
revoke all on function public.attempt_id_for_transfer(text) from public, anon, authenticated;
grant execute on function public.attempt_id_for_transfer(text) to service_role;

-- ------------------------------------------------------------
-- 6. Support-only operational overview (support-admin gated; no Stripe errors
--    or IDs leak to normal users — this RPC is only callable by support).
-- ------------------------------------------------------------
create or replace function public.support_settlement_overview()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare v jsonb;
begin
  if not app_private.is_support_admin() then
    raise exception 'not_found: overview';
  end if;
  select jsonb_build_object(
    'payable_waiting', (select count(*) from public.companion_earnings
                        where state = 'payable' and net_minor > 0
                          and transfer_state in ('not_ready', 'ready', 'failed')),
    'processing', (select count(*) from public.companion_transfer_attempts where state = 'processing'),
    'failed_retryable', (select count(*) from public.companion_transfer_attempts where state = 'failed_retryable'),
    'failed_permanent', (select count(*) from public.companion_transfer_attempts where state = 'failed_permanent'),
    'transferred', (select count(*) from public.companion_transfer_attempts where state = 'succeeded'),
    'reversed', (select count(*) from public.companion_transfer_attempts where state = 'reversed'),
    'stale_processing', (select count(*) from public.companion_transfer_attempts
                         where state = 'processing' and stripe_transfer_id is null
                           and claimed_at < now() - interval '30 minutes')
  ) into v;
  return v;
end;
$$;
revoke all on function public.support_settlement_overview() from public, anon;
grant execute on function public.support_settlement_overview() to authenticated; -- gated by is_support_admin()

select pg_notify('pgrst', 'reload schema');
