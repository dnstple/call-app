-- ============================================================
-- 2G2 — paid trial and one-off requests (migration 0031).
--
-- Lifecycle: quote → create order (credit RESERVED by immediate spend,
-- card shortfall via PaymentIntent) → webhook-confirmed finalisation
-- creates the funded booking → Companion accept/decline. Credit-only
-- orders finalise atomically with NO PaymentIntent. Failure/expiry
-- releases the credit reservation exactly once. Decline or pre-response
-- cancellation credits the FULL customer total exactly once — never an
-- automatic card refund. All figures snapshotted in integer GBP minor
-- units; every write path is server-controlled.
--
-- Slot holds: an active order (pending/requires_action/processing) holds
-- its slot via a partial unique index; stale attempts are expired by
-- expire_stale_payment_orders (30-minute window, documented) which frees
-- the slot. Reschedule proposals in this phase REQUIRE the same duration
-- and snapshotted price — price-changing proposals are blocked until a
-- later adjustment flow (documented rule).
-- ============================================================

alter table public.payment_orders
  add column if not exists starts_at timestamptz,
  add column if not exists duration_minutes integer,
  add column if not exists offer_id uuid references public.conversation_offers(id),
  add column if not exists expires_at timestamptz;

do $$
begin
  alter table public.payment_orders drop constraint if exists payment_orders_status_check;
  alter table public.payment_orders add constraint payment_orders_status_check check (status in (
    'pending', 'requires_action', 'processing', 'succeeded', 'failed', 'expired',
    'credited', 'partially_refunded', 'refunded', 'disputed'));
end $$;

-- One trial per pair, PERMANENTLY: any non-failed trial order counts;
-- cancelling/crediting later never frees the pair.
create unique index if not exists payment_orders_one_trial_per_pair
  on public.payment_orders (member_profile_id, companion_profile_id)
  where order_type = 'trial' and status not in ('failed', 'expired');

-- Active orders hold their slot (freed when expired/failed).
create unique index if not exists payment_orders_slot_hold
  on public.payment_orders (companion_profile_id, starts_at)
  where status in ('pending', 'requires_action', 'processing');

-- ---------- pricing/fee helpers ----------
create or replace function app_private.active_service_fee(p_subtotal integer)
returns integer
language sql stable security definer
set search_path = ''
as $$
  select coalesce((
    select least(
             coalesce(c.max_minor, 2147483647),
             greatest(coalesce(c.min_minor, 0),
                      c.fixed_minor + floor(p_subtotal * c.percent_rate / 100)::integer))
    from public.platform_service_fee_config c
    where c.enabled and c.active_from <= now() and c.currency = 'GBP'
    order by c.active_from desc limit 1), 0);
$$;
revoke all on function app_private.active_service_fee(integer) from public, anon, authenticated;

create or replace function app_private.active_commission(p_type text)
returns numeric
language sql stable security definer
set search_path = ''
as $$
  select coalesce((
    select rate_pct from public.platform_commission_config
    where applies_to = p_type and active_from <= now()
    order by active_from desc limit 1), 0);
$$;
revoke all on function app_private.active_commission(text) from public, anon, authenticated;

-- Non-failed trials this MEMBER has used (allowance belongs to the Member).
create or replace function app_private.member_trial_count(p_member uuid)
returns integer
language sql stable security definer
set search_path = ''
as $$
  select count(*)::integer from public.payment_orders
  where member_profile_id = p_member
    and order_type = 'trial'
    and status not in ('failed', 'expired');
$$;
revoke all on function app_private.member_trial_count(uuid) from public, anon, authenticated;

-- ---------- quote (authenticated; server-derived prices only) ----------
create or replace function public.quote_paid_request(
  p_member uuid, p_companion uuid, p_offer uuid
)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_offer public.conversation_offers;
  v_type text;
  v_subtotal integer;
  v_fee integer;
  v_waived boolean := false;
  v_credit integer;
  v_rate numeric;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  if not exists (
    select 1 from public.profile_access pa
    where pa.profile_id = p_member and pa.account_id = auth.uid()
      and pa.can_book and pa.consent_status <> 'withdrawn'
  ) then
    raise exception 'not_found: member';
  end if;
  select * into v_offer from public.conversation_offers
   where id = p_offer and companion_profile_id = p_companion and active;
  if v_offer.id is null then raise exception 'not_found: offer'; end if;

  v_type := case when v_offer.offer_type = 'trial' then 'trial' else 'one_off' end;
  v_subtotal := v_offer.price_minor;
  v_fee := app_private.active_service_fee(v_subtotal);
  if v_type = 'trial' then
    if exists (select 1 from public.payment_orders
               where member_profile_id = p_member and companion_profile_id = p_companion
                 and order_type = 'trial' and status not in ('failed', 'expired')) then
      raise exception 'not_eligible: this Member has already had a trial with this Companion';
    end if;
    -- First five trials per MEMBER: the service fee (only) is waived.
    if app_private.member_trial_count(p_member) < 5 then
      v_waived := true;
      v_fee := 0;
    end if;
  end if;
  v_rate := app_private.active_commission(v_type);
  select coalesce(sum(remaining_minor), 0)::integer into v_credit
  from public.credit_ledger
  where coordinator_account_id = auth.uid() and entry_type = 'credit'
    and remaining_minor > 0 and expires_at > now();

  return jsonb_build_object(
    'type', v_type, 'currency', 'GBP',
    'subtotal_minor', v_subtotal, 'discount_minor', 0,
    'service_fee_minor', v_fee, 'trial_fee_waived', v_waived,
    'total_minor', v_subtotal + v_fee,
    'credit_applied_minor', least(v_credit, v_subtotal + v_fee),
    'card_amount_minor', greatest(0, v_subtotal + v_fee - v_credit),
    'commission_rate_pct', v_rate,
    'duration_minutes', v_offer.duration_minutes);
end;
$$;
revoke all on function public.quote_paid_request(uuid, uuid, uuid) from public, anon;
grant execute on function public.quote_paid_request(uuid, uuid, uuid) to authenticated;

-- ---------- create the order (credit reserved; card shortfall pending) --
create or replace function public.create_paid_request(
  p_member uuid, p_companion uuid, p_offer uuid,
  p_starts_at timestamptz, p_idempotency text
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote jsonb;
  v_order public.payment_orders;
  v_applied integer;
begin
  -- Idempotent: a replayed create returns the existing order.
  select * into v_order from public.payment_orders where idempotency_key = p_idempotency;
  if v_order.id is not null then
    return jsonb_build_object('order_id', v_order.id, 'status', v_order.status,
      'card_amount_minor', v_order.card_amount_minor);
  end if;

  v_quote := public.quote_paid_request(p_member, p_companion, p_offer);
  if p_starts_at is null or p_starts_at < now() then
    raise exception 'invalid_slot: choose a future time';
  end if;

  insert into public.payment_orders
    (coordinator_account_id, member_profile_id, companion_profile_id,
     order_type, status, subtotal_minor, discount_minor, service_fee_minor,
     credit_applied_minor, card_amount_minor, total_minor,
     commission_rate_pct, commission_minor,
     offer_id, starts_at, duration_minutes,
     idempotency_key, expires_at)
  values
    (auth.uid(), p_member, p_companion,
     v_quote->>'type', 'pending',
     (v_quote->>'subtotal_minor')::integer, 0, (v_quote->>'service_fee_minor')::integer,
     (v_quote->>'credit_applied_minor')::integer, (v_quote->>'card_amount_minor')::integer,
     (v_quote->>'total_minor')::integer,
     (v_quote->>'commission_rate_pct')::numeric,
     floor((v_quote->>'subtotal_minor')::integer * (v_quote->>'commission_rate_pct')::numeric / 100)::integer,
     p_offer, p_starts_at, (v_quote->>'duration_minutes')::integer,
     p_idempotency, now() + interval '30 minutes')
  returning * into v_order;

  -- Reserve the credit portion NOW (atomic FIFO spend, idempotent).
  if v_order.credit_applied_minor > 0 then
    v_applied := public.spend_account_credit(
      auth.uid(), v_order.credit_applied_minor,
      case when v_order.order_type = 'trial' then 'trial_purchase' else 'one_off_purchase' end,
      v_order.id, v_order.id, 'Reserved for conversation request', 'spend-' || v_order.id::text);
    if v_applied < v_order.credit_applied_minor then
      -- Concurrent spend won the race: recompute the card share honestly.
      update public.payment_orders
         set credit_applied_minor = v_applied,
             card_amount_minor = total_minor - v_applied
       where id = v_order.id
       returning * into v_order;
    end if;
  end if;

  -- Credit fully covers the purchase → finalise atomically, NO Stripe.
  if v_order.card_amount_minor = 0 then
    perform app_private.finalise_paid_order(v_order.id, 'succeeded', null);
    select * into v_order from public.payment_orders where id = v_order.id;
  end if;

  return jsonb_build_object('order_id', v_order.id, 'status', v_order.status,
    'card_amount_minor', v_order.card_amount_minor);
end;
$$;
revoke all on function public.create_paid_request(uuid, uuid, uuid, timestamptz, text) from public, anon;
grant execute on function public.create_paid_request(uuid, uuid, uuid, timestamptz, text) to authenticated;

-- ---------- finalisation (webhook / internal only) ----------
create or replace function app_private.finalise_paid_order(
  p_order uuid, p_outcome text, p_intent text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.payment_orders;
  v_booking uuid;
begin
  select * into v_order from public.payment_orders where id = p_order for update;
  if v_order.id is null then return; end if;
  -- Exactly-once: only live states may finalise.
  if v_order.status not in ('pending', 'requires_action', 'processing') then return; end if;

  if p_outcome = 'succeeded' then
    update public.payment_orders
       set status = 'succeeded',
           stripe_payment_intent_id = coalesce(p_intent, stripe_payment_intent_id),
           updated_at = now()
     where id = p_order;
    -- The FUNDED booking request appears only now.
    insert into public.bookings
      (member_profile_id, companion_profile_id, booked_by_account_id, offer_id,
       starts_at, ends_at, timezone, communication_method, status, duration_minutes,
       price_minor, currency, platform_fee_rate, platform_fee_minor,
       companion_amount_minor, is_trial)
    values
      (v_order.member_profile_id, v_order.companion_profile_id,
       v_order.coordinator_account_id, v_order.offer_id,
       v_order.starts_at, v_order.starts_at + make_interval(mins => v_order.duration_minutes),
       'Europe/London', 'in_app', 'requested', v_order.duration_minutes,
       v_order.subtotal_minor, 'GBP', v_order.commission_rate_pct,
       v_order.commission_minor,
       v_order.subtotal_minor - v_order.commission_minor, v_order.order_type = 'trial')
    returning id into v_booking;
    update public.payment_orders set booking_id = v_booking where id = p_order;
  else
    -- Failure/expiry: release the credit reservation exactly once.
    update public.payment_orders
       set status = case when p_outcome = 'expired' then 'expired' else 'failed' end,
           failure_reason = p_outcome, updated_at = now()
     where id = p_order;
    if v_order.credit_applied_minor > 0 then
      perform public.issue_account_credit(
        v_order.coordinator_account_id, v_order.credit_applied_minor,
        'platform_failure', v_order.id,
        'Reservation released: payment did not complete', 'release-' || v_order.id::text);
    end if;
  end if;
end;
$$;
revoke all on function app_private.finalise_paid_order(uuid, text, text) from public, anon, authenticated;

create or replace function public.finalize_paid_order(p_order uuid, p_outcome text, p_intent text)
returns void
language sql security definer
set search_path = ''
as $$
  select app_private.finalise_paid_order(p_order, p_outcome, p_intent);
$$;
revoke all on function public.finalize_paid_order(uuid, text, text) from public, anon, authenticated;
grant execute on function public.finalize_paid_order(uuid, text, text) to service_role;

-- Free abandoned slots (documented 30-minute attempt window).
create or replace function public.expire_stale_payment_orders()
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count integer := 0;
begin
  for v_row in
    select id from public.payment_orders
    where status in ('pending', 'requires_action', 'processing')
      and expires_at < now()
    for update skip locked
  loop
    perform app_private.finalise_paid_order(v_row.id, 'expired', null);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.expire_stale_payment_orders() from public, anon, authenticated;
grant execute on function public.expire_stale_payment_orders() to service_role;

-- ---------- decline / pre-response cancellation → FULL credit, once ----
create or replace function app_private.credit_on_request_closure()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.payment_orders;
begin
  -- Declined by the Companion, or cancelled while still 'requested'.
  if (new.status = 'declined' and old.status = 'requested')
     or (new.status = 'cancelled' and old.status = 'requested') then
    select * into v_order from public.payment_orders
     where booking_id = new.id and status = 'succeeded' for update;
    if v_order.id is not null then
      -- Full customer total (conversation value + service fee), once.
      perform public.issue_account_credit(
        v_order.coordinator_account_id, v_order.total_minor,
        'companion_declined', v_order.id,
        case when new.status = 'declined'
          then 'The Companion declined the conversation request'
          else 'Request cancelled before the Companion responded' end,
        'closure-' || v_order.id::text);
      update public.payment_orders set status = 'credited', updated_at = now()
       where id = v_order.id;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app_private.credit_on_request_closure() from public, anon, authenticated;
drop trigger if exists bookings_credit_on_closure on public.bookings;
create trigger bookings_credit_on_closure
  after update on public.bookings
  for each row execute function app_private.credit_on_request_closure();
