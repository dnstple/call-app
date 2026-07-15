-- ============================================================
-- Stage 2E2A — real ratings persistence.
--
-- Product model (preserved from Stage 1): ratings are ONE-WAY — the
-- Member side rates the Companion after a COMPLETED conversation.
-- One active rating per reviewer–reviewee pair ("one person, one
-- rating"): a later completed conversation UPDATES the existing rating,
-- and public averages count unique reviewers, never repeat bookings.
--
-- Private feedback is for the platform team: it is NEVER exposed through
-- the public review surfaces and is readable only by the reviewer side.
-- NO payment, package or notification side effects. No rating UI yet.
--
-- The Stage-1 ratings table (no policies, no data in Supabase mode) is
-- rebuilt to the server-derived model.
-- ============================================================

drop table if exists public.ratings cascade;

create table public.ratings (
  id uuid primary key default gen_random_uuid(),
  reviewer_profile_id uuid not null references public.profiles(id),
  reviewee_profile_id uuid not null references public.profiles(id),
  submitted_by_account_id uuid not null references public.accounts(id),
  source_booking_id uuid not null references public.bookings(id),
  score integer not null check (score between 1 and 5),
  public_comment text check (public_comment is null or char_length(public_comment) <= 1000),
  private_feedback text check (private_feedback is null or char_length(private_feedback) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (reviewer_profile_id <> reviewee_profile_id),
  -- "One person, one rating" — repeat conversations update, never stack.
  unique (reviewer_profile_id, reviewee_profile_id)
);
create index ratings_reviewee_idx on public.ratings (reviewee_profile_id);
create index ratings_source_booking_idx on public.ratings (source_booking_id);

-- Belt-and-braces: even privileged future code paths cannot attach a rating
-- to an uncompleted booking or to non-participants of that booking.
create or replace function app_private.check_rating_source()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare v public.bookings;
begin
  select * into v from public.bookings where id = new.source_booking_id;
  if v.id is null or v.status <> 'completed' then
    raise exception 'booking_not_completed: ratings need a completed conversation';
  end if;
  if new.reviewer_profile_id <> v.member_profile_id
     or new.reviewee_profile_id <> v.companion_profile_id then
    raise exception 'Rating participants must match the booking participants';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger ratings_source_check
  before insert or update on public.ratings
  for each row execute function app_private.check_rating_source();

-- ---------- RLS: reviewer-side reads only; NO direct write path ----------
alter table public.ratings enable row level security;

-- The reviewer side (submitting account, or accounts with access to the
-- reviewer profile) can read their own rating INCLUDING private feedback.
-- The Companion never reads private feedback: their public numbers come
-- from the safe functions below.
create policy "ratings: reviewer side reads own"
  on public.ratings
  for select to authenticated
  using (
    submitted_by_account_id = auth.uid()
    or app_private.has_profile_access(reviewer_profile_id)
  );
-- No insert/update/delete policies: submit_rating is the only write path.

-- ============================================================
-- submit_rating — the ONLY way ratings are written.
-- Reviewer, reviewee and actor are derived from auth.uid() + the booking;
-- the browser cannot supply any participant identifier.
-- ============================================================
create or replace function public.submit_rating(
  p_booking uuid,
  p_score integer,
  p_public_comment text default null,
  p_private_feedback text default null
)
returns public.ratings
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.bookings;
  v_rating public.ratings;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if p_score is null or p_score < 1 or p_score > 5 then
    raise exception 'invalid_score: the score must be between 1 and 5';
  end if;
  if char_length(coalesce(p_public_comment, '')) > 1000
     or char_length(coalesce(p_private_feedback, '')) > 2000 then
    raise exception 'invalid_comment: the comment is too long';
  end if;

  select * into v from public.bookings where id = p_booking for update;
  if v.id is null or not app_private.can_read_booking(p_booking) then
    raise exception 'Booking not found';
  end if;

  -- Product rule: the MEMBER side rates the COMPANION. A companion cannot
  -- rate (two-way ratings are not part of the product), which also makes
  -- self-rating impossible: the reviewee is always the opposite profile.
  if app_private.can_edit_profile(v.companion_profile_id) then
    raise exception 'self_rating: companions receive ratings — they do not rate members';
  end if;
  if not (v.booked_by_account_id = auth.uid()
          or app_private.can_act_for_member(v.member_profile_id)) then
    raise exception 'You cannot rate this conversation';
  end if;

  if v.status = 'confirmed' then
    raise exception 'booking_not_completed: this conversation has not been completed yet — confirm it first';
  end if;
  if v.status <> 'completed' then
    raise exception 'booking_not_completed: only completed conversations can be rated (status is %)', v.status;
  end if;

  -- One rating per reviewer–reviewee pair: a later completed conversation
  -- updates the same row (and re-points it at the latest booking).
  insert into public.ratings (
    reviewer_profile_id, reviewee_profile_id, submitted_by_account_id,
    source_booking_id, score, public_comment, private_feedback
  ) values (
    v.member_profile_id, v.companion_profile_id, auth.uid(),
    v.id, p_score, p_public_comment, p_private_feedback
  )
  on conflict (reviewer_profile_id, reviewee_profile_id) do update
    set score = excluded.score,
        public_comment = excluded.public_comment,
        private_feedback = excluded.private_feedback,
        source_booking_id = excluded.source_booking_id,
        submitted_by_account_id = excluded.submitted_by_account_id,
        updated_at = now()
  returning * into v_rating;

  return v_rating;
end;
$$;

-- ============================================================
-- Public rating surfaces (Stage 2E2B wires them into the UI).
-- Unique-reviewer aggregation is structural: the unique
-- (reviewer, reviewee) constraint means one row per reviewer.
-- ============================================================
create or replace function public.get_companion_rating_summary(p_profile uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not (app_private.is_discoverable_companion(p_profile)
          or app_private.has_profile_access(p_profile)) then
    raise exception 'Profile not found';
  end if;
  return (
    select jsonb_build_object(
      'average', round(avg(r.score)::numeric, 1),
      'reviewer_count', count(*)
    )
    from public.ratings r
    where r.reviewee_profile_id = p_profile
  );
end;
$$;

-- Public written reviews: safe columns only — reviewer first name +
-- initial, score, public comment, date. NEVER private feedback, account
-- ids or booking details.
create or replace function public.get_companion_public_reviews(
  p_profile uuid,
  p_limit integer default 10,
  p_offset integer default 0
)
returns table (
  reviewer_first_name text,
  reviewer_last_initial text,
  score integer,
  public_comment text,
  updated_at timestamptz
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not (app_private.is_discoverable_companion(p_profile)
          or app_private.has_profile_access(p_profile)) then
    raise exception 'Profile not found';
  end if;
  return query
    select p.first_name,
           left(p.last_name, 1),
           r.score,
           r.public_comment,
           r.updated_at
    from public.ratings r
    join public.profiles p on p.id = r.reviewer_profile_id
    where r.reviewee_profile_id = p_profile
      and r.public_comment is not null
    order by r.updated_at desc
    limit least(greatest(coalesce(p_limit, 10), 1), 50)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- ---------- lock the functions down ----------
revoke all on function public.submit_rating(uuid, integer, text, text) from public, anon;
revoke all on function public.get_companion_rating_summary(uuid) from public, anon;
revoke all on function public.get_companion_public_reviews(uuid, integer, integer) from public, anon;
revoke all on function app_private.check_rating_source() from public, anon, authenticated;
grant execute on function public.submit_rating(uuid, integer, text, text) to authenticated;
grant execute on function public.get_companion_rating_summary(uuid) to authenticated;
grant execute on function public.get_companion_public_reviews(uuid, integer, integer) to authenticated;
