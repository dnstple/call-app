-- ============================================================
-- 2G1 — Stripe TEST-MODE foundation (migration 0030).
--
-- Integer minor units only; GBP only; append-only money records; RLS on
-- every client-visible table with ZERO client write policies. Browsers
-- never supply prices, rates or statuses — Edge Functions (service role)
-- and SECURITY DEFINER RPCs are the only write paths. Secrets never
-- enter the database. Historical simulated records (is_simulated=true)
-- are provider='simulation' by definition and are NEVER reconciled
-- against Stripe.
-- ============================================================

-- ---------- Stripe customers (the Coordinator, never the Member) ----------
create table if not exists public.stripe_customers (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  stripe_customer_id text not null unique,
  default_payment_method_id text,
  payment_method_ready boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.stripe_customers enable row level security;
drop policy if exists "stripe_customers: read own" on public.stripe_customers;
create policy "stripe_customers: read own" on public.stripe_customers
  for select to authenticated using (account_id = auth.uid());

-- ---------- Connect accounts (skeleton; 2G3 fills the lifecycle) ----------
create table if not exists public.connected_accounts (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  stripe_account_id text not null unique,
  onboarding_started_at timestamptz,
  details_submitted boolean not null default false,
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  requirements_due text[] not null default '{}',
  requirements_past_due text[] not null default '{}',
  disabled_reason text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.connected_accounts enable row level security;
drop policy if exists "connected_accounts: read own" on public.connected_accounts;
create policy "connected_accounts: read own" on public.connected_accounts
  for select to authenticated using (account_id = auth.uid());

-- ---------- payment orders (one per purchase attempt) ----------
create table if not exists public.payment_orders (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'stripe_test' check (provider in ('stripe_test', 'simulation')),
  coordinator_account_id uuid not null references public.accounts(id),
  member_profile_id uuid references public.profiles(id),
  companion_profile_id uuid references public.profiles(id),
  order_type text not null check (order_type in ('trial', 'one_off', 'plan_period', 'plan_adjustment')),
  status text not null default 'pending' check (status in (
    'pending', 'requires_action', 'processing', 'succeeded', 'failed',
    'credited', 'partially_refunded', 'refunded', 'disputed')),
  currency text not null default 'GBP' check (currency = 'GBP'),
  -- All figures snapshotted in integer minor units at order time.
  subtotal_minor integer not null check (subtotal_minor >= 0),
  discount_minor integer not null default 0 check (discount_minor >= 0),
  service_fee_minor integer not null default 0 check (service_fee_minor >= 0),
  credit_applied_minor integer not null default 0 check (credit_applied_minor >= 0),
  card_amount_minor integer not null default 0 check (card_amount_minor >= 0),
  total_minor integer not null check (total_minor >= 0),
  commission_rate_pct numeric(5,2) not null,
  commission_minor integer not null default 0 check (commission_minor >= 0),
  stripe_payment_intent_id text unique,
  stripe_checkout_session_id text unique,
  booking_id uuid references public.bookings(id),
  plan_id uuid references public.conversation_plans(id),
  idempotency_key text not null unique,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (total_minor = subtotal_minor - discount_minor + service_fee_minor),
  check (credit_applied_minor + card_amount_minor = total_minor)
);
create index if not exists payment_orders_coordinator_idx
  on public.payment_orders (coordinator_account_id, created_at desc);
alter table public.payment_orders enable row level security;
drop policy if exists "payment_orders: coordinator reads own" on public.payment_orders;
create policy "payment_orders: coordinator reads own" on public.payment_orders
  for select to authenticated using (coordinator_account_id = auth.uid());

-- ---------- webhook events (persisted BEFORE side effects) ----------
create table if not exists public.stripe_webhook_events (
  id text primary key,                -- Stripe event id: natural idempotency
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  result text
);
alter table public.stripe_webhook_events enable row level security;
-- No client policies at all: service-role only.

-- ---------- configurable commission (history is never rewritten) ----------
create table if not exists public.platform_commission_config (
  id uuid primary key default gen_random_uuid(),
  applies_to text not null check (applies_to in ('trial', 'one_off', 'plan')),
  rate_pct numeric(5,2) not null check (rate_pct >= 0 and rate_pct <= 100),
  active_from timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.platform_commission_config enable row level security;
drop policy if exists "commission config: readable" on public.platform_commission_config;
create policy "commission config: readable" on public.platform_commission_config
  for select to authenticated using (true);
insert into public.platform_commission_config (applies_to, rate_pct)
select v.applies_to, v.rate_pct
from (values ('trial', 0.00), ('one_off', 5.00), ('plan', 5.00)) as v(applies_to, rate_pct)
where not exists (select 1 from public.platform_commission_config);

-- ---------- configurable customer service fee (engine, NOT an amount) ----
-- Development default: DISABLED and zero. A non-zero fee can never apply
-- silently — it requires an explicit enabled row with an activation date.
create table if not exists public.platform_service_fee_config (
  id uuid primary key default gen_random_uuid(),
  currency text not null default 'GBP' check (currency = 'GBP'),
  fixed_minor integer not null default 0 check (fixed_minor >= 0),
  percent_rate numeric(5,2) not null default 0 check (percent_rate >= 0),
  min_minor integer,
  max_minor integer,
  enabled boolean not null default false,
  active_from timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.platform_service_fee_config enable row level security;
drop policy if exists "service fee config: readable" on public.platform_service_fee_config;
create policy "service fee config: readable" on public.platform_service_fee_config
  for select to authenticated using (true);
insert into public.platform_service_fee_config (currency, fixed_minor, percent_rate, enabled)
select 'GBP', 0, 0, false
where not exists (select 1 from public.platform_service_fee_config);

-- ---------- account credit: append-only ledger ----------
create table if not exists public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  coordinator_account_id uuid not null references public.accounts(id),
  entry_type text not null check (entry_type in ('credit', 'debit')),
  source_type text not null check (source_type in (
    'companion_declined', 'eligible_cancellation', 'plan_reduction', 'plan_paused',
    'plan_ended', 'platform_failure', 'refund_resolution', 'support_adjustment',
    'trial_purchase', 'one_off_purchase', 'plan_renewal', 'plan_addition', 'service_fee')),
  source_id uuid,
  payment_order_id uuid references public.payment_orders(id),
  amount_minor integer not null check (amount_minor > 0),
  -- credits only: how much is still spendable (server-maintained).
  remaining_minor integer check (remaining_minor >= 0),
  currency text not null default 'GBP' check (currency = 'GBP'),
  reason text not null,
  idempotency_key text not null unique,
  issued_at timestamptz not null default now(),
  -- credits expire 12 months after issue; debits carry no expiry.
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  check (entry_type <> 'credit' or (remaining_minor is not null and expires_at is not null))
);
create index if not exists credit_ledger_owner_idx
  on public.credit_ledger (coordinator_account_id, expires_at);
alter table public.credit_ledger enable row level security;
drop policy if exists "credit_ledger: coordinator reads own" on public.credit_ledger;
create policy "credit_ledger: coordinator reads own" on public.credit_ledger
  for select to authenticated using (coordinator_account_id = auth.uid());

-- Which credit rows funded which debit (full audit of FIFO consumption).
create table if not exists public.credit_spend_allocations (
  id uuid primary key default gen_random_uuid(),
  credit_entry_id uuid not null references public.credit_ledger(id),
  debit_entry_id uuid not null references public.credit_ledger(id),
  amount_minor integer not null check (amount_minor > 0),
  created_at timestamptz not null default now()
);
alter table public.credit_spend_allocations enable row level security;
drop policy if exists "credit allocations: read own" on public.credit_spend_allocations;
create policy "credit allocations: read own" on public.credit_spend_allocations
  for select to authenticated using (
    exists (select 1 from public.credit_ledger cl
            where cl.id = credit_entry_id and cl.coordinator_account_id = auth.uid())
  );

-- ---------- server-only credit operations ----------
-- Issue credit (service role / trusted functions only). Idempotent.
create or replace function public.issue_account_credit(
  p_account uuid, p_amount integer, p_source_type text, p_source uuid,
  p_reason text, p_idempotency text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount: credit must be a positive minor-unit amount';
  end if;
  insert into public.credit_ledger
    (coordinator_account_id, entry_type, source_type, source_id,
     amount_minor, remaining_minor, currency, reason, idempotency_key,
     expires_at)
  values
    (p_account, 'credit', p_source_type, p_source,
     p_amount, p_amount, 'GBP', p_reason, p_idempotency,
     now() + interval '12 months')
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.credit_ledger where idempotency_key = p_idempotency;
  end if;
  return v_id;
end;
$$;
revoke all on function public.issue_account_credit(uuid, integer, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.issue_account_credit(uuid, integer, text, uuid, text, text)
  to service_role;

-- Spend credit FIFO by earliest expiry, atomically, double-spend-proof.
create or replace function public.spend_account_credit(
  p_account uuid, p_amount integer, p_source_type text, p_source uuid,
  p_order uuid, p_reason text, p_idempotency text
)
returns integer  -- the amount actually covered by credit
language plpgsql security definer
set search_path = ''
as $$
declare
  v_needed integer := p_amount;
  v_debit uuid;
  v_row record;
  v_take integer;
begin
  if p_amount is null or p_amount <= 0 then return 0; end if;
  -- Idempotency: a replayed spend returns its original result.
  select amount_minor into v_take from public.credit_ledger
   where idempotency_key = p_idempotency;
  if v_take is not null then return v_take; end if;

  -- Lock the account's live credit rows (earliest expiry first).
  for v_row in
    select id, remaining_minor from public.credit_ledger
    where coordinator_account_id = p_account
      and entry_type = 'credit'
      and remaining_minor > 0
      and expires_at > now()
    order by expires_at asc, issued_at asc
    for update
  loop
    exit when v_needed <= 0;
    v_take := least(v_row.remaining_minor, v_needed);
    if v_debit is null then
      insert into public.credit_ledger
        (coordinator_account_id, entry_type, source_type, source_id,
         payment_order_id, amount_minor, currency, reason, idempotency_key)
      values
        (p_account, 'debit', p_source_type, p_source,
         p_order, least(p_amount, (
            select coalesce(sum(remaining_minor), 0) from public.credit_ledger
            where coordinator_account_id = p_account and entry_type = 'credit'
              and remaining_minor > 0 and expires_at > now())),
         'GBP', p_reason, p_idempotency)
      returning id into v_debit;
    end if;
    update public.credit_ledger
       set remaining_minor = remaining_minor - v_take
     where id = v_row.id;
    insert into public.credit_spend_allocations (credit_entry_id, debit_entry_id, amount_minor)
    values (v_row.id, v_debit, v_take);
    v_needed := v_needed - v_take;
  end loop;

  return p_amount - greatest(v_needed, 0);
end;
$$;
revoke all on function public.spend_account_credit(uuid, integer, text, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.spend_account_credit(uuid, integer, text, uuid, uuid, text, text)
  to service_role;

-- Coordinator-facing balance summary (server-derived, never a stored number).
create or replace function public.get_credit_summary()
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'available_minor', coalesce((
      select sum(remaining_minor) from public.credit_ledger
      where coordinator_account_id = auth.uid()
        and entry_type = 'credit' and remaining_minor > 0 and expires_at > now()), 0),
    'expiring_next_minor', coalesce((
      select remaining_minor from public.credit_ledger
      where coordinator_account_id = auth.uid()
        and entry_type = 'credit' and remaining_minor > 0 and expires_at > now()
      order by expires_at asc limit 1), 0),
    'expiring_next_at', (
      select expires_at from public.credit_ledger
      where coordinator_account_id = auth.uid()
        and entry_type = 'credit' and remaining_minor > 0 and expires_at > now()
      order by expires_at asc limit 1),
    'currency', 'GBP');
$$;
revoke all on function public.get_credit_summary() from public, anon;
grant execute on function public.get_credit_summary() to authenticated;
