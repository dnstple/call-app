-- ============================================================
-- Conversation Companionship Platform — initial schema (Stage 2A)
--
-- Mirrors the typed domain models in src/types.ts. Run in the
-- Supabase SQL editor or via `supabase db push`.
--
-- Row Level Security is ENABLED on every table with no permissive
-- policies for authenticated users yet: real policies arrive with
-- authentication in Stage 3. Two read-only policies are included so
-- the Stage 2A foundation (anon key) can verify connectivity.
-- ============================================================

-- ---------- Enums ----------
create type user_role as enum ('member', 'companion', 'coordinator');
create type verification_state as enum ('not_verified', 'pending', 'verified_demo', 'verified');
create type conversation_style as enum ('relaxed', 'energetic', 'reflective');
create type call_medium as enum ('phone', 'whatsapp', 'facetime', 'zoom', 'meet', 'other');
create type offer_kind as enum ('trial', 'single', 'package');
create type offer_cadence as enum ('once', 'weekly', 'fortnightly', 'monthly');
create type booking_status as enum (
  'draft', 'requested', 'confirmed', 'in_progress', 'awaiting_completion',
  'completed', 'missed', 'cancelled', 'needs_review'
);
create type completion_outcome as enum ('completed', 'did_not_happen', 'concern');
create type consent_status as enum ('recorded', 'pending');
create type purchase_status as enum ('active', 'exhausted', 'expired');
create type report_status as enum ('open', 'reviewing', 'resolved');

-- ---------- Platform configuration ----------
-- Commission and product rules are data, never hard-coded.
create table platform_config (
  id smallint primary key default 1 check (id = 1),
  standard_commission_pct numeric(5,2) not null default 2.00,
  trial_commission_pct numeric(5,2) not null default 0.00,
  recommended_trial_pence integer not null default 500,
  trial_duration_mins integer not null default 30,
  completion_reminder_hours integer not null default 24,
  currency text not null default 'GBP',
  updated_at timestamptz not null default now()
);

insert into platform_config default values;

-- ---------- Profiles ----------
-- Stage 3 note: id will reference auth.users(id) once authentication exists.
create table profiles (
  id uuid primary key default gen_random_uuid(),
  role user_role not null,
  first_name text not null,
  last_name text not null default '',
  email text not null default '',
  phone text not null default '',
  age_band text not null default '',
  region text not null default '',
  headline text not null default '',
  bio text not null default '',
  interests text[] not null default '{}',
  languages text[] not null default '{English}',
  style conversation_style not null default 'relaxed',
  mediums call_medium[] not null default '{phone}',
  avatar_color text not null default '#c8643d',
  photo_url text,
  verification verification_state not null default 'not_verified',
  accessibility_needs text,
  preferred_times text,
  boundaries text,
  response_rate_pct integer,
  completion_reliability_pct integer,
  joined_at timestamptz not null default now()
);

-- ---------- Coordinator ↔ Member relationships ----------
create table managed_relationships (
  id uuid primary key default gen_random_uuid(),
  coordinator_id uuid not null references profiles(id) on delete cascade,
  member_id uuid not null references profiles(id) on delete cascade,
  relationship text not null,
  consent_status consent_status not null default 'pending',
  can_book boolean not null default true,
  created_at timestamptz not null default now(),
  unique (coordinator_id, member_id)
);

-- ---------- Availability ----------
create table availability_rules (
  id uuid primary key default gen_random_uuid(),
  companion_id uuid not null references profiles(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_hour smallint not null check (start_hour between 0 and 23),
  end_hour smallint not null check (end_hour between 1 and 24 and end_hour > start_hour),
  time_zone text not null default 'Europe/London',
  min_notice_hours integer not null default 24,
  booking_horizon_days integer not null default 21
);

create table availability_exceptions (
  id uuid primary key default gen_random_uuid(),
  companion_id uuid not null references profiles(id) on delete cascade,
  date date not null,
  available boolean not null default false,
  reason text
);

-- ---------- Offers ----------
create table package_offers (
  id uuid primary key default gen_random_uuid(),
  companion_id uuid not null references profiles(id) on delete cascade,
  kind offer_kind not null,
  title text not null,
  duration_mins integer not null,
  call_count integer not null default 1,
  cadence offer_cadence not null default 'once',
  validity_days integer not null default 30,
  price_pence integer not null check (price_pence >= 0),
  active boolean not null default true
);

-- ---------- Purchases ----------
-- Credit rule: calls_used increments only when a booking completes.
create table package_purchases (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references profiles(id),
  member_id uuid not null references profiles(id),
  companion_id uuid not null references profiles(id),
  offer_id uuid not null references package_offers(id),
  calls_total integer not null,
  calls_used integer not null default 0 check (calls_used <= calls_total),
  purchased_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status purchase_status not null default 'active',
  transaction_ref text not null default ''
);

-- ---------- Bookings ----------
create table bookings (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references profiles(id),
  companion_id uuid not null references profiles(id),
  coordinator_id uuid references profiles(id),
  offer_id uuid references package_offers(id),
  offer_kind offer_kind not null,
  package_purchase_id uuid references package_purchases(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  time_zone text not null default 'Europe/London',
  medium call_medium not null default 'phone',
  duration_mins integer not null,
  price_pence integer not null default 0,
  is_trial boolean not null default false,
  status booking_status not null default 'requested',
  proposed_start_at timestamptz,
  cancelled_by uuid references profiles(id),
  cancel_reason text,
  history jsonb not null default '[]',
  created_at timestamptz not null default now(),
  check (end_at > start_at)
);

-- Server-side double-booking guard (Stage 2B enforces via this constraint).
create extension if not exists btree_gist;
alter table bookings add constraint bookings_no_overlap
  exclude using gist (
    companion_id with =,
    tstzrange(start_at, end_at) with &&
  ) where (status in ('requested', 'confirmed', 'in_progress'));

-- One trial per Member–Companion pairing (cancelled trials do not consume it).
create unique index one_trial_per_pairing
  on bookings (member_id, companion_id)
  where (is_trial and status <> 'cancelled');

-- ---------- Completion confirmations ----------
create table completion_confirmations (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  user_id uuid not null references profiles(id),
  outcome completion_outcome not null,
  note text,
  confirmed_at timestamptz not null default now(),
  unique (booking_id, user_id)
);

-- ---------- Ratings ----------
-- "One person equals one rating": at most one ACTIVE rating per
-- reviewer–reviewee pair, enforced at the database level.
create table ratings (
  id uuid primary key default gen_random_uuid(),
  reviewer_id uuid not null references profiles(id),
  reviewee_id uuid not null references profiles(id),
  booking_id uuid references bookings(id),
  stars smallint not null check (stars between 1 and 5),
  public_comment text,
  private_feedback text,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create unique index one_active_rating_per_pair
  on ratings (reviewer_id, reviewee_id)
  where (active);

-- ---------- Notifications ----------
create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  type text not null,
  title text not null,
  body text not null default '',
  related_booking_id uuid references bookings(id),
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index notifications_user_created on notifications (user_id, created_at desc);

-- ---------- Reports ----------
create table reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references profiles(id),
  reported_user_id uuid not null references profiles(id),
  booking_id uuid references bookings(id),
  category text not null,
  details text not null default '',
  status report_status not null default 'open',
  created_at timestamptz not null default now()
);

-- ---------- Transactions (simulated until Stage 4) ----------
create table transactions (
  id uuid primary key default gen_random_uuid(),
  kind offer_kind not null,
  booking_id uuid references bookings(id),
  package_purchase_id uuid references package_purchases(id),
  payer_id uuid not null references profiles(id),
  companion_id uuid not null references profiles(id),
  gross_pence integer not null,
  platform_fee_pence integer not null,
  net_pence integer not null,
  simulated boolean not null default true,
  created_at timestamptz not null default now()
);

-- ============================================================
-- Row Level Security
-- Enabled everywhere. Real per-role policies arrive with auth (Stage 3);
-- until then only the two read-only policies below are exposed so the
-- Stage 2A foundation can verify connectivity with the anon key.
-- ============================================================
alter table platform_config enable row level security;
alter table profiles enable row level security;
alter table managed_relationships enable row level security;
alter table availability_rules enable row level security;
alter table availability_exceptions enable row level security;
alter table package_offers enable row level security;
alter table package_purchases enable row level security;
alter table bookings enable row level security;
alter table completion_confirmations enable row level security;
alter table ratings enable row level security;
alter table notifications enable row level security;
alter table reports enable row level security;
alter table transactions enable row level security;

-- Stage 2A connectivity policies (safe: config values and fictional dev profiles only).
create policy "platform config is readable" on platform_config for select using (true);
create policy "profiles are readable (dev foundation)" on profiles for select using (true);

-- Stage 3 examples (do not enable yet):
-- create policy "own notifications" on notifications
--   for select using (auth.uid() = user_id);
-- create policy "booking participants can read" on bookings
--   for select using (auth.uid() in (member_id, companion_id, coordinator_id));
