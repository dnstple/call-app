-- 0138 — Transactional email delivery ledger (Resend).
--
-- Records every transactional email Apricoti attempts, its provider message id,
-- a deterministic idempotency key (unique), and lifecycle status driven by the
-- Resend delivery webhook. In-app notifications (public.notifications) are a
-- SEPARATE, unchanged channel — this table only tracks EMAIL.
--
-- Security model:
--   * RLS ON. A user may READ only their own rows (recipient_user_id = auth.uid())
--     if the app ever surfaces email history. No client INSERT/UPDATE/DELETE at
--     all — only the service role (Edge Functions) writes, bypassing RLS.
--   * Idempotency is enforced in the database (unique idempotency_key) AND passed
--     to Resend, so retries / repeated webhooks / refreshes never double-send.

set search_path = '';

create table if not exists public.email_notifications (
  id uuid primary key default gen_random_uuid(),
  notification_type   text not null,
  recipient_user_id   uuid not null references public.accounts(id) on delete cascade,
  recipient_email     text not null,
  related_entity_type text,
  related_entity_id   uuid,
  provider            text not null default 'resend',
  provider_message_id text,
  idempotency_key     text not null,
  status              text not null default 'pending'
    check (status in ('pending','sending','sent','delivered','failed','bounced','complained','suppressed')),
  attempt_count       integer not null default 0 check (attempt_count >= 0),
  last_error_code     text,
  last_error_message  text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  delivered_at timestamptz,
  failed_at    timestamptz,
  bounced_at   timestamptz,
  complained_at timestamptz
);

-- Idempotency: one row per deterministic key. This is the DB half of the
-- exactly-once guarantee (the Resend Idempotency-Key header is the provider half).
create unique index if not exists email_notifications_idem_key
  on public.email_notifications (idempotency_key);

-- Webhook lookups resolve by provider message id.
create index if not exists email_notifications_provider_msg
  on public.email_notifications (provider_message_id) where provider_message_id is not null;
create index if not exists email_notifications_recipient
  on public.email_notifications (recipient_user_id, created_at desc);

alter table public.email_notifications enable row level security;

-- Read-own only (if surfaced). No client write policies exist ⇒ inserts/updates
-- from anon/authenticated are denied; only the service role writes.
drop policy if exists "email_notifications: read own" on public.email_notifications;
create policy "email_notifications: read own" on public.email_notifications
  for select to authenticated using (recipient_user_id = auth.uid());

-- ------------------------------------------------------------
-- Webhook event ledger — every Resend event id is recorded once so repeated
-- deliveries of the same event are ignored (idempotent webhook processing).
-- ------------------------------------------------------------
create table if not exists public.email_webhook_events (
  event_id    text primary key,
  event_type  text not null,
  message_id  text,
  received_at timestamptz not null default now()
);
alter table public.email_webhook_events enable row level security;   -- no client policies

select pg_notify('pgrst', 'reload schema');
