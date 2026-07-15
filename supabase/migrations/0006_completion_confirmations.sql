-- ============================================================
-- Stage 2E1A — real completion confirmations and reconciliation.
--
-- After a confirmed conversation's scheduled end, each SIDE (member /
-- companion) records an outcome. Matching "completed" outcomes finalise
-- the booking as completed; a concern or any disagreement moves it to
-- needs_review for later operational handling.
--
-- NO payment, payout, package credit or rating is processed here.
-- Administrator resolution of needs_review is a later milestone.
--
-- "Awaiting completion" is a DERIVED display state (status = confirmed
-- AND ends_at in the past) — no background job flips statuses.
-- ============================================================

-- ---------- extend the booking status model ----------
-- completed / needs_review are terminal for normal users. They do not
-- participate in the slot-exclusion constraints (the time has passed).
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%in%'
  loop
    execute format('alter table public.bookings drop constraint %I', c);
  end loop;
end $$;

alter table public.bookings add constraint bookings_status_check
  check (status in (
    'requested', 'confirmed', 'declined', 'change_proposed', 'cancelled',
    'completed', 'needs_review'
  ));

-- ---------- completion confirmations ----------
create table public.completion_confirmations (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  participant_side text not null check (participant_side in ('member', 'companion')),
  submitted_by_account_id uuid not null references public.accounts(id),
  participant_profile_id uuid not null references public.profiles(id),
  outcome text not null check (outcome in ('completed', 'did_not_happen', 'report_concern')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One active confirmation per booking per side (updatable until reconciled).
  unique (booking_id, participant_side)
);
create index completion_confirmations_booking_idx on public.completion_confirmations (booking_id);

-- participant_profile_id is guaranteed to match the booking's member or
-- companion because the ONLY write path is submit_completion_confirmation,
-- which derives it server-side. Belt-and-braces trigger to keep it true
-- even for future privileged code paths:
create or replace function app_private.check_confirmation_participant()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare v public.bookings;
begin
  select * into v from public.bookings where id = new.booking_id;
  if new.participant_side = 'member' and new.participant_profile_id <> v.member_profile_id then
    raise exception 'participant_profile_id does not match the booking member';
  end if;
  if new.participant_side = 'companion' and new.participant_profile_id <> v.companion_profile_id then
    raise exception 'participant_profile_id does not match the booking companion';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger completion_confirmations_participant
  before insert or update on public.completion_confirmations
  for each row execute function app_private.check_confirmation_participant();

-- ---------- RLS: participant reads only; NO direct write path ----------
alter table public.completion_confirmations enable row level security;

create policy "completion confirmations: participants read"
  on public.completion_confirmations
  for select to authenticated
  using (app_private.can_read_booking(booking_id));
-- No insert/update/delete policies exist: every write goes through
-- submit_completion_confirmation. Concern notes are therefore visible
-- only to authorised booking participants.

-- ============================================================
-- get_completion_state — the completion payload for one booking.
-- ============================================================
create or replace function public.get_completion_state(p_booking uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v public.bookings;
  v_side text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  select * into v from public.bookings where id = p_booking;
  if v.id is null or not app_private.can_read_booking(p_booking) then
    raise exception 'Booking not found';
  end if;

  -- Which side does the caller represent? (Companion access wins if an
  -- account somehow represents both; documented, deterministic.)
  if app_private.can_edit_profile(v.companion_profile_id) then
    v_side := 'companion';
  elsif v.booked_by_account_id = auth.uid() or app_private.can_act_for_member(v.member_profile_id) then
    v_side := 'member';
  end if;

  return jsonb_build_object(
    'booking_id', v.id,
    'status', v.status,
    'ends_at', v.ends_at,
    'your_side', v_side,
    'member', (
      select jsonb_build_object('outcome', c.outcome, 'note', c.note, 'submitted_at', c.updated_at)
      from public.completion_confirmations c
      where c.booking_id = v.id and c.participant_side = 'member'
    ),
    'companion', (
      select jsonb_build_object('outcome', c.outcome, 'note', c.note, 'submitted_at', c.updated_at)
      from public.completion_confirmations c
      where c.booking_id = v.id and c.participant_side = 'companion'
    )
  );
end;
$$;

-- ============================================================
-- submit_completion_confirmation — the ONLY way outcomes are recorded.
-- Side, participant profile and actor are all derived from auth.uid();
-- the browser cannot choose a side or set completed/needs_review.
-- ============================================================
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

  -- Server-side side derivation.
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

  -- Insert or update THIS side's confirmation (updatable until reconciled).
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

  -- Reconcile atomically (booking row is locked).
  select outcome into v_member_outcome
  from public.completion_confirmations
  where booking_id = p_booking and participant_side = 'member';
  select outcome into v_companion_outcome
  from public.completion_confirmations
  where booking_id = p_booking and participant_side = 'companion';

  if v_member_outcome = 'report_concern' or v_companion_outcome = 'report_concern' then
    -- A concern needs review immediately, even one-sided.
    v_new_status := 'needs_review';
  elsif v_member_outcome is not null and v_companion_outcome is not null then
    if v_member_outcome = 'completed' and v_companion_outcome = 'completed' then
      v_new_status := 'completed';
    else
      -- completed + did_not_happen, or did_not_happen + did_not_happen:
      -- operational review decides what really happened.
      v_new_status := 'needs_review';
    end if;
  end if;
  -- One-sided completed/did_not_happen: booking stays confirmed
  -- (displayed as awaiting the other side).

  if v_new_status is not null and v_new_status <> v.status then
    update public.bookings set status = v_new_status, updated_at = now()
      where id = p_booking;
    perform app_private.record_transition(p_booking, v.status, v_new_status, 'Completion reconciliation');
  end if;

  return public.get_completion_state(p_booking);
end;
$$;

-- ---------- lock the functions down ----------
revoke all on function public.get_completion_state(uuid) from public, anon;
revoke all on function public.submit_completion_confirmation(uuid, text, text) from public, anon;
revoke all on function app_private.check_confirmation_participant() from public, anon, authenticated;
grant execute on function public.get_completion_state(uuid) to authenticated;
grant execute on function public.submit_completion_confirmation(uuid, text, text) to authenticated;
