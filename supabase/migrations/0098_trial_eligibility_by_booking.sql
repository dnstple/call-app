-- 0098 — Trial eligibility keys off trial BOOKINGS, not pending payment orders.
--
-- Bug (Block 10): trial eligibility was decided by the existence of a
-- payment_orders row of order_type 'trial' whose status was not 'failed' /
-- 'expired'. That row is created at 'pending' the moment a Coordinator opens
-- the paid-request flow — BEFORE any payment succeeds and long before the
-- Companion accepts. So merely starting (and then cancelling) Stripe setup, or
-- having the Companion later DECLINE, permanently consumed the Member's trial
-- with that Companion. It also let an abandoned setup erode the Member-wide
-- "first five trials, fee waived" allowance.
--
-- Correct rule: a trial is consumed only once it exists as a real trial
-- BOOKING in a live or completed state (a booking is created only after the
-- payment authoritatively succeeds, and the Companion's accept/decline is
-- reflected in its status). Declined / cancelled trials free eligibility again,
-- exactly like the long-standing `one_pending_trial_per_pair` index intends.
--
-- Consuming booking statuses: requested (paid, awaiting the Companion),
-- confirmed (accepted), change_proposed (in negotiation), completed,
-- needs_review (the call happened, awaiting confirmation).
-- Freeing statuses: declined, cancelled (and, of course, no booking at all).
--
-- This migration is additive: it only redefines three functions. No schema,
-- data, RLS, or grant changes. It must be applied to the hosted database with
-- `supabase db push` after 0097.

set search_path = '';

-- Whether this Member has a live-or-consumed trial with THIS Companion.
create or replace function app_private.member_companion_trial_consumed(
  p_member uuid, p_companion uuid
)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.bookings b
    where b.member_profile_id = p_member
      and b.companion_profile_id = p_companion
      and b.is_trial
      and b.status in ('requested', 'confirmed', 'change_proposed', 'completed', 'needs_review')
  );
$$;
revoke all on function app_private.member_companion_trial_consumed(uuid, uuid) from public, anon, authenticated;

-- Member-wide count of live-or-consumed trials (for the first-five fee waiver).
-- Now booking-based, so an abandoned Stripe setup never erodes the allowance.
create or replace function app_private.member_trial_count(p_member uuid)
returns integer
language sql stable security definer
set search_path = ''
as $$
  select count(*)::integer from public.bookings b
  where b.member_profile_id = p_member
    and b.is_trial
    and b.status in ('requested', 'confirmed', 'change_proposed', 'completed', 'needs_review');
$$;
revoke all on function app_private.member_trial_count(uuid) from public, anon, authenticated;

-- Re-issue the quote with the booking-based eligibility check. The body is
-- otherwise identical to 0031 (prices, fees, credit application are unchanged).
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
    -- Consumed only by a real trial booking (accepted, in-flight, or done) —
    -- never by a merely pending / declined / cancelled payment attempt.
    if app_private.member_companion_trial_consumed(p_member, p_companion) then
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

select pg_notify('pgrst', 'reload schema');
