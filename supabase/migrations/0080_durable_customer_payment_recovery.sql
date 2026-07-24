-- ============================================================================
-- 0080 — Stage 3D-B1: durable customer-payment state and idempotent recovery.
--
-- ADDITIVE ONLY. Migrations 0001–0079 are immutable and untouched. The
-- validated exactly-once core (server prices, unique idempotency_key /
-- stripe_payment_intent_id / stripe_checkout_session_id, row-locked
-- status-guarded app_private.finalise_paid_order, one-transaction booking
-- creation, 'spend-'/'release-' credit keys, webhook ledger-before-effects)
-- is preserved; this migration only ADDS a durable projection, an owner-safe
-- status RPC, one shared idempotent reconciliation path wrapping the existing
-- finaliser, and a support visibility surface.
--
-- Design (audit §13/§15):
--   provider_payment_status   — last server-observed Stripe intent state
--                               ('none' for credit-only orders).
--   local_finalisation_status — pending / finalising / completed /
--                               reconciliation_required.
--   customer status           — DERIVED (single authority), never stored.
-- No client secrets, no provider payloads, no card data are stored.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Durable projection columns (additive; safe defaults for existing rows).
-- ----------------------------------------------------------------------------
alter table public.payment_orders
  add column if not exists provider_payment_status text not null default 'unknown',
  add column if not exists local_finalisation_status text not null default 'pending',
  add column if not exists provider_synced_at timestamptz,
  add column if not exists provider_event_at timestamptz,
  add column if not exists finalised_at timestamptz,
  add column if not exists reconciliation_code text,
  add column if not exists last_reconciliation_at timestamptz;

alter table public.payment_orders
  drop constraint if exists payment_orders_provider_payment_status_check;
alter table public.payment_orders
  add constraint payment_orders_provider_payment_status_check
  check (provider_payment_status in
    ('none', 'requires_payment_method', 'requires_confirmation', 'requires_action',
     'processing', 'succeeded', 'failed', 'canceled', 'unknown'));

alter table public.payment_orders
  drop constraint if exists payment_orders_local_finalisation_status_check;
alter table public.payment_orders
  add constraint payment_orders_local_finalisation_status_check
  check (local_finalisation_status in
    ('pending', 'finalising', 'completed', 'reconciliation_required'));

-- A reconciliation state must always carry a safe reason code.
alter table public.payment_orders
  drop constraint if exists payment_orders_reconciliation_code_check;
alter table public.payment_orders
  add constraint payment_orders_reconciliation_code_check
  check (local_finalisation_status <> 'reconciliation_required'
         or reconciliation_code is not null);

-- Backfill existing rows once (historically terminal orders are complete;
-- credit-only orders never had a provider object).
update public.payment_orders
   set local_finalisation_status = case
         when status in ('succeeded', 'failed', 'expired', 'credited',
                         'partially_refunded', 'refunded', 'disputed')
           then 'completed' else 'pending' end,
       finalised_at = case
         when status in ('succeeded', 'failed', 'expired', 'credited',
                         'partially_refunded', 'refunded', 'disputed')
           then updated_at else null end,
       provider_payment_status = case
         when card_amount_minor = 0 then 'none'
         when status in ('succeeded', 'credited', 'partially_refunded',
                         'refunded', 'disputed') then 'succeeded'
         when status = 'failed' then 'failed'
         else 'unknown' end
 where local_finalisation_status = 'pending';

-- Support-queue partial index: provider succeeded but locally incomplete, or
-- flagged for reconciliation.
create index if not exists payment_orders_pending_paid_idx
  on public.payment_orders (updated_at desc)
  where (provider_payment_status = 'succeeded'
         and local_finalisation_status <> 'completed')
     or local_finalisation_status = 'reconciliation_required';

-- ----------------------------------------------------------------------------
-- 2. Customer-status derivation — the ONE authority mapping durable facts to
--    the Stage 3D-C vocabulary. STABLE (uses now() for the delayed state).
-- ----------------------------------------------------------------------------
create or replace function app_private.payment_order_customer_status(v public.payment_orders)
returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_seen timestamptz;
begin
  if v.local_finalisation_status = 'reconciliation_required' then
    return 'reconciliation_required';
  end if;
  if v.status in ('succeeded', 'credited', 'partially_refunded', 'refunded', 'disputed') then
    return 'completed';
  end if;
  if v.status = 'expired' then
    return 'cancelled';
  end if;
  if v.status = 'failed' then
    return case
      when v.provider_payment_status = 'canceled'
        or v.failure_reason = 'payment_cancelled' then 'cancelled'
      else 'failed' end;
  end if;
  -- Live order below ('pending' / 'requires_action' / 'processing').
  if v.provider_payment_status = 'succeeded' then
    v_seen := greatest(coalesce(v.provider_event_at, 'epoch'::timestamptz),
                       coalesce(v.provider_synced_at, 'epoch'::timestamptz),
                       v.updated_at);
    return case when v_seen < now() - interval '2 minutes'
                then 'confirmation_delayed'
                else 'payment_received_confirming' end;
  end if;
  if v.provider_payment_status in ('requires_action', 'requires_confirmation')
     or v.status = 'requires_action' then
    return 'awaiting_bank_authentication';
  end if;
  if v.provider_payment_status = 'processing' or v.status = 'processing' then
    return 'processing';
  end if;
  -- Fresh order, provider unknown / requires_payment_method / none yet.
  return 'awaiting_payment_method';
end;
$$;
revoke all on function app_private.payment_order_customer_status(public.payment_orders)
  from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. Owner-safe status RPC. The payer (the order's coordinator account) and
--    ONLY the payer may read it. Neutral not_found for everyone else — no
--    existence leak, no cross-account PaymentIntent exposure, no secrets, no
--    provider payloads.
-- ----------------------------------------------------------------------------
create or replace function public.get_payment_order_status(p_order uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v public.payment_orders;
begin
  if auth.uid() is null then
    return jsonb_build_object('found', false);
  end if;
  select * into v from public.payment_orders
   where id = p_order and coordinator_account_id = auth.uid();
  if v.id is null then
    return jsonb_build_object('found', false);
  end if;
  return jsonb_build_object(
    'found', true,
    'order_id', v.id,
    'customer_status', app_private.payment_order_customer_status(v),
    'order_status', v.status,
    'provider_status', v.provider_payment_status,
    'local_finalisation_status', v.local_finalisation_status,
    'reconciliation_code', v.reconciliation_code,
    'order_type', v.order_type,
    'total_minor', v.total_minor,
    'card_amount_minor', v.card_amount_minor,
    'credit_applied_minor', v.credit_applied_minor,
    'currency', v.currency,
    'booking_id', v.booking_id,
    'created_at', v.created_at,
    'updated_at', v.updated_at,
    'finalised_at', v.finalised_at);
end;
$$;
revoke all on function public.get_payment_order_status(uuid) from public, anon;
grant execute on function public.get_payment_order_status(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 4. Shared idempotent reconciliation path — the ONE entry point for the
--    webhook, the server-side check action, future browser recovery and
--    support tooling. Only server-observed provider facts arrive here (the
--    browser can never assert success: the wrapper below is service_role
--    only, and the Edge caller feeds it Stripe's own retrieved/verified
--    values). Wraps — never replaces — app_private.finalise_paid_order.
-- ----------------------------------------------------------------------------
create or replace function app_private.reconcile_payment_order(
  p_order uuid, p_intent text, p_provider_status text,
  p_amount_minor bigint, p_currency text, p_event_at timestamptz,
  p_metadata_order uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.payment_orders;
  v_status text;
  v_already boolean;
begin
  select * into v from public.payment_orders where id = p_order for update;
  if v.id is null then
    return jsonb_build_object('ok', false, 'reason', 'order_not_found');
  end if;

  -- Expected-intent verification: a stored intent id is authoritative. A
  -- different intent NEVER finalises this order and flags reconciliation.
  if p_intent is not null and v.stripe_payment_intent_id is not null
     and v.stripe_payment_intent_id <> p_intent then
    update public.payment_orders
       set local_finalisation_status = 'reconciliation_required',
           reconciliation_code = 'intent_mismatch',
           last_reconciliation_at = now(), updated_at = now()
     where id = p_order
       and status not in ('succeeded', 'credited', 'partially_refunded', 'refunded', 'disputed');
    return jsonb_build_object('ok', false, 'reason', 'intent_mismatch', 'order_id', v.id);
  end if;

  -- Metadata/ownership linkage: when the provider object's recorded order
  -- linkage is known and points at a DIFFERENT purchase, never finalise.
  if p_metadata_order is not null and p_metadata_order <> p_order then
    update public.payment_orders
       set local_finalisation_status = 'reconciliation_required',
           reconciliation_code = 'metadata_mismatch',
           last_reconciliation_at = now(), updated_at = now()
     where id = p_order
       and status not in ('succeeded', 'credited', 'partially_refunded', 'refunded', 'disputed');
    return jsonb_build_object('ok', false, 'reason', 'metadata_mismatch', 'order_id', v.id);
  end if;

  v_status := case when p_provider_status in
      ('requires_payment_method', 'requires_confirmation', 'requires_action',
       'processing', 'succeeded', 'failed', 'canceled')
    then p_provider_status else 'unknown' end;

  -- Projection (always safe; never regresses a terminal local state).
  update public.payment_orders
     set provider_payment_status = v_status,
         provider_synced_at = now(),
         provider_event_at = coalesce(p_event_at, provider_event_at),
         updated_at = now()
   where id = p_order;

  v_already := v.status in ('succeeded', 'credited', 'partially_refunded', 'refunded', 'disputed');

  if v_status = 'succeeded' then
    -- Amount and currency must match the local snapshot EXACTLY.
    if p_amount_minor is not null and p_amount_minor <> v.card_amount_minor then
      update public.payment_orders
         set local_finalisation_status = 'reconciliation_required',
             reconciliation_code = 'amount_mismatch',
             last_reconciliation_at = now(), updated_at = now()
       where id = p_order and not v_already;
      return jsonb_build_object('ok', false, 'reason', 'amount_mismatch', 'order_id', v.id);
    end if;
    if p_currency is not null and upper(p_currency) <> 'GBP' then
      update public.payment_orders
         set local_finalisation_status = 'reconciliation_required',
             reconciliation_code = 'currency_mismatch',
             last_reconciliation_at = now(), updated_at = now()
       where id = p_order and not v_already;
      return jsonb_build_object('ok', false, 'reason', 'currency_mismatch', 'order_id', v.id);
    end if;

    if v_already then
      -- Idempotent repeat: settle the projection, change nothing financial.
      update public.payment_orders
         set local_finalisation_status = 'completed',
             finalised_at = coalesce(finalised_at, now()),
             reconciliation_code = null,
             updated_at = now()
       where id = p_order;
      return jsonb_build_object('ok', true, 'already_finalised', true, 'order_id', v.id);
    end if;

    update public.payment_orders
       set local_finalisation_status = 'finalising', updated_at = now()
     where id = p_order;
    begin
      perform app_private.finalise_paid_order(p_order, 'succeeded', p_intent);
    exception when others then
      update public.payment_orders
         set local_finalisation_status = 'reconciliation_required',
             reconciliation_code = 'finalise_error',
             last_reconciliation_at = now(), updated_at = now()
       where id = p_order;
      return jsonb_build_object('ok', false, 'reason', 'finalise_error', 'order_id', v.id);
    end;
    select * into v from public.payment_orders where id = p_order;
    if v.status in ('succeeded', 'credited', 'partially_refunded', 'refunded', 'disputed') then
      update public.payment_orders
         set local_finalisation_status = 'completed',
             finalised_at = coalesce(finalised_at, now()),
             reconciliation_code = null, updated_at = now()
       where id = p_order;
      return jsonb_build_object('ok', true, 'finalised', true, 'order_id', v.id,
                                'booking_id', v.booking_id);
    end if;
    -- Provider success but the guarded finaliser would not settle (e.g. the
    -- order had already expired locally): never guess — flag it.
    update public.payment_orders
       set local_finalisation_status = 'reconciliation_required',
           reconciliation_code = 'finalise_incomplete',
           last_reconciliation_at = now(), updated_at = now()
     where id = p_order;
    return jsonb_build_object('ok', false, 'reason', 'finalise_incomplete', 'order_id', v.id);
  end if;

  if v_status in ('failed', 'canceled') then
    -- Any locally terminal order repeats idempotently (success-family AND
    -- failed/expired): nothing financial may run twice.
    if v_already or v.status in ('failed', 'expired') then
      return jsonb_build_object('ok', true, 'already_finalised', true, 'order_id', v.id);
    end if;
    -- Existing failure semantics (credit released exactly once inside).
    perform app_private.finalise_paid_order(
      p_order,
      case when v_status = 'canceled' then 'payment_cancelled' else 'failed' end,
      p_intent);
    update public.payment_orders
       set local_finalisation_status = 'completed',
           finalised_at = coalesce(finalised_at, now()), updated_at = now()
     where id = p_order;
    return jsonb_build_object('ok', true, 'failed', true, 'order_id', v.id);
  end if;

  -- Non-terminal provider states: projection only.
  select * into v from public.payment_orders where id = p_order;
  return jsonb_build_object('ok', true, 'projected', true, 'order_id', v.id,
    'customer_status', app_private.payment_order_customer_status(v));
end;
$$;
revoke all on function app_private.reconcile_payment_order(uuid, text, text, bigint, text, timestamptz, uuid)
  from public, anon, authenticated;

create or replace function public.reconcile_payment_order(
  p_order uuid, p_intent text, p_provider_status text,
  p_amount_minor bigint, p_currency text, p_event_at timestamptz,
  p_metadata_order uuid default null
)
returns jsonb
language sql security definer
set search_path = ''
as $$
  select app_private.reconcile_payment_order(
    p_order, p_intent, p_provider_status, p_amount_minor, p_currency, p_event_at,
    p_metadata_order);
$$;
revoke all on function public.reconcile_payment_order(uuid, text, text, bigint, text, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.reconcile_payment_order(uuid, text, text, bigint, text, timestamptz, uuid)
  to service_role;

-- ----------------------------------------------------------------------------
-- 5. Support visibility: paid-but-unfinalised / reconciliation-required
--    orders. Support admins only (0034 gate). READ ONLY — no mutation here.
-- ----------------------------------------------------------------------------
create or replace function public.support_list_pending_paid_orders(
  p_min_age_minutes integer default 0
)
returns table (
  order_id uuid,
  coordinator_account_id uuid,
  booking_id uuid,
  order_type text,
  order_status text,
  provider_status text,
  local_finalisation_status text,
  reconciliation_code text,
  customer_status text,
  total_minor integer,
  card_amount_minor integer,
  currency text,
  created_at timestamptz,
  updated_at timestamptz,
  provider_synced_at timestamptz,
  last_reconciliation_at timestamptz
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not app_private.is_support_admin() then
    raise exception 'support_only' using errcode = '42501';
  end if;
  return query
    select o.id, o.coordinator_account_id, o.booking_id, o.order_type,
           o.status, o.provider_payment_status, o.local_finalisation_status,
           o.reconciliation_code,
           app_private.payment_order_customer_status(o),
           o.total_minor, o.card_amount_minor, o.currency,
           o.created_at, o.updated_at, o.provider_synced_at,
           o.last_reconciliation_at
      from public.payment_orders o
     where ((o.provider_payment_status = 'succeeded'
             and o.local_finalisation_status <> 'completed')
            or o.local_finalisation_status = 'reconciliation_required')
       and o.updated_at <= now() - make_interval(mins => greatest(p_min_age_minutes, 0))
     order by o.updated_at desc
     limit 200;
end;
$$;
revoke all on function public.support_list_pending_paid_orders(integer) from public, anon;
grant execute on function public.support_list_pending_paid_orders(integer) to authenticated;
