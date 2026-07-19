-- ============================================================
-- 2G4A — completion, reviews, issues, earnings (migration 0034).
-- Controlling design: docs/2g4-completion-architecture.md.
--
-- Eligibility for EVERYTHING here: a succeeded provider='stripe_test'
-- payment order with a funded booking. Simulation/mock/unfunded records
-- can never create an earning. All money = snapshots from the payment
-- order; integer GBP minor units; append-only; no Stripe transfers.
-- Release rule: companion took_place + (customer approval OR end+12h,
-- no open issue). held_for_issue is NEVER auto-released. Rating edits
-- (24h window) never reopen a payable earning.
-- ============================================================

-- ---------- support/admin role (service-role managed only) ----------
create table if not exists public.support_admins (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by text not null default 'service_role'
);
alter table public.support_admins enable row level security;
drop policy if exists "support_admins: self check" on public.support_admins;
create policy "support_admins: self check" on public.support_admins
  for select to authenticated using (account_id = auth.uid());

create or replace function app_private.is_support_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.support_admins where account_id = auth.uid());
$$;
revoke all on function app_private.is_support_admin() from public, anon;
grant execute on function app_private.is_support_admin() to authenticated;

-- ---------- companion earnings (immutable, one per booking) ----------
create table if not exists public.companion_earnings (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id),
  payment_order_id uuid not null references public.payment_orders(id),
  companion_account_id uuid not null references public.accounts(id),
  companion_profile_id uuid not null references public.profiles(id),
  member_profile_id uuid not null references public.profiles(id),
  payer_account_id uuid not null references public.accounts(id),
  currency text not null default 'GBP' check (currency = 'GBP'),
  basis_minor integer not null check (basis_minor >= 0),
  commission_rate_pct numeric(5,2) not null,
  commission_minor integer not null check (commission_minor >= 0),
  net_minor integer not null check (net_minor >= 0),
  provider text not null default 'stripe_test' check (provider = 'stripe_test'),
  state text not null default 'pending_completion' check (state in
    ('pending_completion', 'held_for_issue', 'payable', 'reversed')),
  transfer_state text not null default 'not_ready' check (transfer_state in
    ('not_ready', 'transfer_pending', 'transferred', 'reversed')),
  payable_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.companion_earnings enable row level security;
drop policy if exists "earnings: companion reads own" on public.companion_earnings;
create policy "earnings: companion reads own" on public.companion_earnings
  for select to authenticated using (companion_account_id = auth.uid());
drop policy if exists "earnings: payer reads safe state" on public.companion_earnings;
create policy "earnings: payer reads safe state" on public.companion_earnings
  for select to authenticated using (payer_account_id = auth.uid());

-- ---------- attendance (companion-submitted OR system-derived) ----------
create table if not exists public.conversation_attendance (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id),
  outcome text not null check (outcome in
    ('took_place', 'member_no_show', 'technical_problem', 'other')),
  source text not null default 'companion' check (source in ('companion', 'system')),
  submitted_by uuid references public.accounts(id),
  explanation text,
  finalised boolean not null default true,
  created_at timestamptz not null default now(),
  check (outcome = 'took_place' or source = 'system' or explanation is not null)
);
alter table public.conversation_attendance enable row level security;
drop policy if exists "attendance: participants read" on public.conversation_attendance;
create policy "attendance: participants read" on public.conversation_attendance
  for select to authenticated using (
    exists (select 1 from public.companion_earnings e
            where e.booking_id = conversation_attendance.booking_id
              and (e.companion_account_id = auth.uid() or e.payer_account_id = auth.uid()))
  );

-- ---------- trusted attendance segments (2G4B fills these) ----------
create table if not exists public.call_attendance_segments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id),
  side text not null check (side in ('companion', 'member')),
  participant_identity text not null,
  joined_at timestamptz not null,
  left_at timestamptz,
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  external_event_id text not null unique,
  source text not null default 'livekit',
  created_at timestamptz not null default now()
);
create index if not exists attendance_segments_booking_idx
  on public.call_attendance_segments (booking_id, side);
alter table public.call_attendance_segments enable row level security;
-- No client policies AT ALL: service-role writes (livekit-webhook in
-- 2G4B), support reads via RPC. Browsers can neither read nor forge.

-- ---------- reviews (one per funded occurrence) ----------
create table if not exists public.conversation_reviews (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id),
  coordinator_account_id uuid not null references public.accounts(id),
  member_profile_id uuid not null references public.profiles(id),
  companion_profile_id uuid not null references public.profiles(id),
  rating smallint check (rating between 1 and 5),
  private_feedback text check (char_length(private_feedback) <= 2000),
  approved boolean not null default true,
  message_idempotency text,
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
alter table public.conversation_reviews enable row level security;
drop policy if exists "reviews: author reads own" on public.conversation_reviews;
create policy "reviews: author reads own" on public.conversation_reviews
  for select to authenticated using (coordinator_account_id = auth.uid());
-- Companions/public NEVER read this table (private feedback lives here);
-- the public star average continues to flow through the existing ratings
-- aggregation once 2G4C wires submission into it.

-- ---------- issues + immutable resolutions ----------
create table if not exists public.conversation_issues (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id),
  earning_id uuid references public.companion_earnings(id),
  reporter_account_id uuid not null references public.accounts(id),
  reporter_role text not null check (reporter_role in ('coordinator', 'companion', 'system')),
  category text not null check (category in
    ('companion_no_show', 'member_no_show', 'audio_video_problem',
     'platform_technical_problem', 'ended_early', 'incorrect_duration',
     'inappropriate_or_concerning_behaviour', 'technical_problem',
     'unclear_attendance', 'other')),
  description text not null check (char_length(description) between 1 and 4000),
  priority text not null default 'normal' check (priority in ('normal', 'high')),
  state text not null default 'open' check (state in ('open', 'reviewing', 'resolved')),
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
-- One ACTIVE financial issue per booking.
create unique index if not exists conversation_issues_one_active
  on public.conversation_issues (booking_id) where state <> 'resolved';
alter table public.conversation_issues enable row level security;
drop policy if exists "issues: reporter reads own" on public.conversation_issues;
create policy "issues: reporter reads own" on public.conversation_issues
  for select to authenticated using (reporter_account_id = auth.uid());
-- The opposing party learns of an issue only through neutral
-- notifications — never the complaint text (no cross-party policy).

create table if not exists public.issue_resolutions (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null unique references public.conversation_issues(id),
  earning_id uuid not null references public.companion_earnings(id),
  resolver_account_id uuid not null references public.accounts(id),
  outcome text not null check (outcome in
    ('companion_payable_full', 'customer_credit_full', 'partial_resolution', 'issue_dismissed_release')),
  note text not null check (char_length(note) between 1 and 4000),
  companion_amount_minor integer not null default 0 check (companion_amount_minor >= 0),
  credit_amount_minor integer not null default 0 check (credit_amount_minor >= 0),
  currency text not null default 'GBP' check (currency = 'GBP'),
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);
alter table public.issue_resolutions enable row level security;
-- Support-only surface; no general client policies.

-- ---------- earning creation (internal; snapshot-only) ----------
create or replace function app_private.ensure_companion_earning(p_booking uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.payment_orders;
  v_companion_account uuid;
  v_id uuid;
begin
  select id into v_id from public.companion_earnings where booking_id = p_booking;
  if v_id is not null then return v_id; end if;

  select * into v_order from public.payment_orders
   where booking_id = p_booking
     and provider = 'stripe_test' and status = 'succeeded'
   for update;
  if v_order.id is null then
    return null; -- simulation / unfunded / ineligible: NO earning, ever.
  end if;

  select pa.account_id into v_companion_account
  from public.profile_access pa
  where pa.profile_id = v_order.companion_profile_id
    and pa.access_role = 'owner' and pa.consent_status <> 'withdrawn'
  limit 1;
  if v_companion_account is null then return null; end if;

  insert into public.companion_earnings
    (booking_id, payment_order_id, companion_account_id, companion_profile_id,
     member_profile_id, payer_account_id, basis_minor, commission_rate_pct,
     commission_minor, net_minor)
  values
    (p_booking, v_order.id, v_companion_account, v_order.companion_profile_id,
     v_order.member_profile_id, v_order.coordinator_account_id,
     v_order.subtotal_minor - v_order.discount_minor,
     v_order.commission_rate_pct, v_order.commission_minor,
     v_order.subtotal_minor - v_order.discount_minor - v_order.commission_minor)
  on conflict (booking_id) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.companion_earnings where booking_id = p_booking;
  end if;
  return v_id;
end;
$$;
revoke all on function app_private.ensure_companion_earning(uuid) from public, anon, authenticated;

-- Make payable exactly once (never from held_for_issue).
create or replace function app_private.make_earning_payable(p_earning uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_e public.companion_earnings;
begin
  select * into v_e from public.companion_earnings where id = p_earning for update;
  if v_e.id is null or v_e.state <> 'pending_completion' then return; end if;
  update public.companion_earnings
     set state = 'payable', payable_at = coalesce(payable_at, now()), updated_at = now()
   where id = p_earning;
  perform app_private.notify_account(
    v_e.companion_account_id, 'earning_payable', 'Earnings ready for payout',
    'A completed conversation is now ready for your next payout.',
    v_e.booking_id, 'earning_payable:' || v_e.id::text);
end;
$$;
revoke all on function app_private.make_earning_payable(uuid) from public, anon, authenticated;

-- ---------- companion attendance ----------
create or replace function public.submit_companion_attendance(
  p_booking uuid, p_outcome text, p_explanation text
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_b public.bookings;
  v_earning uuid;
  v_review public.conversation_reviews;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  select * into v_b from public.bookings where id = p_booking;
  if v_b.id is null or not exists (
    select 1 from public.profile_access pa
    where pa.profile_id = v_b.companion_profile_id and pa.account_id = auth.uid()
      and pa.access_role = 'owner' and pa.consent_status <> 'withdrawn'
  ) then
    raise exception 'not_found: conversation';
  end if;
  if v_b.ends_at > now() then
    raise exception 'too_early: the conversation has not finished yet';
  end if;
  if p_outcome not in ('took_place', 'member_no_show', 'technical_problem', 'other') then
    raise exception 'invalid_outcome: unknown attendance outcome';
  end if;
  if p_outcome <> 'took_place' and (p_explanation is null or trim(p_explanation) = '') then
    raise exception 'explanation_required: please describe what happened';
  end if;

  v_earning := app_private.ensure_companion_earning(p_booking);
  if v_earning is null then
    raise exception 'not_eligible: this conversation has no real payment to release';
  end if;

  -- Idempotent: an identical resubmission is a no-op; contradictions fail.
  if exists (select 1 from public.conversation_attendance where booking_id = p_booking) then
    if exists (select 1 from public.conversation_attendance
               where booking_id = p_booking and outcome = p_outcome and source = 'companion') then
      return jsonb_build_object('ok', true, 'repeat', true);
    end if;
    raise exception 'already_submitted: attendance has already been recorded';
  end if;

  insert into public.conversation_attendance
    (booking_id, outcome, source, submitted_by, explanation)
  values (p_booking, p_outcome, 'companion', auth.uid(), nullif(trim(coalesce(p_explanation, '')), ''));

  if p_outcome = 'took_place' then
    select * into v_review from public.conversation_reviews where booking_id = p_booking;
    if (v_review.id is not null and v_review.approved)
       or (v_b.ends_at + interval '12 hours' <= now()
           and not exists (select 1 from public.conversation_issues
                           where booking_id = p_booking and state <> 'resolved')) then
      perform app_private.make_earning_payable(v_earning);
    end if;
  elsif p_outcome = 'member_no_show' then
    -- Held pending trusted evidence (2G4B) — never paid on assertion alone.
    update public.companion_earnings set state = 'held_for_issue', updated_at = now()
     where id = v_earning and state = 'pending_completion';
    insert into public.conversation_issues
      (booking_id, earning_id, reporter_account_id, reporter_role, category,
       description, idempotency_key)
    values (p_booking, v_earning, auth.uid(), 'companion', 'member_no_show',
            trim(p_explanation), 'att-issue-' || p_booking::text)
    on conflict (idempotency_key) do nothing;
  else
    update public.companion_earnings set state = 'held_for_issue', updated_at = now()
     where id = v_earning and state = 'pending_completion';
    insert into public.conversation_issues
      (booking_id, earning_id, reporter_account_id, reporter_role, category,
       description, idempotency_key)
    values (p_booking, v_earning, auth.uid(), 'companion',
            case when p_outcome = 'technical_problem' then 'technical_problem' else 'other' end,
            trim(p_explanation), 'att-issue-' || p_booking::text)
    on conflict (idempotency_key) do nothing;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.submit_companion_attendance(uuid, text, text) from public, anon;
grant execute on function public.submit_companion_attendance(uuid, text, text) to authenticated;

-- ---------- coordinator review ----------
create or replace function public.submit_conversation_review(
  p_booking uuid, p_rating smallint, p_feedback text, p_message_idempotency text
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_b public.bookings;
  v_earning uuid;
  v_existing public.conversation_reviews;
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  select * into v_b from public.bookings where id = p_booking;
  if v_b.id is null or not exists (
    select 1 from public.profile_access pa
    where pa.profile_id = v_b.member_profile_id and pa.account_id = auth.uid()
      and pa.consent_status <> 'withdrawn'
  ) then
    raise exception 'not_found: conversation';
  end if;
  if v_b.ends_at > now() then
    raise exception 'too_early: the conversation has not finished yet';
  end if;
  if p_rating is not null and (p_rating < 1 or p_rating > 5) then
    raise exception 'invalid_rating: stars must be between 1 and 5';
  end if;
  if p_feedback is not null and char_length(p_feedback) > 2000 then
    raise exception 'feedback_too_long: keep feedback under 2000 characters';
  end if;

  v_earning := app_private.ensure_companion_earning(p_booking);
  if v_earning is null then
    raise exception 'not_eligible: this conversation has no real payment to review';
  end if;

  select * into v_existing from public.conversation_reviews where booking_id = p_booking;
  if v_existing.id is not null then
    -- Edits: same author, 24-hour window; NEVER touches money.
    if v_existing.coordinator_account_id <> auth.uid() then
      raise exception 'not_found: conversation';
    end if;
    if v_existing.created_at + interval '24 hours' < now() then
      raise exception 'edit_window_closed: reviews can be edited for 24 hours';
    end if;
    update public.conversation_reviews
       set rating = p_rating, private_feedback = p_feedback, edited_at = now()
     where id = v_existing.id;
    return jsonb_build_object('ok', true, 'edited', true);
  end if;

  insert into public.conversation_reviews
    (booking_id, coordinator_account_id, member_profile_id, companion_profile_id,
     rating, private_feedback, approved, message_idempotency)
  values (p_booking, auth.uid(), v_b.member_profile_id, v_b.companion_profile_id,
          p_rating, p_feedback, true, p_message_idempotency);

  -- Approval releases the earning ONLY if the companion confirmed and no
  -- issue is open (held_for_issue never auto-releases).
  if exists (select 1 from public.conversation_attendance
             where booking_id = p_booking and outcome = 'took_place')
     and not exists (select 1 from public.conversation_issues
                     where booking_id = p_booking and state <> 'resolved') then
    perform app_private.make_earning_payable(v_earning);
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.submit_conversation_review(uuid, smallint, text, text) from public, anon;
grant execute on function public.submit_conversation_review(uuid, smallint, text, text) to authenticated;

-- ---------- issue reporting ----------
create or replace function public.report_conversation_issue(
  p_booking uuid, p_category text, p_description text
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_b public.bookings;
  v_role text;
  v_earning uuid;
  v_priority text := 'normal';
begin
  if auth.uid() is null then raise exception 'unauthorised: sign in required'; end if;
  select * into v_b from public.bookings where id = p_booking;
  if v_b.id is null then raise exception 'not_found: conversation'; end if;
  if exists (select 1 from public.profile_access pa
             where pa.profile_id = v_b.companion_profile_id and pa.account_id = auth.uid()
               and pa.access_role = 'owner') then
    v_role := 'companion';
    if p_category not in ('member_no_show', 'technical_problem', 'other') then
      raise exception 'invalid_category: not available for companions';
    end if;
  elsif exists (select 1 from public.profile_access pa
                where pa.profile_id = v_b.member_profile_id and pa.account_id = auth.uid()
                  and pa.consent_status <> 'withdrawn') then
    v_role := 'coordinator';
    if p_category not in ('companion_no_show', 'member_no_show', 'audio_video_problem',
                          'platform_technical_problem', 'ended_early', 'incorrect_duration',
                          'inappropriate_or_concerning_behaviour', 'other') then
      raise exception 'invalid_category: not available for coordinators';
    end if;
  else
    raise exception 'not_found: conversation';
  end if;
  if p_description is null or trim(p_description) = '' or char_length(p_description) > 4000 then
    raise exception 'description_required: please describe the issue';
  end if;
  -- Safety reports are allowed during the call; everything else post-end.
  if p_category <> 'inappropriate_or_concerning_behaviour' and v_b.ends_at > now() then
    raise exception 'too_early: report issues after the conversation ends';
  end if;
  if p_category = 'inappropriate_or_concerning_behaviour' then v_priority := 'high'; end if;

  v_earning := app_private.ensure_companion_earning(p_booking);
  if v_earning is null then
    raise exception 'not_eligible: this conversation has no payment to review';
  end if;

  update public.companion_earnings set state = 'held_for_issue', updated_at = now()
   where id = v_earning and state in ('pending_completion');

  insert into public.conversation_issues
    (booking_id, earning_id, reporter_account_id, reporter_role, category,
     description, priority, idempotency_key)
  values (p_booking, v_earning, auth.uid(), v_role, p_category,
          trim(p_description), v_priority,
          'issue-' || p_booking::text || '-' || auth.uid()::text)
  on conflict (idempotency_key) do nothing;

  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.report_conversation_issue(uuid, text, text) from public, anon;
grant execute on function public.report_conversation_issue(uuid, text, text) to authenticated;

-- ---------- 12-hour automatic release (service role / cron) ----------
create or replace function public.release_eligible_earnings()
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count integer := 0;
begin
  for v_row in
    select e.id
    from public.companion_earnings e
    join public.bookings b on b.id = e.booking_id
    join public.conversation_attendance a
      on a.booking_id = e.booking_id and a.outcome = 'took_place'
    where e.state = 'pending_completion'
      and b.ends_at + interval '12 hours' <= now()
      and not exists (select 1 from public.conversation_issues i
                      where i.booking_id = e.booking_id and i.state <> 'resolved')
    limit 100
    for update of e skip locked
  loop
    perform app_private.make_earning_payable(v_row.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.release_eligible_earnings() from public, anon, authenticated;
grant execute on function public.release_eligible_earnings() to service_role;

-- ---------- 24-hour unconfirmed-attendance fallback (service role) ----------
create or replace function public.resolve_unconfirmed_attendance()
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_comp integer;
  v_mem integer;
  v_earning uuid;
  v_count integer := 0;
begin
  for v_row in
    select b.id as booking_id, b.ends_at
    from public.bookings b
    join public.payment_orders po
      on po.booking_id = b.id and po.provider = 'stripe_test' and po.status = 'succeeded'
    where b.ends_at + interval '24 hours' <= now()
      and b.status = 'confirmed'
      and not exists (select 1 from public.conversation_attendance a where a.booking_id = b.id)
      and not exists (select 1 from public.conversation_issues i
                      where i.booking_id = b.id and i.state <> 'resolved')
    limit 100
    for update of b skip locked
  loop
    v_earning := app_private.ensure_companion_earning(v_row.booking_id);
    if v_earning is null then continue; end if;
    select coalesce(sum(duration_seconds), 0) into v_comp
      from public.call_attendance_segments
      where booking_id = v_row.booking_id and side = 'companion';
    select coalesce(sum(duration_seconds), 0) into v_mem
      from public.call_attendance_segments
      where booking_id = v_row.booking_id and side = 'member';

    if v_comp >= 120 and v_mem >= 120 then
      -- System-derived apparent completion → ordinary release rules
      -- (end+24h always satisfies the 12-hour half of the rule).
      insert into public.conversation_attendance
        (booking_id, outcome, source, explanation)
      values (v_row.booking_id, 'took_place', 'system', 'Apparent completion from trusted attendance')
      on conflict (booking_id) do nothing;
      perform app_private.make_earning_payable(v_earning);
    elsif v_comp >= 600 and v_mem < 120 then
      insert into public.conversation_attendance
        (booking_id, outcome, source, explanation)
      values (v_row.booking_id, 'member_no_show', 'system', 'Likely Member no-show from trusted attendance')
      on conflict (booking_id) do nothing;
      perform app_private.make_earning_payable(v_earning);
    else
      update public.companion_earnings set state = 'held_for_issue', updated_at = now()
       where id = v_earning and state = 'pending_completion';
      insert into public.conversation_issues
        (booking_id, earning_id, reporter_account_id, reporter_role, category,
         description, idempotency_key)
      select v_row.booking_id, v_earning, e.companion_account_id, 'system', 'unclear_attendance',
             'Attendance evidence unclear — manual review required',
             'unclear-' || v_row.booking_id::text
      from public.companion_earnings e where e.id = v_earning
      on conflict (idempotency_key) do nothing;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.resolve_unconfirmed_attendance() from public, anon, authenticated;
grant execute on function public.resolve_unconfirmed_attendance() to service_role;

-- ---------- support resolution (atomic, exactly once) ----------
create or replace function public.resolve_conversation_issue(
  p_issue uuid, p_outcome text, p_note text,
  p_companion_minor integer, p_credit_minor integer, p_idempotency text
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_issue public.conversation_issues;
  v_e public.companion_earnings;
  v_order public.payment_orders;
begin
  if not app_private.is_support_admin() then
    raise exception 'not_found: issue';
  end if;
  if exists (select 1 from public.issue_resolutions where idempotency_key = p_idempotency) then
    return jsonb_build_object('ok', true, 'repeat', true);
  end if;
  select * into v_issue from public.conversation_issues where id = p_issue for update;
  if v_issue.id is null then raise exception 'not_found: issue'; end if;
  if v_issue.state = 'resolved' then
    return jsonb_build_object('ok', true, 'repeat', true);
  end if;
  if p_note is null or trim(p_note) = '' then
    raise exception 'note_required: add a resolution note';
  end if;
  select * into v_e from public.companion_earnings where id = v_issue.earning_id for update;
  select * into v_order from public.payment_orders where id = v_e.payment_order_id;

  if p_outcome = 'companion_payable_full' then
    p_companion_minor := v_e.net_minor; p_credit_minor := 0;
  elsif p_outcome = 'customer_credit_full' then
    p_companion_minor := 0; p_credit_minor := v_order.total_minor; -- incl. service fee
  elsif p_outcome = 'issue_dismissed_release' then
    p_companion_minor := v_e.net_minor; p_credit_minor := 0;
  elsif p_outcome = 'partial_resolution' then
    if p_companion_minor is null or p_credit_minor is null
       or p_companion_minor < 0 or p_credit_minor < 0
       or p_companion_minor > v_e.net_minor
       or p_credit_minor > v_order.total_minor
       or (p_companion_minor + p_credit_minor) > v_order.total_minor then
      raise exception 'invalid_amounts: partial resolution exceeds the payment';
    end if;
  else
    raise exception 'invalid_outcome: unknown resolution outcome';
  end if;

  if p_credit_minor > 0 then
    perform public.issue_account_credit(
      v_e.payer_account_id, p_credit_minor, 'refund_resolution', v_issue.id,
      'Issue resolution credit', 'resolution-credit-' || v_issue.id::text);
  end if;

  update public.companion_earnings
     set state = case when p_companion_minor > 0 then 'payable' else 'reversed' end,
         net_minor = case when p_outcome = 'partial_resolution' then p_companion_minor else net_minor end,
         payable_at = case when p_companion_minor > 0 then coalesce(payable_at, now()) else payable_at end,
         updated_at = now()
   where id = v_e.id;

  insert into public.issue_resolutions
    (issue_id, earning_id, resolver_account_id, outcome, note,
     companion_amount_minor, credit_amount_minor, idempotency_key)
  values (v_issue.id, v_e.id, auth.uid(), p_outcome, trim(p_note),
          p_companion_minor, p_credit_minor, p_idempotency);

  update public.conversation_issues
     set state = 'resolved', resolved_at = now(), updated_at = now()
   where id = v_issue.id;

  perform app_private.notify_account(
    v_issue.reporter_account_id, 'issue_resolved', 'Issue resolved',
    'Your reported issue has been reviewed and resolved.',
    v_issue.booking_id, 'issue_resolved:' || v_issue.id::text);
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.resolve_conversation_issue(uuid, text, text, integer, integer, text)
  from public, anon;
grant execute on function public.resolve_conversation_issue(uuid, text, text, integer, integer, text)
  to authenticated; -- internally gated by is_support_admin()

-- Legacy: the two-sided confirmation write path is superseded for REAL
-- funded bookings by this flow; historical rows and mock mode untouched.
