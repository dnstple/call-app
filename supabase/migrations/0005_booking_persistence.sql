-- ============================================================
-- Stage 2D — real booking persistence, exact slot generation,
-- atomic conflict prevention and server-controlled transitions.
--
-- NO payment is taken, no credits, no meeting links. Prices and
-- fees are SNAPSHOTS (estimates until payments exist).
--
-- The Stage-1 bookings/completion tables were never usable in
-- Supabase mode (no policies, no data): they are rebuilt here to
-- the product model. completion_confirmations returns in the
-- completion milestone.
-- ============================================================

-- GiST exclusion constraints on (uuid =, tstzrange &&) need btree_gist.
create extension if not exists btree_gist;

-- ---------- drop the unused Stage-1 booking objects ----------
alter table public.ratings drop constraint if exists ratings_booking_id_fkey;
alter table public.notifications drop constraint if exists notifications_related_booking_id_fkey;
alter table public.reports drop constraint if exists reports_booking_id_fkey;
alter table public.transactions drop constraint if exists transactions_booking_id_fkey;
drop table if exists public.completion_confirmations;
drop table if exists public.bookings cascade;

-- ---------- bookings ----------
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  member_profile_id uuid not null references public.profiles(id),
  companion_profile_id uuid not null references public.profiles(id),
  booked_by_account_id uuid not null references public.accounts(id),
  offer_id uuid not null references public.conversation_offers(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'Europe/London',
  communication_method text not null,
  status text not null default 'requested'
    check (status in ('requested', 'confirmed', 'declined', 'change_proposed', 'cancelled')),
  duration_minutes integer not null check (duration_minutes in (15, 30, 45, 60)),
  -- Server-side snapshots (offers can change later; estimates until payments):
  price_minor integer not null check (price_minor >= 0),
  currency text not null default 'GBP' check (currency = 'GBP'),
  platform_fee_rate numeric(5, 2) not null check (platform_fee_rate >= 0),
  platform_fee_minor integer not null check (platform_fee_minor >= 0),
  companion_amount_minor integer not null check (companion_amount_minor >= 0),
  is_trial boolean not null default false,
  cancellation_reason text,
  cancelled_by_account_id uuid references public.accounts(id),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (starts_at < ends_at),
  check (ends_at = starts_at + make_interval(mins => duration_minutes))
);

-- Atomic conflict prevention: active statuses keep the slot reserved for
-- BOTH parties — even simultaneous requests cannot both succeed.
-- Participating statuses: requested, confirmed, change_proposed
-- (a change_proposed booking still reserves its current time).
alter table public.bookings add constraint bookings_companion_no_overlap
  exclude using gist (
    companion_profile_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status in ('requested', 'confirmed', 'change_proposed'));

alter table public.bookings add constraint bookings_member_no_overlap
  exclude using gist (
    member_profile_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status in ('requested', 'confirmed', 'change_proposed'));

-- Trial rule (Stage 2D, conservative): one NON-TERMINAL trial booking per
-- Member–Companion pair. Declined/cancelled do not consume it; permanent
-- consumption is finalised in the completion milestone.
create unique index one_pending_trial_per_pair
  on public.bookings (member_profile_id, companion_profile_id)
  where (is_trial and status in ('requested', 'confirmed', 'change_proposed'));

create index bookings_member_time_idx on public.bookings (member_profile_id, starts_at);
create index bookings_companion_time_idx on public.bookings (companion_profile_id, starts_at);
create index bookings_booked_by_idx on public.bookings (booked_by_account_id);

-- Re-point the old columns at the new table.
alter table public.ratings
  add constraint ratings_booking_id_fkey foreign key (booking_id)
  references public.bookings(id) on delete set null;
alter table public.notifications
  add constraint notifications_related_booking_id_fkey foreign key (related_booking_id)
  references public.bookings(id) on delete set null;
alter table public.reports
  add constraint reports_booking_id_fkey foreign key (booking_id)
  references public.bookings(id) on delete set null;
alter table public.transactions
  add constraint transactions_booking_id_fkey foreign key (booking_id)
  references public.bookings(id) on delete set null;

-- ---------- status history (audit) ----------
create table public.booking_status_history (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  previous_status text,
  new_status text not null,
  changed_by_account_id uuid not null references public.accounts(id),
  reason text,
  created_at timestamptz not null default now()
);
create index booking_history_booking_idx on public.booking_status_history (booking_id, created_at);

-- ---------- alternative-time proposals ----------
create table public.booking_time_proposals (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  proposed_by_account_id uuid not null references public.accounts(id),
  proposed_starts_at timestamptz not null,
  proposed_ends_at timestamptz not null,
  timezone text not null default 'Europe/London',
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected', 'expired')),
  -- The booking status to restore if this proposal is rejected.
  previous_booking_status text not null,
  message text,
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (proposed_starts_at < proposed_ends_at)
);
-- Only one live proposal per booking.
create unique index one_pending_proposal_per_booking
  on public.booking_time_proposals (booking_id) where (status = 'pending');

-- ============================================================
-- Authorisation helpers
-- ============================================================
create or replace function app_private.can_act_for_member(p_member uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profile_access pa
    where pa.profile_id = p_member
      and pa.account_id = auth.uid()
      and pa.can_book
      and pa.consent_status <> 'withdrawn'
  );
$$;

create or replace function app_private.can_read_booking(p_booking uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.bookings b
    where b.id = p_booking
      and (
        b.booked_by_account_id = auth.uid()
        or app_private.has_profile_access(b.member_profile_id)
        or app_private.has_profile_access(b.companion_profile_id)
      )
  );
$$;

revoke all on function app_private.can_act_for_member(uuid) from public, anon;
revoke all on function app_private.can_read_booking(uuid) from public, anon;
grant execute on function app_private.can_act_for_member(uuid) to authenticated;
grant execute on function app_private.can_read_booking(uuid) to authenticated;

-- ============================================================
-- RLS — reads only; every write goes through the functions below
-- (no direct insert/update/delete policies exist at all).
-- ============================================================
alter table public.bookings enable row level security;
alter table public.booking_status_history enable row level security;
alter table public.booking_time_proposals enable row level security;

create policy "bookings: participants read" on public.bookings
  for select to authenticated using (
    booked_by_account_id = auth.uid()
    or app_private.has_profile_access(member_profile_id)
    or app_private.has_profile_access(companion_profile_id)
  );

create policy "booking history: participants read" on public.booking_status_history
  for select to authenticated using (app_private.can_read_booking(booking_id));

create policy "booking proposals: participants read" on public.booking_time_proposals
  for select to authenticated using (app_private.can_read_booking(booking_id));

-- Authorised booking list WITH participant display names (participants may
-- not have profile-table access to each other; this definer-style view
-- embeds the same authorisation check and exposes only safe name fields).
create or replace view public.my_bookings as
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

-- ============================================================
-- Availability check for one concrete slot.
-- Recurring windows are Companion-local; DST handled by Postgres tz rules.
-- ============================================================
create or replace function app_private.slot_within_availability(
  p_companion uuid,
  p_starts timestamptz,
  p_ends timestamptz
)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_notice integer;
  v_horizon integer;
  v_local_start timestamp;
  v_local_end timestamp;
  v_ok boolean := false;
begin
  select cp.timezone, cp.minimum_notice_hours, cp.booking_horizon_days
    into v_tz, v_notice, v_horizon
  from public.companion_profiles cp where cp.profile_id = p_companion;
  if v_tz is null then return false; end if;

  -- Minimum notice and booking horizon.
  if p_starts < now() + make_interval(hours => coalesce(v_notice, 24)) then return false; end if;
  if p_starts > now() + make_interval(days => coalesce(v_horizon, 60)) then return false; end if;

  v_local_start := p_starts at time zone v_tz;
  v_local_end := p_ends at time zone v_tz;

  -- Within a recurring window (same local day, ISO dow, inside the window)…
  select exists (
    select 1 from public.availability_rules ar
    where ar.companion_profile_id = p_companion
      and ar.active
      and ar.day_of_week = extract(isodow from v_local_start)::int
      and v_local_start::date = v_local_end::date
      and v_local_start::time >= ar.start_local_time
      and v_local_end::time <= ar.end_local_time
  ) into v_ok;

  -- …or fully inside an additionally-available exception.
  if not v_ok then
    select exists (
      select 1 from public.availability_exceptions ae
      where ae.companion_profile_id = p_companion
        and ae.exception_type = 'additionally_available'
        and ae.starts_at <= p_starts and ae.ends_at >= p_ends
    ) into v_ok;
  end if;
  if not v_ok then return false; end if;

  -- Unavailable exceptions veto any overlap.
  if exists (
    select 1 from public.availability_exceptions ae
    where ae.companion_profile_id = p_companion
      and ae.exception_type = 'unavailable'
      and ae.starts_at < p_ends and ae.ends_at > p_starts
  ) then return false; end if;

  return true;
end;
$$;
revoke all on function app_private.slot_within_availability(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function app_private.slot_within_availability(uuid, timestamptz, timestamptz) to authenticated;

-- ============================================================
-- Exact slot generation. 15-minute grid (documented), range clamped to
-- 31 days, at most 200 slots. Removes conflicts with the Companion's
-- active bookings; the Member's own conflicts are enforced at creation.
-- ============================================================
create or replace function public.get_available_slots(
  p_companion uuid,
  p_offer uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (slot_start timestamptz, slot_end timestamptz)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_duration integer;
  v_tz text;
  v_from timestamptz;
  v_to timestamptz;
  v_day date;
  v_last_day date;
  r record;
  v_t time;
  v_start timestamptz;
  v_end timestamptz;
  v_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not (app_private.is_discoverable_companion(p_companion)
          or app_private.has_profile_access(p_companion)) then
    raise exception 'Companion not available';
  end if;

  select o.duration_minutes into v_duration
  from public.conversation_offers o
  where o.id = p_offer and o.companion_profile_id = p_companion and o.active;
  if v_duration is null then
    raise exception 'Offer not available';
  end if;

  select cp.timezone into v_tz from public.companion_profiles cp where cp.profile_id = p_companion;
  v_tz := coalesce(v_tz, 'Europe/London');

  v_from := greatest(p_from, now());
  v_to := least(p_to, v_from + interval '31 days');

  v_day := (v_from at time zone v_tz)::date;
  v_last_day := (v_to at time zone v_tz)::date;

  while v_day <= v_last_day and v_count < 200 loop
    -- Recurring windows for this local day.
    for r in
      select ar.start_local_time as s, ar.end_local_time as e
      from public.availability_rules ar
      where ar.companion_profile_id = p_companion
        and ar.active
        and ar.day_of_week = extract(isodow from v_day)::int
      union all
      -- Additionally-available exceptions intersecting this local day.
      select greatest((ae.starts_at at time zone v_tz), v_day::timestamp)::time,
             least((ae.ends_at at time zone v_tz), (v_day + 1)::timestamp)::time
      from public.availability_exceptions ae
      where ae.companion_profile_id = p_companion
        and ae.exception_type = 'additionally_available'
        and (ae.starts_at at time zone v_tz)::date <= v_day
        and (ae.ends_at at time zone v_tz)::date >= v_day
    loop
      v_t := r.s;
      while v_t + make_interval(mins => v_duration) <= r.e and v_count < 200 loop
        -- Local wall time → instant, using the Companion's zone (DST-aware).
        v_start := (v_day + v_t) at time zone v_tz;
        v_end := v_start + make_interval(mins => v_duration);
        if v_start >= v_from and v_end <= v_to
           and app_private.slot_within_availability(p_companion, v_start, v_end)
           and not exists (
             select 1 from public.bookings b
             where b.companion_profile_id = p_companion
               and b.status in ('requested', 'confirmed', 'change_proposed')
               and b.starts_at < v_end and b.ends_at > v_start
           )
        then
          slot_start := v_start;
          slot_end := v_end;
          v_count := v_count + 1;
          return next;
        end if;
        v_t := v_t + interval '15 minutes';
      end loop;
    end loop;
    v_day := v_day + 1;
  end loop;
  return;
end;
$$;
revoke all on function public.get_available_slots(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_available_slots(uuid, uuid, timestamptz, timestamptz) to authenticated;

-- ============================================================
-- Create booking request — the ONLY way a booking comes to exist.
-- Price, fee and participants are derived server-side; the browser
-- can never supply them.
-- ============================================================
create or replace function public.create_booking_request(
  p_member uuid,
  p_offer uuid,
  p_starts_at timestamptz,
  p_method text
)
returns public.bookings
language plpgsql security definer
set search_path = ''
as $$
declare
  v_offer public.conversation_offers;
  v_companion uuid;
  v_accepting boolean;
  v_tz text;
  v_ends timestamptz;
  v_rate numeric(5, 2);
  v_fee integer;
  v_booking public.bookings;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not app_private.can_act_for_member(p_member) then
    raise exception 'You cannot book for this member';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_member and p.role = 'member') then
    raise exception 'Bookings are for member profiles';
  end if;

  select o.* into v_offer from public.conversation_offers o where o.id = p_offer and o.active;
  if v_offer.id is null then raise exception 'Offer not available'; end if;
  v_companion := v_offer.companion_profile_id;

  select cp.is_accepting_new_members, cp.timezone into v_accepting, v_tz
  from public.companion_profiles cp where cp.profile_id = v_companion;
  if coalesce(v_accepting, false) is not true then
    raise exception 'This companion is not accepting new members right now';
  end if;

  if array_length(v_offer.supported_methods, 1) is not null
     and not (p_method = any (v_offer.supported_methods)) then
    raise exception 'That call method is not offered';
  end if;

  v_ends := p_starts_at + make_interval(mins => v_offer.duration_minutes);

  if not app_private.slot_within_availability(v_companion, p_starts_at, v_ends) then
    raise exception 'outside_availability: that time is not within the companion''s availability';
  end if;

  -- Fee snapshot from platform configuration (estimates until payments).
  select case when v_offer.offer_type = 'trial'
              then pc.trial_commission_pct else pc.standard_commission_pct end
    into v_rate
  from public.platform_config pc limit 1;
  v_rate := coalesce(v_rate, 2);
  v_fee := round(v_offer.price_minor * v_rate / 100);

  begin
    insert into public.bookings (
      member_profile_id, companion_profile_id, booked_by_account_id, offer_id,
      starts_at, ends_at, timezone, communication_method, status,
      duration_minutes, price_minor, currency, platform_fee_rate,
      platform_fee_minor, companion_amount_minor, is_trial
    ) values (
      p_member, v_companion, auth.uid(), v_offer.id,
      p_starts_at, v_ends, coalesce(v_tz, 'Europe/London'), p_method, 'requested',
      v_offer.duration_minutes, v_offer.price_minor, v_offer.currency, v_rate,
      v_fee, v_offer.price_minor - v_fee, v_offer.offer_type = 'trial'
    )
    returning * into v_booking;
  exception
    when exclusion_violation then
      raise exception 'slot_taken: that time has just been taken';
    when unique_violation then
      raise exception 'trial_pending: a trial with this companion is already requested';
  end;

  insert into public.booking_status_history (booking_id, previous_status, new_status, changed_by_account_id)
  values (v_booking.id, null, 'requested', auth.uid());

  return v_booking;
end;
$$;

-- ============================================================
-- Transitions — server-controlled; every change writes history.
-- requested        → confirmed | declined | change_proposed | cancelled
-- change_proposed  → confirmed (proposal accepted)
--                  → previous status (proposal rejected)
--                  → cancelled
-- confirmed        → change_proposed | cancelled
-- declined / cancelled → terminal
-- ============================================================
create or replace function app_private.record_transition(
  p_booking uuid, p_prev text, p_new text, p_reason text default null
)
returns void
language sql security definer
set search_path = ''
as $$
  insert into public.booking_status_history (booking_id, previous_status, new_status, changed_by_account_id, reason)
  values (p_booking, p_prev, p_new, auth.uid(), p_reason);
$$;
revoke all on function app_private.record_transition(uuid, text, text, text) from public, anon, authenticated;

create or replace function public.accept_booking(p_booking uuid)
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
    raise exception 'Only the companion can accept this request';
  end if;
  if v.status <> 'requested' then
    raise exception 'invalid_transition: booking is %', v.status;
  end if;
  update public.bookings set status = 'confirmed', updated_at = now()
   where id = p_booking returning * into v;
  perform app_private.record_transition(p_booking, 'requested', 'confirmed');
  return v;
end;
$$;

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
  return v;
end;
$$;

create or replace function public.propose_booking_time(
  p_booking uuid,
  p_starts_at timestamptz,
  p_message text default null
)
returns public.booking_time_proposals
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.bookings;
  v_prop public.booking_time_proposals;
  v_is_companion boolean;
  v_is_requester boolean;
begin
  select * into v from public.bookings where id = p_booking for update;
  if v.id is null or not app_private.can_read_booking(p_booking) then
    raise exception 'Booking not found';
  end if;
  v_is_companion := app_private.can_edit_profile(v.companion_profile_id);
  v_is_requester := v.booked_by_account_id = auth.uid()
                    or app_private.can_act_for_member(v.member_profile_id);
  -- Requested bookings: only the companion proposes. Confirmed bookings:
  -- either authorised side may propose a reschedule (documented).
  if v.status = 'requested' and not v_is_companion then
    raise exception 'Only the companion can propose a new time for a request';
  elsif v.status = 'confirmed' and not (v_is_companion or v_is_requester) then
    raise exception 'You cannot reschedule this booking';
  elsif v.status not in ('requested', 'confirmed') then
    raise exception 'invalid_transition: booking is %', v.status;
  end if;

  insert into public.booking_time_proposals (
    booking_id, proposed_by_account_id, proposed_starts_at, proposed_ends_at,
    timezone, previous_booking_status, message
  ) values (
    p_booking, auth.uid(), p_starts_at,
    p_starts_at + make_interval(mins => v.duration_minutes),
    v.timezone, v.status, p_message
  ) returning * into v_prop;

  update public.bookings set status = 'change_proposed', updated_at = now() where id = p_booking;
  perform app_private.record_transition(p_booking, v.status, 'change_proposed', p_message);
  return v_prop;
end;
$$;

create or replace function public.accept_booking_time_proposal(p_proposal uuid)
returns public.bookings
language plpgsql security definer
set search_path = ''
as $$
declare
  v_prop public.booking_time_proposals;
  v public.bookings;
  v_responder_is_companion boolean;
  v_proposer_was_companion boolean;
begin
  select * into v_prop from public.booking_time_proposals where id = p_proposal for update;
  if v_prop.id is null or not app_private.can_read_booking(v_prop.booking_id) then
    raise exception 'Proposal not found';
  end if;
  if v_prop.status <> 'pending' then
    raise exception 'invalid_transition: proposal is %', v_prop.status;
  end if;
  select * into v from public.bookings where id = v_prop.booking_id for update;

  v_responder_is_companion := app_private.can_edit_profile(v.companion_profile_id);
  v_proposer_was_companion := exists (
    select 1 from public.profile_access pa
    where pa.account_id = v_prop.proposed_by_account_id
      and pa.profile_id = v.companion_profile_id and pa.can_edit
  );
  -- The side that did NOT propose must respond.
  if v_proposer_was_companion then
    if not (v.booked_by_account_id = auth.uid() or app_private.can_act_for_member(v.member_profile_id)) then
      raise exception 'Only the requester can accept this proposal';
    end if;
  else
    if not v_responder_is_companion then
      raise exception 'Only the companion can accept this proposal';
    end if;
  end if;

  -- Revalidate everything against the CURRENT state of the diary.
  if not app_private.slot_within_availability(v.companion_profile_id, v_prop.proposed_starts_at, v_prop.proposed_ends_at) then
    raise exception 'outside_availability: that time is no longer within availability';
  end if;

  begin
    update public.bookings
       set starts_at = v_prop.proposed_starts_at,
           ends_at = v_prop.proposed_ends_at,
           status = 'confirmed',
           updated_at = now()
     where id = v.id;
  exception when exclusion_violation then
    raise exception 'slot_taken: that time has just been taken';
  end;

  update public.booking_time_proposals set status = 'accepted', responded_at = now() where id = p_proposal;
  perform app_private.record_transition(v.id, 'change_proposed', 'confirmed', 'Proposed time accepted');
  select * into v from public.bookings where id = v.id;
  return v;
end;
$$;

create or replace function public.reject_booking_time_proposal(p_proposal uuid)
returns public.bookings
language plpgsql security definer
set search_path = ''
as $$
declare
  v_prop public.booking_time_proposals;
  v public.bookings;
begin
  select * into v_prop from public.booking_time_proposals where id = p_proposal for update;
  if v_prop.id is null or not app_private.can_read_booking(v_prop.booking_id) then
    raise exception 'Proposal not found';
  end if;
  if v_prop.status <> 'pending' then
    raise exception 'invalid_transition: proposal is %', v_prop.status;
  end if;
  select * into v from public.bookings where id = v_prop.booking_id for update;
  if v_prop.proposed_by_account_id = auth.uid() then
    raise exception 'You cannot respond to your own proposal';
  end if;
  if not (v.booked_by_account_id = auth.uid()
          or app_private.can_act_for_member(v.member_profile_id)
          or app_private.can_edit_profile(v.companion_profile_id)) then
    raise exception 'Booking not found';
  end if;

  update public.booking_time_proposals set status = 'rejected', responded_at = now() where id = p_proposal;
  -- Documented: rejection restores the status the booking had before the
  -- proposal (requested stays requested; confirmed stays confirmed).
  update public.bookings set status = v_prop.previous_booking_status, updated_at = now() where id = v.id;
  perform app_private.record_transition(v.id, 'change_proposed', v_prop.previous_booking_status, 'Proposed time rejected');
  select * into v from public.bookings where id = v.id;
  return v;
end;
$$;

-- Lock down all booking functions.
revoke all on function public.create_booking_request(uuid, uuid, timestamptz, text) from public, anon;
revoke all on function public.accept_booking(uuid) from public, anon;
revoke all on function public.decline_booking(uuid, text) from public, anon;
revoke all on function public.cancel_booking(uuid, text) from public, anon;
revoke all on function public.propose_booking_time(uuid, timestamptz, text) from public, anon;
revoke all on function public.accept_booking_time_proposal(uuid) from public, anon;
revoke all on function public.reject_booking_time_proposal(uuid) from public, anon;
grant execute on function public.create_booking_request(uuid, uuid, timestamptz, text) to authenticated;
grant execute on function public.accept_booking(uuid) to authenticated;
grant execute on function public.decline_booking(uuid, text) to authenticated;
grant execute on function public.cancel_booking(uuid, text) to authenticated;
grant execute on function public.propose_booking_time(uuid, timestamptz, text) to authenticated;
grant execute on function public.accept_booking_time_proposal(uuid) to authenticated;
grant execute on function public.reject_booking_time_proposal(uuid) to authenticated;
