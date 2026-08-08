-- 0136 — Production companion payout execution (automated worker).
--
-- The scoped saga (scoped-stripe-transfers) hard-blocks production_live, and the
-- legacy stripe-transfers worker's claim (claim_plan_transfers) is gated by
-- app_private.batch_worker_enabled, which demands an unforgeable transaction-local
-- "scoped-execution context" that an ordinary PostgREST worker call can never set.
-- Net effect: NO code path could ever execute a live payout. This migration adds
-- a deliberate, automatable production execution path:
--
--   * public.claim_payable_transfers — same eligibility rails as claim_plan_transfers
--     (payout-ready, no open issue, no evidence hold, no live/succeeded attempt,
--     stable per-earning idempotency key) but gated ONLY by a single explicit
--     production switch, and additionally bounded by a per-transfer ceiling, a
--     daily aggregate ceiling and an optional destination allowlist.
--   * public.record_payout_insufficient_balance — records an alert and notifies
--     every support admin when a transfer can't be sent for lack of available
--     balance (settlement timing), so the platform owner is told rather than it
--     failing silently. The earning stays claimable and retries automatically.
--
-- claim_plan_transfers is left UNTOUCHED (still gated) for test compatibility; the
-- stripe-transfers Edge Function is repointed to claim_payable_transfers.

set search_path = '';

-- ------------------------------------------------------------
-- 1. Single-row config + optional destination allowlist.
-- ------------------------------------------------------------
create table if not exists public.payout_execution_config (
  id boolean primary key default true check (id),                 -- single-row guard
  enabled boolean not null default false,                         -- master production switch
  per_transfer_ceiling_minor integer not null default 25000 check (per_transfer_ceiling_minor > 0),
  daily_ceiling_minor integer not null default 250000 check (daily_ceiling_minor > 0),
  require_allowlist boolean not null default false,               -- false ⇒ any onboarded, ready account
  updated_at timestamptz not null default now()
);
insert into public.payout_execution_config (id) values (true) on conflict (id) do nothing;
alter table public.payout_execution_config enable row level security;   -- no client policies: service/support only

create table if not exists public.payout_destination_allowlist (
  stripe_account_id text primary key,
  note text,
  created_at timestamptz not null default now()
);
alter table public.payout_destination_allowlist enable row level security;

-- ------------------------------------------------------------
-- 2. Production gate (single explicit switch).
-- ------------------------------------------------------------
create or replace function app_private.production_payouts_enabled()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select enabled from public.payout_execution_config where id), false);
$$;
revoke all on function app_private.production_payouts_enabled() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Insufficient-balance alert: durable record + support notification.
-- ------------------------------------------------------------
create table if not exists public.payout_balance_alerts (
  id uuid primary key default gen_random_uuid(),
  earning_id uuid references public.companion_earnings(id),
  booking_id uuid references public.bookings(id),
  amount_minor integer not null,
  currency text not null default 'GBP',
  resolved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists payout_balance_alerts_earning_open
  on public.payout_balance_alerts (earning_id) where not resolved;
alter table public.payout_balance_alerts enable row level security;   -- no client policies

create or replace function public.record_payout_insufficient_balance(
  p_earning uuid, p_booking uuid, p_amount_minor integer, p_currency text default 'GBP')
returns void language plpgsql security definer set search_path = '' as $$
declare r record; v_dedupe text; v_gbp text;
begin
  v_gbp := to_char((p_amount_minor::numeric) / 100, 'FM999999990.00');

  insert into public.payout_balance_alerts (earning_id, booking_id, amount_minor, currency)
  values (p_earning, p_booking, p_amount_minor, coalesce(p_currency, 'GBP'))
  on conflict (earning_id) where not resolved do update set updated_at = now();

  for r in select account_id from public.support_admins loop
    v_dedupe := 'payout_lowbalance:' || p_earning::text || ':' || r.account_id::text;
    insert into public.notifications (user_id, type, title, body, related_booking_id, dedupe_key)
    values (r.account_id, 'payout_insufficient_balance',
      'Payout blocked: low balance',
      'A companion payout of £' || v_gbp || ' could not be sent because your available Stripe balance '
        || 'is too low. It will retry automatically once funds settle; top up your Stripe balance to '
        || 'release it sooner.',
      p_booking, v_dedupe)
    on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
  end loop;
end;
$$;
revoke all on function public.record_payout_insufficient_balance(uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function public.record_payout_insufficient_balance(uuid, uuid, integer, text) to service_role;

-- ------------------------------------------------------------
-- 4. Production claim — automatable, ceiling- and allowlist-bounded. Mirrors the
--    eligibility of claim_plan_transfers (0073) exactly; only the gate differs and
--    ceilings/allowlist are added. Same attempt row + stable idempotency key, so
--    the existing finalize_* RPCs and stripe-webhook reconciliation apply unchanged.
-- ------------------------------------------------------------
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
  v_cfg public.payout_execution_config;
  v_day_used integer;
  v_remaining integer;
  v_running integer := 0;
begin
  if not app_private.production_payouts_enabled() then return; end if;   -- single production switch
  select * into v_cfg from public.payout_execution_config where id;

  -- Daily aggregate ceiling: how much has already been claimed/sent today.
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
      and e.net_minor <= v_cfg.per_transfer_ceiling_minor                       -- per-transfer ceiling
      and (not v_cfg.require_allowlist
           or ca.stripe_account_id in (select stripe_account_id from public.payout_destination_allowlist))
    order by e.payable_at nulls last, e.created_at
    limit greatest(p_limit, 0)
    for update of e skip locked
  loop
    if v_running + r.net_minor > v_remaining then continue; end if;             -- daily ceiling budget

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

    v_running := v_running + r.net_minor;
    attempt_id := v_attempt; earning_id := r.earning_id;
    companion_account_id := r.companion_account_id; companion_profile_id := r.companion_profile_id;
    connected_account_id := r.stripe_account_id; amount_minor := r.net_minor; currency := 'GBP';
    booking_id := r.booking_id;
    stripe_idempotency_key := 'transfer-' || r.earning_id::text;   -- stable ⇒ exactly-once
    return next;
  end loop;
end;
$$;
revoke all on function public.claim_payable_transfers(integer) from public, anon, authenticated;
grant execute on function public.claim_payable_transfers(integer) to service_role;

select pg_notify('pgrst', 'reload schema');
