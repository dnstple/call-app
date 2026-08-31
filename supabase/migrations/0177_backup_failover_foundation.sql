-- ===========================================================================
-- 0177_backup_failover_foundation.sql
--
-- Automatic backup-companion & call-failover — DATA FOUNDATION (schema only; the
-- RPCs, cron and backfill live in 0178). Purpose: reduce the risk of a member's
-- scheduled credit call not going ahead because the primary companion never
-- confirmed. This layers ON TOP of the existing credit-booking lifecycle
-- (0162/0167/0168): a booking stays the SAME row, the member's credit is never
-- re-consumed, and booking.status keeps its meaning
--   'booked'              = primary pending  (PRIMARY_PENDING)
--   'companion_confirmed' = a companion (primary OR assigned backup) has it
--   'admin_fallback' / 'completed' / 'cancelled' unchanged.
--
-- Everything is inert until backup_failover_config.failover_enabled = true, so
-- deploying this migration changes NO behaviour on its own.
-- ===========================================================================

set search_path = '';

-- ------------------------------------------------------------------ bookings +
-- Failover sub-state is orthogonal to booking.status (which we do NOT overload).
alter table public.bookings
  add column if not exists backup_state              text,
  add column if not exists backup_search_started_at  timestamptz,
  add column if not exists cover_required_at          timestamptz,
  add column if not exists reassigned_at              timestamptz,
  add column if not exists original_companion_profile_id uuid references public.profiles(id) on delete set null;

alter table public.bookings drop constraint if exists bookings_backup_state_check;
alter table public.bookings add constraint bookings_backup_state_check
  check (backup_state is null
         or backup_state in ('searching', 'available', 'reassigning', 'cover_required'));

-- Fast lookup of credit calls the failover scheduler must consider: upcoming,
-- unconfirmed, credit bookings. Partial index keeps it tiny.
create index if not exists bookings_failover_due_idx
  on public.bookings (starts_at)
  where offer_id is null and status = 'booked';

-- ------------------------------------------------------------ backup_offers ---
create table if not exists public.backup_offers (
  id                    uuid primary key default gen_random_uuid(),
  booking_id            uuid not null references public.bookings(id) on delete cascade,
  companion_profile_id  uuid not null references public.profiles(id) on delete cascade,
  -- Owner account of the companion profile — cached for SMS destination / notify.
  companion_account_id  uuid references public.accounts(id) on delete set null,
  status                text not null default 'offered'
                          check (status in ('offered','available','declined','expired','selected','released')),
  -- Assigned when the companion becomes 'available' — reflects response order.
  priority              integer,
  -- 'initial' standby batch (T-4h) vs 'emergency' cover batch (T-2h, no backup).
  batch                 text not null default 'initial'
                          check (batch in ('initial','emergency')),
  -- Unguessable single-purpose token embedded in the SMS link (no login needed).
  response_token        uuid not null default gen_random_uuid(),
  offered_at            timestamptz not null default now(),
  responded_at          timestamptz,
  expires_at            timestamptz,
  -- Twilio transport metadata (Twilio is NEVER the source of truth for the call).
  twilio_message_sid    text,
  twilio_status         text,   -- queued/sent/delivered/failed/undelivered
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- One LIVE offer per (booking, companion): prevents duplicate offers across
-- re-runs of the scheduler / backfill (idempotency). Terminal rows
-- (declined/expired/released) don't block a future re-offer.
create unique index if not exists backup_offers_live_uq
  on public.backup_offers (booking_id, companion_profile_id)
  where status in ('offered','available','selected');

create index if not exists backup_offers_booking_idx on public.backup_offers (booking_id);
create index if not exists backup_offers_status_idx  on public.backup_offers (status);
create index if not exists backup_offers_companion_idx on public.backup_offers (companion_account_id);

-- updated_at touch trigger (reuse the app's convention if present, else inline).
create or replace function app_private.touch_backup_offer()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists backup_offers_touch on public.backup_offers;
create trigger backup_offers_touch before update on public.backup_offers
  for each row execute function app_private.touch_backup_offer();

alter table public.backup_offers enable row level security;
-- A companion may READ their own offers (for the in-app "cover opportunity" UI).
-- All WRITES go through SECURITY DEFINER RPCs (0178) or the service role.
drop policy if exists "backup_offers: read own" on public.backup_offers;
create policy "backup_offers: read own" on public.backup_offers
  for select to authenticated
  using (companion_account_id = auth.uid());

-- --------------------------------------------------- backup_failover_config ---
-- Singleton config: feature flags + the four tuning constants. Defaults OFF so
-- the first deploy is inert and can't SMS anyone until an admin enables it.
create table if not exists public.backup_failover_config (
  id                                boolean primary key default true check (id),
  failover_enabled                  boolean not null default false,
  sms_enabled                       boolean not null default false,
  primary_acceptance_deadline_mins  integer not null default 120,  -- T-2h
  backup_search_start_mins          integer not null default 240,  -- T-4h
  initial_batch_size                integer not null default 4,
  emergency_batch_size              integer not null default 8,
  updated_at                        timestamptz not null default now()
);
insert into public.backup_failover_config (id) values (true) on conflict (id) do nothing;

alter table public.backup_failover_config enable row level security;
-- No direct client access; read/written via SECURITY DEFINER RPCs (0178).

-- ------------------------------------------------ backup_failover_events -----
-- Audit trail so admins can explain to a member why their companion changed.
create table if not exists public.backup_failover_events (
  id            bigint generated always as identity primary key,
  booking_id    uuid not null references public.bookings(id) on delete cascade,
  event         text not null,   -- PRIMARY_REQUESTED, BACKUP_SEARCH_STARTED, ...
  actor_account_id uuid references public.accounts(id) on delete set null,
  companion_profile_id uuid references public.profiles(id) on delete set null,
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists backup_failover_events_booking_idx
  on public.backup_failover_events (booking_id, created_at);

alter table public.backup_failover_events enable row level security;
-- Support admins may read the trail; writes are via SECURITY DEFINER RPCs.
drop policy if exists "failover events: support read" on public.backup_failover_events;
create policy "failover events: support read" on public.backup_failover_events
  for select to authenticated
  using (app_private.is_support_admin());

-- ---------------------------------------------- failover_sms_outbox ----------
-- Decouples state transitions (DB, source of truth, run by pg_cron) from Twilio
-- delivery (the edge function). The tick writes an outbox row; the transport
-- worker sends it and records the SID/status. Twilio is NEVER the source of
-- truth for whether a call was reassigned. Unique key makes writes idempotent so
-- a double scheduler run can't queue a duplicate SMS.
create table if not exists public.failover_sms_outbox (
  id                   bigint generated always as identity primary key,
  booking_id           uuid not null references public.bookings(id) on delete cascade,
  recipient_account_id uuid not null references public.accounts(id) on delete cascade,
  kind                 text not null,  -- member_reassigned / backup_assigned / primary_replaced / emergency_admin
  body                 text not null,
  status               text not null default 'pending'
                         check (status in ('pending','sent','failed','skipped')),
  twilio_message_sid   text,
  twilio_status        text,
  dedupe_key           text not null,
  created_at           timestamptz not null default now(),
  sent_at              timestamptz
);
create unique index if not exists failover_sms_outbox_dedupe_uq
  on public.failover_sms_outbox (dedupe_key);
create index if not exists failover_sms_outbox_pending_idx
  on public.failover_sms_outbox (status) where status = 'pending';

alter table public.failover_sms_outbox enable row level security;
-- No client access; the transport edge function uses the service role.

select pg_notify('pgrst', 'reload schema');
