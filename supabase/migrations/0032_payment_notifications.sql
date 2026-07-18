-- ============================================================
-- 2G2 completion — trusted payment notifications + system events (0032).
--
-- Redefines the 0031 finalisation and closure functions to ALSO emit
-- deduplicated notifications (0023 notifications table) and, where a
-- thread exists, neutral system messages. Amounts shown to the paying
-- Coordinator only — never inside shared threads, never to Companions.
-- Deterministic dedupe keys make webhook retries and repeated booking
-- transitions no-ops. No behavioural change to money flows.
-- ============================================================

create or replace function app_private.notify_account(
  p_account uuid, p_type text, p_title text, p_body text,
  p_booking uuid, p_dedupe text
)
returns void
language sql security definer
set search_path = ''
as $$
  insert into public.notifications (user_id, type, title, body, related_booking_id, dedupe_key)
  values (p_account, p_type, p_title, coalesce(p_body, ''), p_booking, p_dedupe)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
$$;
revoke all on function app_private.notify_account(uuid, text, text, text, uuid, text)
  from public, anon, authenticated;

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
  v_companion_account uuid;
  v_companion_name text;
  v_kind text;
begin
  select * into v_order from public.payment_orders where id = p_order for update;
  if v_order.id is null then return; end if;
  if v_order.status not in ('pending', 'requires_action', 'processing') then return; end if;

  select p.first_name into v_companion_name
  from public.profiles p where p.id = v_order.companion_profile_id;

  if p_outcome = 'succeeded' then
    update public.payment_orders
       set status = 'succeeded',
           stripe_payment_intent_id = coalesce(p_intent, stripe_payment_intent_id),
           updated_at = now()
     where id = p_order;
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

    -- Coordinator: payment received + request sent (amount is theirs to see).
    perform app_private.notify_account(
      v_order.coordinator_account_id, 'payment_succeeded',
      'Payment received',
      'Your payment was received. ' || coalesce(v_companion_name, 'The Companion')
        || ' has been asked to confirm the conversation.',
      v_booking, 'payment_succeeded:' || v_order.id::text);

    -- Companion OWNER: a funded request (no amounts, no fees, no ids).
    v_kind := case when v_order.order_type = 'trial' then 'trial' else 'one-off' end;
    select pa.account_id into v_companion_account
    from public.profile_access pa
    where pa.profile_id = v_order.companion_profile_id
      and pa.access_role = 'owner' and pa.consent_status <> 'withdrawn'
    limit 1;
    if v_companion_account is not null then
      perform app_private.notify_account(
        v_companion_account, 'funded_request',
        'New ' || v_kind || ' conversation request',
        'A paid ' || v_kind || ' request is waiting for your response.',
        v_booking, 'funded_request:' || v_order.id::text);
    end if;

    -- Thread system event where the pair already has a conversation.
    begin
      perform app_private.post_system_message(
        c.id, 'paid_request_submitted', '{}'::jsonb,
        'paid_request_submitted:' || v_order.id::text)
      from public.conversations c
      where c.member_profile_id = v_order.member_profile_id
        and c.companion_profile_id = v_order.companion_profile_id;
    exception when others then null;
    end;
  else
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
    perform app_private.notify_account(
      v_order.coordinator_account_id,
      case when p_outcome = 'expired' then 'payment_expired' else 'payment_failed' end,
      case when p_outcome = 'expired' then 'Payment attempt expired' else 'Payment failed' end,
      case when p_outcome = 'expired'
        then 'Your payment attempt expired, so the request was not sent. Any reserved credit has been returned.'
        else 'Your payment didn’t go through, so the request was not sent. Any reserved credit has been returned.' end,
      null, 'payment_closed:' || v_order.id::text);
  end if;
end;
$$;
revoke all on function app_private.finalise_paid_order(uuid, text, text) from public, anon, authenticated;

create or replace function app_private.credit_on_request_closure()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.payment_orders;
  v_companion_name text;
begin
  if (new.status = 'declined' and old.status = 'requested')
     or (new.status = 'cancelled' and old.status = 'requested') then
    select * into v_order from public.payment_orders
     where booking_id = new.id and status = 'succeeded' for update;
    if v_order.id is not null then
      perform public.issue_account_credit(
        v_order.coordinator_account_id, v_order.total_minor,
        'companion_declined', v_order.id,
        case when new.status = 'declined'
          then 'The Companion declined the conversation request'
          else 'Request cancelled before the Companion responded' end,
        'closure-' || v_order.id::text);
      update public.payment_orders set status = 'credited', updated_at = now()
       where id = v_order.id;

      select p.first_name into v_companion_name
      from public.profiles p where p.id = v_order.companion_profile_id;
      -- Account credit — deliberately NOT described as a card refund.
      perform app_private.notify_account(
        v_order.coordinator_account_id, 'credit_issued',
        case when new.status = 'declined'
          then coalesce(v_companion_name, 'The Companion') || ' declined the request'
          else 'Request cancelled' end,
        '£' || to_char(v_order.total_minor / 100.0, 'FM999990.00')
          || ' was added to your account credit. Credit is applied automatically to your next booking.',
        new.id, 'credit_issued:' || v_order.id::text);
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
