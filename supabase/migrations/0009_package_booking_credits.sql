-- ============================================================
-- Stage 2E3B2A — secure package-credit reservation, release and
-- consumption.
--
-- Lifecycle (ledger formula: grants + releases + adjustments −
-- reserves − consumes):
--   book with package   → reserve 1 (atomic with booking creation)
--   decline / cancel    → release 1 (reservation handed back)
--   completed           → release 1 + consume 1 (reservation becomes
--                         a consumed credit — never deducted twice)
--   requested/confirmed/change_proposed/needs_review → stays reserved
--
-- Concurrency: the purchase row is locked FOR UPDATE while the balance
-- is checked and the reserve written, so two simultaneous requests can
-- never spend the same final credit. Unique partial indexes make double
-- reserve/release/consume per booking structurally impossible.
--
-- NO payment is taken anywhere. No UI changes in this stage.
-- ============================================================

-- ---------- bookings: package linkage ----------
alter table public.bookings
  add column package_purchase_id uuid references public.package_purchases(id),
  add column booking_source text not null default 'single_offer'
    check (booking_source in ('single_offer', 'package_credit'));

-- Package bookings reference a purchase and have NO conversation offer
-- (we never create fake offers); single-offer bookings are unchanged.
alter table public.bookings alter column offer_id drop not null;
alter table public.bookings add constraint bookings_source_shape check (
  (booking_source = 'single_offer' and offer_id is not null and package_purchase_id is null)
  or
  (booking_source = 'package_credit' and offer_id is null and package_purchase_id is not null)
);
create index bookings_package_purchase_idx on public.bookings (package_purchase_id)
  where package_purchase_id is not null;

-- The authorised booking view must expose the new columns (views freeze
-- their column list, so b.* has to be re-expanded).
drop view if exists public.my_bookings;
create view public.my_bookings as
select
  b.*,
  pm.first_name as member_first_name,
  left(pm.last_name, 1) as member_last_initial,
  pc.first_name as companion_first_name,
  left(pc.last_name, 1) as companion_last_initial
from public.bookings b
join public.profiles pm on pm.id = b.member_profile_id
join public.profiles pc on pc.id = b.companion_profile_id
where b.booked_by_account_id = auth.uid()
   or app_private.has_profile_access(b.member_profile_id)
   or app_private.has_profile_access(b.companion_profile_id);
grant select on public.my_bookings to authenticated;

-- ---------- ledger: one reserve/release/consume per booking, ever ----------
create unique index one_reserve_per_booking
  on public.package_credit_ledger (booking_id) where (entry_type = 'reserve');
create unique index one_release_per_booking
  on public.package_credit_ledger (booking_id) where (entry_type = 'release');
create unique index one_consume_per_booking
  on public.package_credit_ledger (booking_id) where (entry_type = 'consume');

-- ============================================================
-- Credit settlement — the ONLY way reservations move. Called from the
-- controlled booking functions below; never callable by users.
-- ============================================================
create or replace function app_private.settle_package_credit(
  p_booking uuid,
  p_mode text -- 'release' (decline/cancel) or 'consume' (completed)
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.bookings;
  v_consumed integer;
begin
  select * into v from public.bookings where id = p_booking;
  if v.package_purchase_id is null then
    return; -- ordinary single-offer booking: no package effects, ever
  end if;

  -- Serialise all credit movement for this purchase.
  perform 1 from public.package_purchases where id = v.package_purchase_id for update;

  -- Without a reservation there is nothing to settle.
  if not exists (
    select 1 from public.package_credit_ledger
    where booking_id = p_booking and entry_type = 'reserve'
  ) then
    return;
  end if;
  -- Never settle the same credit twice (indexes enforce this too).
  if exists (
    select 1 from public.package_credit_ledger
    where booking_id = p_booking and entry_type = 'consume'
  ) then
    return; -- already consumed: terminal
  end if;

  if p_mode = 'release' then
    if not exists (
      select 1 from public.package_credit_ledger
      where booking_id = p_booking and entry_type = 'release'
    ) then
      insert into public.package_credit_ledger
        (package_purchase_id, booking_id, entry_type, quantity, reason)
      values
        (v.package_purchase_id, p_booking, 'release', 1, 'Reservation released — booking declined or cancelled');
    end if;
    return;
  end if;

  if p_mode = 'consume' then
    -- release + consume together: the reservation becomes a consumed
    -- credit without reducing the balance twice.
    if not exists (
      select 1 from public.package_credit_ledger
      where booking_id = p_booking and entry_type = 'release'
    ) then
      insert into public.package_credit_ledger
        (package_purchase_id, booking_id, entry_type, quantity, reason)
      values
        (v.package_purchase_id, p_booking, 'release', 1, 'Reservation converted on completion');
    end if;
    insert into public.package_credit_ledger
      (package_purchase_id, booking_id, entry_type, quantity, reason)
    values
      (v.package_purchase_id, p_booking, 'consume', 1, 'Conversation completed');

    -- All credits consumed → the purchase is exhausted (server-decided).
    select coalesce(sum(quantity), 0) into v_consumed
    from public.package_credit_ledger
    where package_purchase_id = v.package_purchase_id and entry_type = 'consume';
    update public.package_purchases pp
       set status = 'exhausted', updated_at = now()
     where pp.id = v.package_purchase_id
       and pp.status = 'active'
       and v_consumed >= pp.conversation_count;
  end if;
end;
$$;
revoke all on function app_private.settle_package_credit(uuid, text) from public, anon, authenticated;

-- ============================================================
-- create_package_booking_request — book WITH a package credit.
-- Member, Companion, duration, price share and buyer all derive from the
-- purchase + auth.uid(); the browser sends purchase, time and method only.
-- ============================================================
create or replace function public.create_package_booking_request(
  p_purchase uuid,
  p_starts_at timestamptz,
  p_method text
)
returns public.bookings
language plpgsql security definer
set search_path = ''
as $$
declare
  v_p public.package_purchases;
  v_methods text[];
  v_tz text;
  v_ends timestamptz;
  v_remaining integer;
  v_price integer;
  v_rate numeric(5, 2);
  v_fee integer;
  v_booking public.bookings;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  -- LOCK the purchase: balance check + reserve become atomic, so two
  -- simultaneous requests cannot both take the final credit.
  select * into v_p from public.package_purchases where id = p_purchase for update;
  if v_p.id is null or not app_private.can_read_purchase(p_purchase) then
    raise exception 'package_mismatch: package not found';
  end if;
  if not app_private.can_act_for_member(v_p.member_profile_id) then
    raise exception 'You cannot book for this member';
  end if;
  if v_p.status <> 'active' then
    raise exception 'package_inactive: this package is % and cannot be used', v_p.status;
  end if;

  -- Supported methods come from the originating package offer.
  select po.supported_methods into v_methods
  from public.package_offers po where po.id = v_p.package_offer_id;
  if v_methods is not null and array_length(v_methods, 1) is not null
     and not (p_method = any (v_methods)) then
    raise exception 'invalid_method: that call method is not offered with this package';
  end if;

  -- At least one credit must remain (grants + releases + adjustments −
  -- reserves − consumes), computed under the purchase lock.
  select coalesce(sum(case
      when entry_type in ('grant', 'release', 'adjustment') then quantity
      else -quantity
    end), 0)
  into v_remaining
  from public.package_credit_ledger
  where package_purchase_id = v_p.id;
  if v_remaining < 1 then
    raise exception 'no_credit: this package has no conversations left';
  end if;

  select cp.timezone into v_tz
  from public.companion_profiles cp where cp.profile_id = v_p.companion_profile_id;
  v_ends := p_starts_at + make_interval(mins => v_p.duration_minutes);

  if not app_private.slot_within_availability(v_p.companion_profile_id, p_starts_at, v_ends) then
    raise exception 'outside_availability: that time is not within the companion''s availability';
  end if;

  -- Display-only price share of the (simulated, unpaid) package.
  v_price := round(v_p.price_minor::numeric / v_p.conversation_count);
  select pc.standard_commission_pct into v_rate from public.platform_config pc limit 1;
  v_rate := coalesce(v_rate, 2);
  v_fee := round(v_price * v_rate / 100);

  begin
    insert into public.bookings (
      member_profile_id, companion_profile_id, booked_by_account_id,
      offer_id, package_purchase_id, booking_source,
      starts_at, ends_at, timezone, communication_method, status,
      duration_minutes, price_minor, currency, platform_fee_rate,
      platform_fee_minor, companion_amount_minor, is_trial
    ) values (
      v_p.member_profile_id, v_p.companion_profile_id, auth.uid(),
      null, v_p.id, 'package_credit',
      p_starts_at, v_ends, coalesce(v_tz, 'Europe/London'), p_method, 'requested',
      v_p.duration_minutes, v_price, v_p.currency, v_rate,
      v_fee, v_price - v_fee, false
    )
    returning * into v_booking;
  exception
    when exclusion_violation then
      raise exception 'slot_taken: that time has just been taken';
  end;

  insert into public.booking_status_history (booking_id, previous_status, new_status, changed_by_account_id)
  values (v_booking.id, null, 'requested', auth.uid());

  -- The reservation, in the SAME transaction as the booking.
  insert into public.package_credit_ledger
    (package_purchase_id, booking_id, entry_type, quantity, created_by_account_id, reason)
  values
    (v_p.id, v_booking.id, 'reserve', 1, auth.uid(), 'Reserved for booking request');

  return v_booking;
end;
$$;
revoke all on function public.create_package_booking_request(uuid, timestamptz, text) from public, anon;
grant execute on function public.create_package_booking_request(uuid, timestamptz, text) to authenticated;

-- ============================================================
-- Extend the existing transitions (full re-definitions; behaviour is
-- identical to 0005/0006 plus credit settlement).
-- ============================================================
create or replace function public.decline_booking(p_booking uuid, p_reason text default null)
returns public.bookings
language plpgsql security definer
set search_path = ''
as $$
declare v public.bookings;
begin
  select * into v from public.bookings where id = p_booking for update;
  if v.id is null or not app_private.can_read_booking(p_booking) then
    raise exception 'Booking not found';
  end if;
  if not app_private.can_edit_profile(v.companion_profile_id) then
    raise exception 'Only the companion can decline this request';
  end if;
  if v.status <> 'requested' then
    raise exception 'invalid_transition: booking is %', v.status;
  end if;
  update public.bookings set status = 'declined', updated_at = now()
   where id = p_booking returning * into v;
  perform app_private.record_transition(p_booking, 'requested', 'declined', p_reason);
  perform app_private.settle_package_credit(p_booking, 'release');
  return v;
end;
$$;

create or replace function public.cancel_booking(p_booking uuid, p_reason text default null)
returns public.bookings
language plpgsql security definer
set search_path = ''
as $$
declare v public.bookings; v_prev text;
begin
  select * into v from public.bookings where id = p_booking for update;
  if v.id is null or not app_private.can_read_booking(p_booking) then
    raise exception 'Booking not found';
  end if;
  if not (v.booked_by_account_id = auth.uid()
          or app_private.can_act_for_member(v.member_profile_id)
          or app_private.can_edit_profile(v.companion_profile_id)) then
    raise exception 'You cannot cancel this booking';
  end if;
  if v.status not in ('requested', 'confirmed', 'change_proposed') then
    raise exception 'invalid_transition: booking is %', v.status;
  end if;
  v_prev := v.status;
  update public.bookings
     set status = 'cancelled', cancellation_reason = p_reason,
         cancelled_by_account_id = auth.uid(), cancelled_at = now(), updated_at = now()
   where id = p_booking returning * into v;
  update public.booking_time_proposals set status = 'expired', responded_at = now()
   where booking_id = p_booking and status = 'pending';
  perform app_private.record_transition(p_booking, v_prev, 'cancelled', p_reason);
  perform app_private.settle_package_credit(p_booking, 'release');
  return v;
end;
$$;

create or replace function public.submit_completion_confirmation(
  p_booking uuid,
  p_outcome text,
  p_note text default null
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.bookings;
  v_side text;
  v_profile uuid;
  v_member_outcome text;
  v_companion_outcome text;
  v_new_status text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if p_outcome not in ('completed', 'did_not_happen', 'report_concern') then
    raise exception 'invalid_outcome: unsupported outcome %', p_outcome;
  end if;

  select * into v from public.bookings where id = p_booking for update;
  if v.id is null or not app_private.can_read_booking(p_booking) then
    raise exception 'Booking not found';
  end if;

  if app_private.can_edit_profile(v.companion_profile_id) then
    v_side := 'companion';
    v_profile := v.companion_profile_id;
  elsif v.booked_by_account_id = auth.uid() or app_private.can_act_for_member(v.member_profile_id) then
    v_side := 'member';
    v_profile := v.member_profile_id;
  else
    raise exception 'You cannot confirm this conversation';
  end if;

  if v.status in ('completed', 'needs_review') then
    raise exception 'already_finalised: this conversation has already been reconciled';
  end if;
  if v.status <> 'confirmed' then
    raise exception 'booking_not_eligible: this conversation is % — only confirmed conversations can be completed', v.status;
  end if;
  if v.ends_at > now() then
    raise exception 'too_early: this conversation has not finished yet';
  end if;

  insert into public.completion_confirmations (
    booking_id, participant_side, submitted_by_account_id, participant_profile_id, outcome, note
  ) values (
    p_booking, v_side, auth.uid(), v_profile, p_outcome, p_note
  )
  on conflict (booking_id, participant_side) do update
    set outcome = excluded.outcome,
        note = excluded.note,
        submitted_by_account_id = excluded.submitted_by_account_id,
        updated_at = now();

  select outcome into v_member_outcome
  from public.completion_confirmations
  where booking_id = p_booking and participant_side = 'member';
  select outcome into v_companion_outcome
  from public.completion_confirmations
  where booking_id = p_booking and participant_side = 'companion';

  if v_member_outcome = 'report_concern' or v_companion_outcome = 'report_concern' then
    v_new_status := 'needs_review';
  elsif v_member_outcome is not null and v_companion_outcome is not null then
    if v_member_outcome = 'completed' and v_companion_outcome = 'completed' then
      v_new_status := 'completed';
    else
      v_new_status := 'needs_review';
    end if;
  end if;

  if v_new_status is not null and v_new_status <> v.status then
    update public.bookings set status = v_new_status, updated_at = now()
      where id = p_booking;
    perform app_private.record_transition(p_booking, v.status, v_new_status, 'Completion reconciliation');
    -- Package credits: completed converts the reservation into a consumed
    -- credit (release + consume). needs_review keeps it RESERVED.
    if v_new_status = 'completed' then
      perform app_private.settle_package_credit(p_booking, 'consume');
    end if;
  end if;

  return public.get_completion_state(p_booking);
end;
$$;

-- ============================================================
-- Credit state for one booking (authorised readers only).
-- ============================================================
create or replace function public.get_booking_credit_state(p_booking uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare v public.bookings;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.bookings where id = p_booking;
  if v.id is null or not app_private.can_read_booking(p_booking) then
    raise exception 'Booking not found';
  end if;
  return jsonb_build_object(
    'booking_id', v.id,
    'booking_source', v.booking_source,
    'package_purchase_id', v.package_purchase_id,
    'reserved', exists (select 1 from public.package_credit_ledger
                        where booking_id = p_booking and entry_type = 'reserve'),
    'released', exists (select 1 from public.package_credit_ledger
                        where booking_id = p_booking and entry_type = 'release'),
    'consumed', exists (select 1 from public.package_credit_ledger
                        where booking_id = p_booking and entry_type = 'consume')
  );
end;
$$;
revoke all on function public.get_booking_credit_state(uuid) from public, anon;
grant execute on function public.get_booking_credit_state(uuid) to authenticated;
